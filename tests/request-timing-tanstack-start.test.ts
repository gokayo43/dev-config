/**
 * The TanStack Start connector, with the Bun.sql connector under it, through
 * the Start app `request-timing-start-app` holds, built by Vite as the
 * template is built and served by Bun, over a real Postgres. Its routes and
 * server functions run Effect programs through one bridge, and reach the
 * database through a `Db` service whose thunk runs drizzle under
 * `Effect.tryPromise`.
 *
 * - Invariant 1, the differential: one scripted sequence of requests against
 *   the build with timing off, in a process of its own, and with it on,
 *   compared response by response. The off run is the oracle.
 * - Invariant 2: each ending the connector rules list that Start can produce,
 *   driven for real, closes into exactly one record with its name, status,
 *   kinds and counts. "Exactly one" is read by a sentinel request after each:
 *   its record has to be the next one written.
 * - Invariant 3 at the seam: a property over overlapping requests, each with a
 *   generated number of waits, every one of them queued on a semaphore of one
 *   permit the case holds until every request has arrived at it, so each is
 *   resumed by the fiber of another request that released it.
 * - The conformance kit, run against the app as an adopting app runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { array, asyncProperty, boolean, integer, record, uniqueArray } from "fast-check";

import { must } from "../narrowing.ts";
import { check } from "../property.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { nameServerFunction, timedStartHandler } from "../request-timing-tanstack-start.ts";
import { requestTiming, type TimingRecord } from "../request-timing.ts";
import { read, recordsFrom } from "./request-timing-fixture.ts";
import { countsOf } from "./request-timing-oracle.ts";
import { LANES } from "./request-timing-start-app/src/lanes.ts";
import { builtStartFixture } from "./request-timing-start-build.ts";
import { scratchPostgres } from "./request-timing-postgres.ts";
import { startServer } from "./request-timing-start-server.ts";

type Built = Awaited<ReturnType<typeof builtStartFixture>>;
type Database = Awaited<ReturnType<typeof scratchPostgres>>;
type Served = Awaited<ReturnType<typeof startServer>>;

/**
 * What `beforeAll` made, each set as it is made, so `afterAll` takes down
 * exactly what exists when setup failed partway.
 */
const setup: {
  built?: Built;
  databases: Database[];
  on?: Served;
  off?: { readonly url: URL; readonly child: ReturnType<typeof Bun.spawn> };
} = { databases: [] };

/** Serves the build with timing off, in a process of its own on its own database, and answers where. */
async function servedOff(entry: string, database: string) {
  const child = Bun.spawn(["bun", `${import.meta.dir}/request-timing-start-serve.ts`, entry], {
    env: { ...process.env, FIXTURE_DATABASE_URL: database, FIXTURE_TIMING: "off" },
    stdout: "pipe",
    stderr: "inherit",
  });
  setup.off = { url: new URL("http://unserved"), child };
  const reader = child.stdout.getReader();
  let written = "";
  while (!written.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("the fixture with timing off exited before it served");
    written += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return { url: new URL(written.trim()), child };
}

beforeAll(async () => {
  setup.built = await builtStartFixture();
  const timedDatabase = await scratchPostgres();
  setup.databases.push(timedDatabase);
  const bareDatabase = await scratchPostgres();
  setup.databases.push(bareDatabase);
  // Read once, by the bundle, as it loads.
  process.env["FIXTURE_DATABASE_URL"] = timedDatabase.url;
  setup.on = await startServer(setup.built.server);
  setup.off = await servedOff(setup.built.server, bareDatabase.url);
});

afterAll(async () => {
  setup.off?.child.kill();
  await setup.on?.server.stop(true);
  for (const database of setup.databases) await database[Symbol.asyncDispose]();
  await setup.built?.[Symbol.asyncDispose]();
});

const on = {
  get app() {
    return must(setup.on).app;
  },
  get server() {
    return must(setup.on).server;
  },
};

const url = (path: string, base: URL = on.server.url) => new URL(path, base);

let reading: ReturnType<typeof recordsFrom> | undefined;

/** The next record the timed app wrote, the faults read past kept for `faults`. */
const nextRecord = (): Promise<TimingRecord> => {
  reading ??= recordsFrom(on.app.fixture.nextLine);
  return reading.next();
};

/** The faults the timed app's `fault` wrote among the lines read so far, taken. */
const faults = (): string[] => reading?.faults() ?? [];

/** The headers Start's own client sends with a server-function call, and the CSRF check asks for. */
const SERVER_FN = { "x-tsr-serverFn": "true", "sec-fetch-site": "same-origin" };

/**
 * A body as a client reads it, less the time each route's data was loaded,
 * which a page carries for the browser's router as `u:` and epoch
 * milliseconds.
 */
const unstamped = async (response: Response) =>
  (await response.text()).replaceAll(/\bu:\d+/gu, "u:<loaded at>");

/** The scripted sequence the differential runs against both apps, by path or by server function. */
const script = (): readonly [string, RequestInit][] => [
  ["/", {}],
  ["/presets/1", {}],
  ["/presets/999", {}],
  ["/presets/1", { method: "HEAD" }],
  ["/stream", {}],
  ["/fail", {}],
  ["/nowhere/42?q=private", {}],
  ["/unwritten", {}],
  ["/errored", {}],
  [on.app.fixture.urls.refused, { headers: SERVER_FN }],
  [on.app.fixture.urls.list, { headers: SERVER_FN }],
  [on.app.fixture.urls.failing, { headers: SERVER_FN }],
  [on.app.fixture.urls.streaming, { headers: SERVER_FN }],
  ["/_serverFn/absent", { headers: SERVER_FN }],
  [on.app.fixture.urls.list, {}],
];

describe("the TanStack Start connector", () => {
  test("changes no response the app gives", async () => {
    const answered = { on: [] as unknown[], off: [] as unknown[] };
    for (const [path, init] of script()) {
      answered.off.push(await read(await fetch(url(path, must(setup.off).url), init), unstamped));
      answered.on.push(await read(await fetch(url(path), init), unstamped));
    }
    // One record per request the timed app answered that wrote one, and one
    // fault for each that did not, read before anything is compared, so a
    // case that fails leaves none for the next.
    const expected = [
      "/",
      "/presets/$id",
      "/presets/$id",
      "/presets/$id",
      "/stream",
      "/fail",
      "unmatched",
      "src/fns.ts:listPresetsFn",
      "src/fns.ts:failingFn",
      "src/fns.ts:streamingFn",
      "unmatched",
      "unmatched",
    ];
    const written = [];
    for (const _ of expected) written.push((await nextRecord()).operation);
    expect(answered.on).toEqual(answered.off);
    expect(written).toEqual(expected);
    expect(faults()).toHaveLength(3);
  });

  /** The record `pending` resolves to, and that it is the only one: the sentinel's comes next. */
  const recordOf = async (pending: Promise<TimingRecord>) => {
    const written = await pending;
    await (await fetch(url("/presets/2"))).text();
    expect((await nextRecord()).operation).toBe("/presets/$id");
    return written;
  };

  const endings: [string, () => string, RequestInit, Partial<TimingRecord>, number][] = [
    [
      "a normal answer from a server route",
      () => "/presets/1",
      {},
      { method: "GET", operation: "/presets/$id", status: 200, aborted: false, streamed: false },
      2,
    ],
    [
      "a server function called over HTTP, by its file and name",
      () => on.app.fixture.urls.list,
      { headers: SERVER_FN },
      { method: "GET", operation: "src/fns.ts:listPresetsFn", status: 200, streamed: false },
      1,
    ],
    [
      "a streamed body, after its last chunk",
      () => "/stream",
      {},
      { operation: "/stream", status: 200, aborted: false, streamed: true },
      1,
    ],
    [
      "a server function's streamed answer, after its last part",
      () => on.app.fixture.urls.streaming,
      { headers: SERVER_FN },
      { operation: "src/fns.ts:streamingFn", status: 200, aborted: false, streamed: true },
      1,
    ],
    [
      "a server route that throws, with the 500 the server answered",
      () => "/fail",
      {},
      { operation: "/fail", status: 500, aborted: false, streamed: false },
      1,
    ],
    [
      "a server function that throws, with the answer Start gave the client",
      () => on.app.fixture.urls.failing,
      { headers: SERVER_FN },
      { operation: "src/fns.ts:failingFn", status: 200, aborted: false },
      1,
    ],
    [
      "an unmatched request",
      () => "/nowhere/42?q=private",
      {},
      { method: "GET", operation: "unmatched", status: 404, streamed: false },
      0,
    ],
    [
      "a server-function call no function answers",
      () => "/_serverFn/absent",
      { headers: SERVER_FN },
      { operation: "unmatched", status: 500 },
      0,
    ],
    [
      "a page rendered on the server, with the server function it calls in-process",
      () => "/",
      {},
      { method: "GET", operation: "/", status: 200, aborted: false, streamed: false },
      3,
    ],
    [
      "a server route that serves another in-process, with both requests' waits",
      () => "/outer",
      {},
      { method: "GET", operation: "/outer", status: 200, aborted: false, streamed: false },
      3,
    ],
    [
      "a HEAD the GET route answers",
      () => "/presets/1",
      { method: "HEAD" },
      { method: "HEAD", operation: "/presets/$id", status: 200 },
      2,
    ],
  ];
  for (const [ending, path, init, expected, db] of endings) {
    test(`closes ${ending} into one record`, async () => {
      const written = nextRecord();
      await (await fetch(url(path()), init)).text();
      const made = await recordOf(written);
      expect(made).toMatchObject(expected);
      expect(countsOf(made)).toEqual({
        db,
        store: 0,
        out: 0,
      });
    });
  }

  test("closes a request whose client left before the response, as 499 and aborted", async () => {
    const written = nextRecord();
    const client = new AbortController();
    const response = fetch(url("/hang"), { signal: client.signal });
    await on.app.fixture.held.reached();
    client.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    const made = await written;
    await on.app.fixture.held.open();
    expect(made).toMatchObject({ operation: "/hang", status: 499, aborted: true, streamed: false });
    expect(made.db.count).toBe(1);
    await recordOf(Promise.resolve(made));
  });

  test("counts each overlapping request's own waits, whoever releases it into the permit", () =>
    check(
      asyncProperty(
        uniqueArray(integer({ min: 0, max: LANES - 1 }), { minLength: 2, maxLength: LANES }),
        array(record({ queries: integer({ min: 0, max: 3 }), transaction: boolean() }), {
          minLength: LANES,
          maxLength: LANES,
        }),
        async (lanes, plans) => {
          const planOf = (lane: number) => plans[lane] ?? { queries: 0, transaction: false };
          // The latch: the permit every lane queues on, held outside any
          // operation until every lane has arrived at it.
          const release = await on.app.fixture.hold();
          const arrived = on.app.fixture.arrived(lanes.length);
          const responses = lanes.map(async (lane) => {
            const { queries, transaction } = planOf(lane);
            const query = `queries=${queries}&transaction=${transaction}`;
            return (await fetch(url(`/lanes/${lane}?${query}`))).text();
          });
          await arrived;
          await release();
          await Promise.all(responses);
          const records = await Promise.all(lanes.map(() => nextRecord()));
          expect(
            Object.fromEntries(records.map((made) => [made.operation, made.db.count])),
          ).toEqual(
            Object.fromEntries(
              lanes.map((lane) => {
                const { queries, transaction } = planOf(lane);
                // A transaction is its opening, its one query and its closing.
                return [`/lanes/${lane}`, queries + (transaction ? 3 : 0)];
              }),
            ),
          );
        },
      ),
      { numRuns: 25 },
    ));

  test("passes the conformance kit on a server route", () =>
    requestTimingConforms({
      method: "GET",
      operation: "/presets/$id",
      dbWaits: 2,
      drive: async () => void (await (await fetch(url("/presets/1"))).text()),
      next: on.app.fixture.nextLine,
      sentinel: { operation: "/", drive: async () => void (await (await fetch(url("/"))).text()) },
    }));

  test("passes the conformance kit on a server function", () =>
    requestTimingConforms({
      method: "GET",
      operation: "src/fns.ts:listPresetsFn",
      dbWaits: 1,
      drive: async () =>
        void (await (await fetch(url(on.app.fixture.urls.list), { headers: SERVER_FN })).text()),
      next: on.app.fixture.nextLine,
      sentinel: { operation: "/", drive: async () => void (await (await fetch(url("/"))).text()) },
    }));

  // What the app's `fault` is handed, and no record: the response served as
  // it would be without timing, and the app still serving.
  const faulted: [string, () => string, RequestInit, number, string][] = [
    ["a sink that throws", () => "/unwritten", {}, 200, "the sink refused the record"],
    ["a status no response is sent with", () => "/errored", {}, 500, "closed with status 0"],
    [
      "a server function's name the core refuses",
      () => on.app.fixture.urls.refused,
      { headers: SERVER_FN },
      200,
      "longer than 256 characters",
    ],
  ];
  for (const [fault, path, init, status, message] of faulted) {
    test(`hands ${fault} to the app's fault, once, and writes no record`, async () => {
      const response = await fetch(url(path()), init);
      await response.text();
      expect(response.status).toBe(status);
      await (await fetch(url("/presets/2"))).text();
      expect((await nextRecord()).operation).toBe("/presets/$id");
      const reported = faults();
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(message);
    });
  }

  test("refuses at startup a server-function path that is not one", () => {
    const root = createRootRoute();
    const timing = requestTiming({ fault: () => undefined, sink: () => undefined });
    for (const serverFnBase of ["/_serverFn", "_serverFn/"]) {
      expect(() =>
        timedStartHandler(
          timing,
          () => new Response(),
          () => createRouter({ routeTree: root }),
          {
            serverFnBase,
          },
        ),
      ).toThrow('beginning and ending with "/"');
    }
  });

  test("refuses at startup a route whose pattern the core will not take", () => {
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/a b" })]),
    });
    const timing = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: () => undefined,
    });
    expect(() =>
      timedStartHandler(
        timing,
        () => new Response(),
        () => router,
      ),
    ).toThrow("a space");
  });

  test("names a server function under the base an app configured, and no call made in-process", async () => {
    const records: TimingRecord[] = [];
    const timing = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (made) => void records.push(made),
    });
    const meta = (id: string) => ({ id, name: `fn${id}`, filename: "src/rpc.ts" });
    // Start's handler, as far as the connector sees it: the function the path
    // names runs its global middleware, after one called in-process has.
    const handler = (request: Request) => {
      const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
      nameServerFunction({ serverFnMeta: meta("other"), next: () => undefined });
      nameServerFunction({ serverFnMeta: meta(id), next: () => undefined });
      return new Response("called");
    };
    const root = createRootRoute();
    const served = timedStartHandler(timing, handler, () => createRouter({ routeTree: root }), {
      serverFnBase: "/rpc/",
    });
    await (await served(new Request("http://app/rpc/7"))).text();
    await (await served(new Request("http://app/_serverFn/7"))).text();
    expect(records.map((made) => made.operation)).toEqual(["src/rpc.ts:fn7", "unmatched"]);
  });
});
