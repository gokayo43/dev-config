/**
 * The Elysia connector, with the mysql2, Bun Redis and `fetch` connectors under
 * it, through a real Elysia app over a real MySQL, a real Redis and a real
 * outside service (`request-timing-elysia-fixture.ts`).
 *
 * - Invariant 1, the differential: one scripted sequence of requests against
 *   the app with timing off and with it on, compared response by response.
 *   The off run is the oracle.
 * - Invariant 2: each ending the connector rules list, driven for real, closes
 *   into exactly one record with its name, status, kinds and counts. "Exactly
 *   one" is read by a sentinel request after each: its record has to be the
 *   next one written.
 * - Invariant 3 at the seam: a property over overlapping requests, each with a
 *   generated number of waits of each kind, all queued on a pool of one
 *   connection the case holds until every request is provably waiting for it,
 *   so each is handed its connection from another request's release.
 * - The conformance kit, run against the app as an adopting app runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { array, asyncProperty, integer, record, uniqueArray } from "fast-check";

import { check } from "../property.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { requestTimingPlugin } from "../request-timing-elysia.ts";
import { requestTiming, type TimingRecord } from "../request-timing.ts";
import { LANES, presetApp } from "./request-timing-elysia-fixture.ts";

type App = Awaited<ReturnType<typeof presetApp>>;

let app: App;
beforeAll(async () => {
  app = await presetApp(true, 1);
});
afterAll(async () => {
  await app[Symbol.asyncDispose]();
});

/** A response as a client reads it, less the one header that differs by the second it was sent. */
async function read(response: Response) {
  const headers = [...response.headers].filter(([name]) => name !== "date");
  return { status: response.status, headers, body: await response.text() };
}

/** The scripted sequence the differential runs against both apps. */
const SCRIPT: readonly [string, RequestInit][] = [
  ["/presets/1", {}],
  ["/presets/999", {}],
  ["/presets/1", { method: "HEAD" }],
  ["/stream", {}],
  ["/events", {}],
  ["/fail", {}],
  ["/broken", {}],
  ["/nowhere", {}],
  [
    "/presets",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"label":"third"}' },
  ],
  [
    "/presets",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"label":"third"}' },
  ],
  [
    "/presets",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
  ],
];

const runScript = async (target: App) => {
  const responses = [];
  for (const [path, init] of SCRIPT)
    responses.push(await read(await fetch(target.url(path), init)));
  return responses;
};

describe("the Elysia connector", () => {
  test("changes no response the app gives", async () => {
    await using off = await presetApp(false);
    await using on = await presetApp(true);
    expect(await runScript(on)).toEqual(await runScript(off));
  });

  /** The record `request` closes into, and that it is the only one: the sentinel's comes next. */
  const recordOf = async (pending: Promise<TimingRecord>) => {
    const written = await pending;
    await (await fetch(app.url("/presets/2"))).text();
    expect((await app.nextRecord()).operation).toBe("/presets/:id");
    return written;
  };

  const endings: [string, string, RequestInit, Partial<TimingRecord>][] = [
    [
      "a normal response",
      "/presets/1",
      {},
      { method: "GET", operation: "/presets/:id", status: 200, aborted: false, streamed: false },
    ],
    [
      "a streamed response, after its last chunk",
      "/stream",
      {},
      { method: "GET", operation: "/stream", status: 200, aborted: false, streamed: true },
    ],
    [
      "server-sent events",
      "/events",
      {},
      { method: "GET", operation: "/events", status: 200, aborted: false, streamed: true },
    ],
    [
      "a handler that throws, with the status the app's error handler answered",
      "/fail",
      {},
      { method: "GET", operation: "/fail", status: 503, aborted: false, streamed: false },
    ],
    [
      "an error handler that throws, with the 500 the server answered",
      "/broken",
      {},
      { method: "GET", operation: "/broken", status: 500, aborted: false, streamed: false },
    ],
    [
      "an unmatched request",
      "/nowhere/42?q=private",
      {},
      { method: "GET", operation: "unmatched", status: 404, aborted: false, streamed: false },
    ],
    [
      "a HEAD the GET route answers",
      "/presets/1",
      { method: "HEAD" },
      { method: "HEAD", operation: "/presets/:id", status: 200 },
    ],
    [
      "a body the route cannot parse, which fails before the route is known",
      "/presets",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
      { method: "POST", operation: "unmatched", status: 400 },
    ],
  ];
  const kinds: Record<string, Partial<Record<"db" | "out" | "store", number>>> = {
    "/presets/1": { db: 2, store: 1, out: 1 },
    "/stream": { db: 1, store: 1, out: 0 },
    "/events": { db: 1, store: 0, out: 0 },
    "/fail": { db: 1, store: 0, out: 0 },
    "/broken": { db: 1, store: 0, out: 0 },
    "/nowhere/42?q=private": { db: 0, store: 0, out: 0 },
    "/presets": { db: 0, store: 0, out: 0 },
  };
  for (const [ending, path, init, expected] of endings) {
    test(`closes ${ending} into one record`, async () => {
      const written = app.nextRecord();
      await (await fetch(app.url(path), init)).text();
      const made = await recordOf(written);
      expect(made).toMatchObject(expected);
      const counts = kinds[path] ?? {};
      expect({ db: made.db.count, store: made.store.count, out: made.out.count }).toEqual({
        db: counts.db ?? 0,
        store: counts.store ?? 0,
        out: counts.out ?? 0,
      });
    });
  }

  test("closes a request whose client left before the response, as 499 and aborted", async () => {
    const written = app.nextRecord();
    const client = new AbortController();
    const response = fetch(app.url("/hang"), { signal: client.signal });
    await app.held.reached();
    client.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    const made = await written;
    app.held.open();
    expect(made).toMatchObject({ operation: "/hang", status: 499, aborted: true, streamed: false });
    expect(made.db.count).toBe(1);
    await recordOf(Promise.resolve(made));
  });

  test("closes a stream its client left midway, with the status it had sent", async () => {
    const written = app.nextRecord();
    const client = new AbortController();
    const response = await fetch(app.url("/drip"), { signal: client.signal });
    const reader = response.body?.getReader();
    const first: unknown = (await reader?.read())?.value;
    expect(first instanceof Uint8Array && new TextDecoder().decode(first)).toBe("drop;");
    await app.held.reached();
    client.abort();
    const made = await written;
    app.held.open();
    expect(made).toMatchObject({ operation: "/drip", status: 200, aborted: true, streamed: true });
    expect(made.db.count).toBe(0);
    await recordOf(Promise.resolve(made));
  });

  test("counts each overlapping request's own waits, whoever hands it its connection", () =>
    check(
      asyncProperty(
        uniqueArray(integer({ min: 0, max: LANES - 1 }), { minLength: 2, maxLength: LANES }),
        array(
          record({
            db: integer({ min: 0, max: 3 }),
            store: integer({ min: 0, max: 2 }),
            out: integer({ min: 0, max: 2 }),
          }),
          {
            minLength: LANES,
            maxLength: LANES,
          },
        ),
        async (lanes, plans) => {
          // The latch: the pool's one connection, held outside any operation
          // until every lane is queued for it.
          const queued = Promise.withResolvers<void>();
          let waiting = 0;
          const onEnqueue = () => {
            waiting += 1;
            if (waiting === lanes.length) queued.resolve();
          };
          app.pool.on("enqueue", onEnqueue);
          const holding = await app.pool.getConnection();
          const responses = lanes.map(async (lane) => {
            const plan = plans[lane] ?? { db: 0, store: 0, out: 0 };
            const query = `db=${plan.db}&store=${plan.store}&out=${plan.out}`;
            return (await fetch(app.url(`/lanes/${lane}?${query}`))).text();
          });
          await queued.promise;
          app.pool.off("enqueue", onEnqueue);
          holding.release();
          await Promise.all(responses);
          const records = await Promise.all(lanes.map(() => app.nextRecord()));
          const seen = Object.fromEntries(
            records.map((made) => [
              made.operation,
              { db: made.db.count, store: made.store.count, out: made.out.count },
            ]),
          );
          const planned = Object.fromEntries(
            lanes.map((lane) => {
              const plan = plans[lane] ?? { db: 0, store: 0, out: 0 };
              return [`/lanes/${lane}`, { ...plan, db: plan.db + 1 }];
            }),
          );
          expect(seen).toEqual(planned);
        },
      ),
      { numRuns: 25 },
    ));

  test("passes the conformance kit", () =>
    requestTimingConforms({
      method: "GET",
      operation: "/presets/:id",
      dbWaits: 2,
      drive: async () => void (await (await fetch(app.url("/presets/1"))).text()),
      next: app.nextLine,
    }));

  test("refuses to mount behind a route it could not name", () => {
    const timing = requestTiming({ sink: () => undefined });
    expect(() =>
      new Elysia().get("/early", () => "early").use(requestTimingPlugin(timing)),
    ).toThrow("GET /early");
  });

  test("refuses at listen a route whose pattern the core will not take", () => {
    const timing = requestTiming({ sink: () => undefined });
    const optional = new Elysia()
      .use(requestTimingPlugin(timing))
      .get("/presets/:id?", () => "one");
    expect(() => optional.listen({ port: 0, hostname: "127.0.0.1" })).toThrow("query string");
    void optional.stop(true);
  });

  test("closes a WebSocket upgrade into one record of the status Elysia answered it with", async () => {
    const written = app.nextRecord();
    const socket = new WebSocket(app.url("/socket").href.replace("http", "ws"));
    const echoed = Promise.withResolvers<unknown>();
    socket.addEventListener("message", (event) => echoed.resolve(event.data));
    await new Promise((open) => socket.addEventListener("open", open));
    socket.send("hello");
    expect(await echoed.promise).toBe("hello");
    socket.close();
    expect(await recordOf(written)).toMatchObject({
      operation: "/socket",
      status: 200,
      aborted: false,
    });
  });
});
