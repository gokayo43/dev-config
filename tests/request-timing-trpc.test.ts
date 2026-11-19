/**
 * The tRPC connector, with procedures that run Effect programs and the mysql2
 * and `fetch` connectors under them, through the real Next.js app `request-timing-next-app/`
 * serves its router from, booted as production serves it over a real MySQL and
 * a real outside service (`request-timing-next-fixture.ts`).
 *
 * - Invariant 1, the differential: one scripted sequence of calls against the
 *   app with timing off and with it on, compared byte for byte. The off run is
 *   the oracle.
 * - Invariant 2: each ending a call can reach, driven for real, closes into
 *   exactly one record with its name, method, status, kinds and counts, the
 *   status being the one tRPC answers the call with alone. "Exactly one" is
 *   read by a sentinel request after each.
 * - Invariant 3 at the seam: a property over overlapping calls and route
 *   requests, each with a generated number of database and outbound waits,
 *   whose outbound waits are made in turn under one semaphore the case holds
 *   until every lane is provably queued for it, so each lane after the first
 *   is woken by the lane that let it go, and whose database waits,
 *   drizzle queries a `Db` thunk hands straight back or the statements of one
 *   drizzle transaction, queue on a pool of four.
 * - The conformance kit, run against the app as an adopting app runs it.
 */
import { describe, expect, test } from "bun:test";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { array, asyncProperty, integer, record, uniqueArray } from "fast-check";

import { must } from "../narrowing.ts";
import { check } from "../property.ts";
import { requestTimingConforms } from "../request-timing-conformance.ts";
import { requestTimingProcedures } from "../request-timing-trpc.ts";
import {
  measure,
  OperationName,
  requestTiming,
  type TimingRecord,
  within,
} from "../request-timing.ts";
import { LANES, REFUSED_PROCEDURE, TRPC_CODES } from "./request-timing-next-app/server/router.ts";
import { read } from "./request-timing-fixture.ts";
import { bootedForSuite, differential, type Ending } from "./request-timing-next-fixture.ts";
import { countsOf } from "./request-timing-oracle.ts";

const suite = bootedForSuite();

/** One call as tRPC's HTTP link sends it alone. */
const single = (path: string, input?: unknown) =>
  input === undefined
    ? `/api/trpc/${path}`
    : `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** Calls as tRPC's batch link sends them together, in one GET. */
const batch = (calls: readonly (readonly [string, unknown])[]) => {
  const inputs = Object.fromEntries(calls.map(([, input], index) => [index, input]));
  const paths = calls.map(([path]) => path).join(",");
  return `/api/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(inputs))}`;
};

const mutation = (label: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(label),
});

/** A body as a client reads it, byte for byte. */
const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

/** The scripted sequence the differential runs against both apps. */
const SCRIPT: readonly [string, RequestInit][] = [
  [single("presets.byId", { id: 1 }), {}],
  [single("presets.byId", { id: 999 }), {}],
  [single("presets.byId", { nope: true }), {}],
  [single("presets.add"), mutation("third")],
  [single("presets.add"), mutation("third")],
  [single("fail.throws"), {}],
  [single("guarded.secret"), {}],
  [single("nowhere.at.all"), {}],
  ...TRPC_CODES.map((code): [string, RequestInit] => [single("fail.code", code), {}]),
  [
    batch([
      ["presets.byId", { id: 1 }],
      ["presets.byId", { id: 999 }],
      ["fail.code", "CONFLICT"],
    ]),
    {},
  ],
  [single("ticks.count"), {}],
  [single("lanes.l0", { db: 2, out: 1, tx: false }), {}],
  [single("lanes.l1", { db: 2, out: 1, tx: true }), {}],
  [single("faults.unwritten"), {}],
  [single(REFUSED_PROCEDURE), {}],
];

type BodyReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read">;

/** The next chunk of a body, as text. */
async function nextText(reader: BodyReader): Promise<string> {
  const chunk = await reader.read();
  return chunk.done ? "" : new TextDecoder().decode(chunk.value);
}

/** What is left of a body, read to its end. */
async function restOf(reader: BodyReader): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

/** The records written before the sentinel's, with none of the envelope's route among them. */
async function settled(): Promise<TimingRecord[]> {
  const written = await suite.app.settle();
  expect(written.filter((made) => made.operation.startsWith("/api/trpc"))).toEqual([]);
  return written;
}

/** The one record of `operation` among those written before the sentinel's. */
async function onlyOne(operation: string): Promise<TimingRecord> {
  const written = (await settled()).filter((made) => made.operation === operation);
  expect(written).toHaveLength(1);
  return must(written[0]);
}

describe("the tRPC connector", () => {
  test("changes no byte of any answer the app gives", async () => {
    const { on, off } = await differential(suite.app, SCRIPT, (response) => read(response, bytes));
    expect(on).toEqual(off);
  });

  const endings: Ending[] = [
    [
      "a query's answer, with its waits made inside an Effect program",
      single("presets.byId", { id: 1 }),
      {},
      { method: "GET", operation: "presets.byId", status: 200, aborted: false, streamed: false },
      { db: 2, out: 1 },
    ],
    [
      "a refusal the program's error map made",
      single("presets.byId", { id: 999 }),
      {},
      { method: "GET", operation: "presets.byId", status: 404 },
      { db: 1 },
    ],
    [
      "an input its validator refused",
      single("presets.byId", { nope: true }),
      {},
      { method: "GET", operation: "presets.byId", status: 400 },
      {},
    ],
    [
      "a mutation's answer",
      single("presets.add"),
      mutation("fourth"),
      { method: "POST", operation: "presets.add", status: 200, aborted: false, streamed: false },
      { db: 2 },
    ],
    [
      "a mutation the database refused",
      single("presets.add"),
      mutation("fourth"),
      { method: "POST", operation: "presets.add", status: 500 },
      { db: 1 },
    ],
    [
      "a procedure that throws",
      single("fail.throws"),
      {},
      { method: "GET", operation: "fail.throws", status: 500 },
      { db: 1 },
    ],
    [
      "a refusal of a middleware after it",
      single("guarded.secret"),
      {},
      { method: "GET", operation: "guarded.secret", status: 403 },
      {},
    ],
    [
      "a query sent as a POST, as a read",
      single("presets.byId"),
      { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":1}' },
      { method: "GET", operation: "presets.byId", status: 200 },
      { db: 2, out: 1 },
    ],
  ];
  for (const [ending, path, init, expected, counts] of endings) {
    test(`closes ${ending} into one record of the status tRPC answered`, async () => {
      const response = await fetch(suite.app.url(path), init);
      await response.arrayBuffer();
      const made = await onlyOne(must(expected.operation));
      expect(made).toMatchObject(expected);
      expect(made.status).toBe(response.status);
      expect(countsOf(made)).toEqual({ db: 0, out: 0, store: 0, ...counts });
    });
  }

  test("writes no record for a call tRPC refuses before any procedure runs", async () => {
    const response = await fetch(suite.app.url(single("nowhere.at.all")));
    await response.arrayBuffer();
    expect(response.status).toBe(404);
    expect(await settled()).toEqual([]);
  });

  test("closes each call of a batch into a record of its own, and none for the envelope", async () => {
    const calls = [
      { path: "presets.byId", input: { id: 1 }, db: 2 },
      { path: "presets.byId", input: { id: 999 }, db: 1 },
      { path: "fail.code", input: "CONFLICT", db: 1 },
    ];
    await (
      await fetch(suite.app.url(batch(calls.map((call) => [call.path, call.input]))))
    ).arrayBuffer();
    const ofBatch = await settled();
    const alone = [];
    for (const call of calls) {
      const response = await fetch(suite.app.url(single(call.path, call.input)));
      await response.arrayBuffer();
      alone.push({ operation: call.path, status: response.status, db: call.db });
    }
    await settled();
    const byStatus = (left: { status: number }, right: { status: number }) =>
      left.status - right.status;
    expect(
      ofBatch
        .map((made) => ({ operation: made.operation, status: made.status, db: made.db.count }))
        .toSorted(byStatus),
    ).toEqual(alone.toSorted(byStatus));
  });

  test("closes a call whose client left before the answer, as 499 and aborted", async () => {
    const client = new AbortController();
    const response = fetch(suite.app.url(single("held.hang")), { signal: client.signal });
    await (await fetch(suite.app.url("/api/held"))).text();
    client.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    const made = await suite.app.recordOf("held.hang");
    await (await fetch(suite.app.url("/api/held"), { method: "POST" })).text();
    expect(made).toMatchObject({ method: "GET", status: 499, aborted: true, streamed: false });
    expect(countsOf(made)).toEqual({ db: 1, out: 0, store: 0 });
    expect((await settled()).map((written) => written.operation)).not.toContain("held.hang");
  });

  test("counts each overlapping lane's own waits, whoever let it through", () =>
    check(
      asyncProperty(
        uniqueArray(integer({ min: 0, max: LANES }), { minLength: 2, maxLength: LANES + 1 }),
        array(record({ db: integer({ min: 0, max: 3 }), out: integer({ min: 0, max: 2 }) }), {
          minLength: LANES + 1,
          maxLength: LANES + 1,
        }),
        async (lanes, plans) => {
          // The latch: the semaphore's one permit, held by a request of its
          // own until every lane has queued for it.
          const latch = await fetch(suite.app.url(`/api/latch?lanes=${lanes.length}`));
          const reader = must(latch.body).getReader();
          expect(await nextText(reader)).toBe("held;");
          const planned = lanes.map((lane) => {
            // An odd lane runs its database waits as one drizzle transaction,
            // an even one hands each drizzle query straight back from its thunk.
            const plan = { ...must(plans[lane]), tx: lane % 2 === 1 };
            // The last lane is a route handler; the others are procedures.
            const operation = lane === LANES ? "/api/lane" : `lanes.l${lane}`;
            const path =
              lane === LANES
                ? `/api/lane?db=${plan.db}&out=${plan.out}&tx=${plan.tx}`
                : single(operation, plan);
            // A transaction adds its checkout, its begin and its commit, as the
            // mysql2 connector's page counts them.
            const counted = { db: plan.tx ? plan.db + 3 : plan.db, out: plan.out };
            return {
              operation,
              counted,
              answered: fetch(suite.app.url(path)).then((r) => r.text()),
            };
          });
          expect(await restOf(reader)).toBe("released");
          for (const lane of planned) expect(await lane.answered).toContain("done");
          const written = await settled();
          const seen = Object.fromEntries(
            written.map((made) => [made.operation, { db: made.db.count, out: made.out.count }]),
          );
          expect(seen).toEqual({
            "/api/latch": { db: 0, out: 0 },
            ...Object.fromEntries(planned.map((lane) => [lane.operation, lane.counted])),
          });
          expect(written).toHaveLength(planned.length + 1);
        },
      ),
      { numRuns: 25 },
    ));

  // What the app's `fault` is handed, and no record: the answer served as it
  // is without timing (the differential above), and the app still serving.
  const faulted: [string, string, string][] = [
    ["a sink that throws", "faults.unwritten", "the sink refused the record"],
    [
      "a lazily loaded procedure's path the core refuses",
      REFUSED_PROCEDURE,
      "longer than 256 characters",
    ],
  ];
  for (const [fault, path, message] of faulted) {
    test(`hands ${fault} to the app's fault, once, and writes no record`, async () => {
      await settled();
      suite.app.faults();
      const response = await fetch(suite.app.url(single(path)));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("served");
      expect((await settled()).map((made) => made.operation)).not.toContain(path);
      const reported = suite.app.faults();
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(message);
    });
  }

  test("passes the conformance kit", async () => {
    await suite.app.settle();
    await requestTimingConforms({
      method: "GET",
      operation: "presets.byId",
      dbWaits: 2,
      drive: async () =>
        void (await (await fetch(suite.app.url(single("presets.byId", { id: 1 })))).text()),
      next: suite.app.nextLine,
      sentinel: {
        operation: "/api/sentinel",
        drive: async () => void (await (await fetch(suite.app.url("/api/sentinel"))).text()),
      },
    });
  });
});

describe("the tRPC connector, in-process", () => {
  const t = initTRPC.create();

  /** Every code a TRPCError takes, as tRPC lists them. */
  const CODES = Object.keys(TRPC_ERROR_CODES_BY_KEY).filter(
    (key): key is TRPC_ERROR_CODE_KEY => key in TRPC_ERROR_CODES_BY_KEY,
  );

  test("opens no operation for a call that did not arrive through the envelope", async () => {
    const records: TimingRecord[] = [];
    const timing = requestTimingProcedures(
      requestTiming({
        fault: (error) => {
          throw error;
        },
        sink: (made) => void records.push(made),
      }),
      getHTTPStatusCodeFromError,
    );
    const router = t.router({ ping: t.procedure.use(timing.middleware).query(() => "pong") });
    expect(await t.createCallerFactory(router)({}).ping()).toBe("pong");
    expect(records).toEqual([]);
  });

  /** Opens once the case lets the procedure that waits on it on. */
  const gate = () => {
    const { promise: opened, resolve: open } = Promise.withResolvers<void>();
    return { opened, open: () => open() };
  };

  /** A wait the operation counts, which waits on nothing outside the process. */
  const waited = () => measure("db", () => Promise.resolve());

  /**
   * A router on the middleware, served through the envelope by tRPC's own
   * fetch adapter, and the records it writes: a query, a query that refuses
   * with the code it is given after one wait, and subscriptions that finish,
   * fail, or wait on `held` midway.
   */
  function enveloped() {
    const records: TimingRecord[] = [];
    const timing = requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (made) => void records.push(made),
    });
    const procedures = requestTimingProcedures(timing, getHTTPStatusCodeFromError);
    const procedure = t.procedure.use(procedures.middleware);
    const held = gate();
    const router = t.router({
      ping: procedure.query(() => "pong"),
      refuse: procedure
        .input((raw: unknown) => must(CODES.find((code) => code === raw)))
        .query(async ({ input }) => {
          await waited();
          throw new TRPCError({ code: input });
        }),
      ticks: procedure.subscription(async function* () {
        yield 1;
        await waited();
        yield 2;
        await waited();
        yield 3;
      }),
      broken: procedure.subscription(async function* () {
        yield 1;
        await waited();
        throw new Error("the stream broke");
      }),
      drip: procedure.subscription(async function* () {
        yield "drop";
        await waited();
        await held.opened;
        yield "never read";
      }),
    });
    const handler = procedures.envelope(router, (request: Request) =>
      fetchRequestHandler({ endpoint: "/trpc", req: request, router, createContext: () => ({}) }),
    );
    const call = (path: string, init?: RequestInit) =>
      handler(new Request(`http://in-process${path}`, init), {});
    return { records, timing, handler, call, held };
  }

  test("records each error code with the status tRPC answers it with alone", async () => {
    const { records, call } = enveloped();
    for (const code of CODES) {
      const response = await call(`/trpc/refuse?input=${encodeURIComponent(JSON.stringify(code))}`);
      await response.arrayBuffer();
      const made = must(records.pop());
      expect({ code, status: made.status, db: made.db.count }).toEqual({
        code,
        status: response.status,
        db: 1,
      });
    }
    expect(records).toEqual([]);
  });

  test("closes a subscription when its stream ends, with the waits between its events", async () => {
    const { records, call } = enveloped();
    expect(await (await call("/trpc/ticks")).text()).toContain("data: 3");
    expect(records).toMatchObject([
      { method: "GET", operation: "ticks", status: 200, aborted: false, streamed: true },
    ]);
    expect(countsOf(must(records[0]))).toEqual({ db: 2, out: 0, store: 0 });
  });

  test("closes a subscription that fails midway, with the 200 its stream was sent with", async () => {
    const { records, call } = enveloped();
    await (await call("/trpc/broken")).text();
    expect(records).toMatchObject([
      { operation: "broken", status: 200, aborted: false, streamed: true },
    ]);
    expect(countsOf(must(records[0]))).toEqual({ db: 1, out: 0, store: 0 });
  });

  test("closes a subscription its client left midway, as aborted", async () => {
    const { records, call, held } = enveloped();
    const client = new AbortController();
    const reader = must((await call("/trpc/drip", { signal: client.signal })).body).getReader();
    let seen = "";
    while (!seen.includes("drop")) seen += await nextText(reader);
    client.abort();
    await reader.cancel();
    held.open();
    expect(records).toMatchObject([
      { operation: "drip", status: 200, aborted: true, streamed: true },
    ]);
  });

  test("opens one operation per call through the envelope, and none while one is current", async () => {
    const { records, timing, call: served } = enveloped();
    const call = () => served("/trpc/ping");
    expect((await call()).status).toBe(200);
    const outer = timing.open();
    expect((await within(outer, call)).status).toBe(200);
    outer.close({
      method: "GET",
      name: OperationName.registered("/outer"),
      status: 200,
      aborted: false,
      streamed: false,
    });
    expect(records.map((made) => made.operation)).toEqual(["ping", "/outer"]);
  });

  test("closes a call whose client had left before the middleware ran, as 499 and aborted", async () => {
    const { records, call } = enveloped();
    await (await call("/trpc/ping", { signal: AbortSignal.abort() })).arrayBuffer();
    expect(records).toMatchObject([{ operation: "ping", status: 499, aborted: true }]);
  });

  test("refuses, when the route module loads, a procedure path the core will not take", () => {
    const timing = requestTimingProcedures(
      requestTiming({
        fault: (error) => {
          throw error;
        },
        sink: () => undefined,
      }),
      getHTTPStatusCodeFromError,
    );
    const router = t.router({ "a?path": t.procedure.query(() => "never") });
    expect(() => timing.envelope(router, async () => new Response())).toThrow("query string");
  });
});
