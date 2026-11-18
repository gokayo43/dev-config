/**
 * The Next.js connector, with the Effect crossings and the mysql2 and `fetch`
 * connectors under it, through a real Next.js app booted as production serves
 * it over a real MySQL and a real outside service
 * (`request-timing-next-fixture.ts`).
 *
 * - Invariant 1, the differential: one scripted sequence of requests against
 *   the app with timing off and with it on, compared response by response.
 *   The off run is the oracle.
 * - Invariant 2: each ending a route handler can reach, driven for real,
 *   closes into exactly one record with its name, status, kinds and counts.
 *   "Exactly one" is read by a sentinel request after each, once the handler
 *   has finished: the records written before the sentinel's hold one of the
 *   operation, never two, never none.
 * - The conformance kit, run against the app as an adopting app runs it.
 *
 * Invariant 3 through this app is the overlap property in
 * `request-timing-trpc.test.ts`, whose lanes are procedures and a route
 * handler alike.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { must } from "../narrowing.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { requestTimingRoute } from "../request-timing-next.ts";
import {
  OperationName,
  requestTiming,
  type TimingRecord,
  type WaitKind,
  within,
} from "../request-timing.ts";
import { type NextApp, nextApp } from "./request-timing-next-fixture.ts";

let app: NextApp;
// The first suite of a run to boot the app also builds it, which a cold
// `next build` takes tens of seconds to do on a loaded box.
beforeAll(async () => {
  app = await nextApp(true);
}, 300_000);
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
  ["/api/presets/1", {}],
  ["/api/presets/999", {}],
  ["/api/presets/1", { method: "HEAD" }],
  ["/api/stream", {}],
  ["/api/fail", {}],
  ["/api/lane?db=2&out=1", {}],
  ["/api/presets/2", { method: "POST" }],
];

const runScript = async (target: NextApp) => {
  const responses = [];
  for (const [path, init] of SCRIPT) {
    responses.push(await read(await fetch(target.url(path), init)));
  }
  return responses;
};

const countsOf = (record: TimingRecord) => ({
  db: record.db.count,
  out: record.out.count,
  store: record.store.count,
});

/** The one record of `operation` among those written before the sentinel's. */
async function onlyOne(operation: string): Promise<TimingRecord> {
  const written = (await app.settle()).filter((record) => record.operation === operation);
  expect(written).toHaveLength(1);
  return must(written[0]);
}

describe("the Next.js connector", () => {
  test("changes no response the app gives", async () => {
    await using off = await nextApp(false);
    expect(await runScript(app)).toEqual(await runScript(off));
    await app.settle();
  });

  const endings: [
    string,
    string,
    RequestInit,
    Partial<TimingRecord>,
    Partial<Record<WaitKind, number>>,
  ][] = [
    [
      "a normal response, with its waits on both sides of the Effect crossings",
      "/api/presets/1",
      {},
      {
        method: "GET",
        operation: "/api/presets/[id]",
        status: 200,
        aborted: false,
        streamed: false,
      },
      { db: 2, out: 1 },
    ],
    [
      "a refusal the route's adapter answered",
      "/api/presets/999",
      {},
      {
        method: "GET",
        operation: "/api/presets/[id]",
        status: 404,
        aborted: false,
        streamed: false,
      },
      { db: 1 },
    ],
    [
      "a HEAD, whose body Next.js never reads",
      "/api/presets/1",
      { method: "HEAD" },
      {
        method: "HEAD",
        operation: "/api/presets/[id]",
        status: 200,
        aborted: false,
        streamed: false,
      },
      { db: 2, out: 1 },
    ],
    [
      "a streamed body, after its last chunk, with the waits made as it was pulled",
      "/api/stream",
      {},
      { method: "GET", operation: "/api/stream", status: 200, aborted: false, streamed: true },
      { db: 1, out: 1 },
    ],
    [
      "a handler that throws, with the 500 Next.js answered",
      "/api/fail",
      {},
      { method: "GET", operation: "/api/fail", status: 500, aborted: false, streamed: false },
      { db: 1 },
    ],
  ];
  for (const [ending, path, init, expected, counts] of endings) {
    test(`closes ${ending} into one record`, async () => {
      const response = await fetch(app.url(path), init);
      await response.text();
      const made = await onlyOne(must(expected.operation));
      expect(made).toMatchObject(expected);
      expect(made.status).toBe(response.status);
      expect(countsOf(made)).toEqual({ db: 0, out: 0, store: 0, ...counts });
    });
  }

  test("closes a request whose client left before the response, as 499 and aborted", async () => {
    const client = new AbortController();
    const response = fetch(app.url("/api/hang"), { signal: client.signal });
    await (await fetch(app.url("/api/held"))).text();
    client.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    const made = await app.recordOf("/api/hang");
    await (await fetch(app.url("/api/held"), { method: "POST" })).text();
    expect(made).toMatchObject({ status: 499, aborted: true, streamed: false });
    expect(countsOf(made)).toEqual({ db: 1, out: 0, store: 0 });
    expect((await app.settle()).map((record) => record.operation)).not.toContain("/api/hang");
  });

  test("closes a body its client left midway, with the status it had sent", async () => {
    const client = new AbortController();
    const response = await fetch(app.url("/api/drip"), { signal: client.signal });
    const reader = response.body?.getReader();
    const first: unknown = (await reader?.read())?.value;
    expect(first instanceof Uint8Array && new TextDecoder().decode(first)).toBe("drop;");
    await (await fetch(app.url("/api/held"))).text();
    client.abort();
    const made = await app.recordOf("/api/drip");
    await (await fetch(app.url("/api/held"), { method: "POST" })).text();
    expect(made).toMatchObject({ status: 200, aborted: true, streamed: true });
    expect(countsOf(made)).toEqual({ db: 0, out: 0, store: 0 });
    expect((await app.settle()).map((record) => record.operation)).not.toContain("/api/drip");
  });

  test("passes the conformance kit", async () => {
    await app.settle();
    await requestTimingConforms({
      method: "GET",
      operation: "/api/presets/[id]",
      dbWaits: 2,
      drive: async () => void (await (await fetch(app.url("/api/presets/1"))).text()),
      next: app.nextLine,
    });
  });

  test("refuses, when the route module loads, a pattern the core will not take", () => {
    const timedRoute = requestTimingRoute(requestTiming({ sink: () => undefined }));
    expect(() => timedRoute("/api/presets?id", () => new Response())).toThrow("query string");
  });

  test("opens no operation for a handler called while one is current", async () => {
    const records: TimingRecord[] = [];
    const timing = requestTiming({ sink: (record) => void records.push(record) });
    const inner = requestTimingRoute(timing)("/inner", () => new Response("inner"));
    const outer = timing.open();
    const answer = await within(outer, () => inner(new Request("http://in-process/inner"), {}));
    expect(await answer.text()).toBe("inner");
    outer.close({
      method: "GET",
      name: OperationName.registered("/outer"),
      status: 200,
      aborted: false,
      streamed: false,
    });
    expect(records.map((record) => record.operation)).toEqual(["/outer"]);
  });
});
