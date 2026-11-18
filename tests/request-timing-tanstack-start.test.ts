/**
 * The TanStack Start connector, with the Bun.sql connector under it, through
 * the Start app `request-timing-start-app` holds, built by Vite as the
 * template is built and served by Bun, over a real Postgres. Its routes and
 * server functions run Effect programs through one bridge, which crosses in
 * with `carryOperation`, and reach the database through a `Db` service, which
 * crosses back out with `tryPromiseCarried`.
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

import { check } from "../property.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { parseRecord } from "../request-timing-summary.ts";
import { nameServerFunction, timedStartHandler } from "../request-timing-tanstack-start.ts";
import { requestTiming, type TimingRecord } from "../request-timing.ts";
import { LANES } from "./request-timing-start-app/src/lanes.ts";
import { builtStartFixture } from "./request-timing-start-build.ts";
import { scratchPostgres } from "./request-timing-postgres.ts";
import { startServer } from "./request-timing-start-server.ts";

type Built = Awaited<ReturnType<typeof builtStartFixture>>;
type Database = Awaited<ReturnType<typeof scratchPostgres>>;
type Served = Awaited<ReturnType<typeof startServer>>;

let built: Built;
let databases: Database[];
let on: Served;
let off: { readonly url: URL; readonly child: ReturnType<typeof Bun.spawn> };

/** Serves the build with timing off, in a process of its own on its own database, and answers where. */
async function servedOff(entry: string, database: string) {
  const child = Bun.spawn(["bun", `${import.meta.dir}/request-timing-start-serve.ts`, entry], {
    env: { ...process.env, DATABASE_URL: database, REQUEST_TIMING: "off" },
    stdout: "pipe",
    stderr: "inherit",
  });
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
  built = await builtStartFixture();
  databases = [await scratchPostgres(), await scratchPostgres()];
  const [timedDatabase, bareDatabase] = databases;
  if (timedDatabase === undefined || bareDatabase === undefined) throw new Error("two databases");
  // Read once, by the bundle, as it loads.
  process.env["DATABASE_URL"] = timedDatabase.url;
  on = await startServer(built.server);
  off = await servedOff(built.server, bareDatabase.url);
}, 60_000);

afterAll(async () => {
  off.child.kill();
  await on.server.stop(true);
  for (const database of databases) await database[Symbol.asyncDispose]();
  await built[Symbol.asyncDispose]();
});

const url = (path: string, base: URL = on.server.url) => new URL(path, base);

async function nextRecord(): Promise<TimingRecord> {
  for (;;) {
    const made = parseRecord(await on.app.fixture.nextLine());
    if (made !== undefined) return made;
  }
}

/** The headers Start's own client sends with a server-function call, and the CSRF check asks for. */
const SERVER_FN = { "x-tsr-serverFn": "true", "sec-fetch-site": "same-origin" };

/**
 * A response as a client reads it, less what differs by when it was sent: the
 * `date` header, and the time each route's data was loaded, which a page
 * carries for the browser's router as `u:` and epoch milliseconds.
 */
async function read(response: Response) {
  const headers = [...response.headers].filter(([name]) => name !== "date");
  const body = (await response.text()).replaceAll(/\bu:\d+/gu, "u:<loaded at>");
  return { status: response.status, headers, body };
}

/** The scripted sequence the differential runs against both apps, by path or by server function. */
const script = (): readonly [string, RequestInit][] => [
  ["/", {}],
  ["/presets/1", {}],
  ["/presets/999", {}],
  ["/presets/1", { method: "HEAD" }],
  ["/stream", {}],
  ["/fail", {}],
  ["/nowhere/42?q=private", {}],
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
      answered.off.push(await read(await fetch(url(path, off.url), init)));
      answered.on.push(await read(await fetch(url(path), init)));
    }
    // One record per request the timed app answered, read before anything
    // is compared, so a case that fails leaves none for the next.
    const written = [];
    for (const _ of script()) written.push((await nextRecord()).operation);
    expect(answered.on).toEqual(answered.off);
    expect(written).toEqual([
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
    ]);
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
      expect({ db: made.db.count, store: made.store.count, out: made.out.count }).toEqual({
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
    on.app.fixture.held.open();
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
    }));

  test("passes the conformance kit on a server function", () =>
    requestTimingConforms({
      method: "GET",
      operation: "src/fns.ts:listPresetsFn",
      dbWaits: 1,
      drive: async () =>
        void (await (await fetch(url(on.app.fixture.urls.list), { headers: SERVER_FN })).text()),
      next: on.app.fixture.nextLine,
    }));

  test("refuses at startup a route whose pattern the core will not take", () => {
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/a b" })]),
    });
    const timing = requestTiming({ sink: () => undefined });
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
    const timing = requestTiming({ sink: (made) => void records.push(made) });
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
