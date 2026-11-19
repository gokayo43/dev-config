/**
 * The Next.js connector, with route handlers that run Effect programs and the
 * mysql2 and `fetch` connectors under them, through a real Next.js app booted as production serves
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
import { describe, expect, test } from "bun:test";

import { must } from "../narrowing.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { requestTimingRoute } from "../request-timing-next.ts";
import { OperationName, requestTiming, type TimingRecord, within } from "../request-timing.ts";
import { read } from "./request-timing-fixture.ts";
import { bootedForSuite, differential, type Ending } from "./request-timing-next-fixture.ts";
import { countsOf } from "./request-timing-oracle.ts";

const suite = bootedForSuite();

/** The scripted sequence the differential runs against both apps. */
const SCRIPT: readonly [string, RequestInit][] = [
  ["/api/presets/1", {}],
  ["/api/presets/999", {}],
  ["/api/presets/1", { method: "HEAD" }],
  ["/api/stream", {}],
  ["/api/fail", {}],
  ["/api/lane?db=2&out=1&tx=false", {}],
  ["/api/lane?db=2&out=1&tx=true", {}],
  ["/api/presets/2", { method: "POST" }],
  ["/api/unwritten", {}],
  ["/api/errored", {}],
];

/** The one record of `operation` among those written before the sentinel's. */
async function onlyOne(operation: string): Promise<TimingRecord> {
  const written = (await suite.app.settle()).filter((record) => record.operation === operation);
  expect(written).toHaveLength(1);
  return must(written[0]);
}

describe("the Next.js connector", () => {
  test("changes no response the app gives", async () => {
    const { on, off } = await differential(suite.app, SCRIPT, read);
    expect(on).toEqual(off);
  });

  const endings: Ending[] = [
    [
      "a normal response, with its waits made inside an Effect program",
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
      const response = await fetch(suite.app.url(path), init);
      await response.text();
      const made = await onlyOne(must(expected.operation));
      expect(made).toMatchObject(expected);
      expect(made.status).toBe(response.status);
      expect(countsOf(made)).toEqual({ db: 0, out: 0, store: 0, ...counts });
    });
  }

  test("closes a request whose client left before the response, as 499 and aborted", async () => {
    const client = new AbortController();
    const response = fetch(suite.app.url("/api/hang"), { signal: client.signal });
    await (await fetch(suite.app.url("/api/held"))).text();
    client.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    const made = await suite.app.recordOf("/api/hang");
    await (await fetch(suite.app.url("/api/held"), { method: "POST" })).text();
    expect(made).toMatchObject({ status: 499, aborted: true, streamed: false });
    expect(countsOf(made)).toEqual({ db: 1, out: 0, store: 0 });
    expect((await suite.app.settle()).map((record) => record.operation)).not.toContain("/api/hang");
  });

  test("closes a body its client left midway, with the status it had sent", async () => {
    const client = new AbortController();
    const response = await fetch(suite.app.url("/api/drip"), { signal: client.signal });
    const reader = response.body?.getReader();
    const first: unknown = (await reader?.read())?.value;
    expect(first instanceof Uint8Array && new TextDecoder().decode(first)).toBe("drop;");
    await (await fetch(suite.app.url("/api/held"))).text();
    client.abort();
    const made = await suite.app.recordOf("/api/drip");
    await (await fetch(suite.app.url("/api/held"), { method: "POST" })).text();
    expect(made).toMatchObject({ status: 200, aborted: true, streamed: true });
    expect(countsOf(made)).toEqual({ db: 0, out: 0, store: 0 });
    expect((await suite.app.settle()).map((record) => record.operation)).not.toContain("/api/drip");
  });

  // What the app's `fault` is handed, and no record: the response served as
  // it is without timing (the differential above), and the app still serving.
  const faulted: [string, string, string][] = [
    ["a sink that throws", "/api/unwritten", "the sink refused the record"],
    ["a status no response is sent with", "/api/errored", "closed with status 0"],
  ];
  for (const [fault, path, message] of faulted) {
    test(`hands ${fault} to the app's fault, once, and writes no record`, async () => {
      await suite.app.settle();
      suite.app.faults();
      await (await fetch(suite.app.url(path))).arrayBuffer();
      const written = await suite.app.settle();
      expect(written.map((record) => record.operation)).not.toContain(path);
      const reported = suite.app.faults();
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(message);
    });
  }

  test("closes a request whose client had left before the wrapper ran, as 499 and aborted", async () => {
    const records: TimingRecord[] = [];
    const timing = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (record) => void records.push(record),
    });
    const route = requestTimingRoute(timing)("/left", () => new Response("too late"));
    const left = new Request("http://in-process/left", { signal: AbortSignal.abort() });
    expect(await (await route(left, {})).text()).toBe("too late");
    expect(records).toMatchObject([{ operation: "/left", status: 499, aborted: true }]);
  });

  test("passes the conformance kit", async () => {
    await suite.app.settle();
    await requestTimingConforms({
      method: "GET",
      operation: "/api/presets/[id]",
      dbWaits: 2,
      drive: async () => void (await (await fetch(suite.app.url("/api/presets/1"))).text()),
      next: suite.app.nextLine,
      sentinel: {
        operation: "/api/sentinel",
        drive: async () => void (await (await fetch(suite.app.url("/api/sentinel"))).text()),
      },
    });
  });

  test("refuses, when the route module loads, a pattern the core will not take", () => {
    const timedRoute = requestTimingRoute(
      requestTiming({
        fault: (error) => {
          throw error;
        },
        sink: () => undefined,
      }),
    );
    expect(() => timedRoute("/api/presets?id", () => new Response())).toThrow("query string");
  });

  test("opens no operation for a handler called while one is current", async () => {
    const records: TimingRecord[] = [];
    const timing = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (record) => void records.push(record),
    });
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
