/**
 * The operation and its record, in plain code and in an Effect program: the record's fields
 * (invariant 6's list), sealing at emission (invariant 4), sums against the
 * rest on a virtual clock (invariant 5), and that nothing a person sent can
 * reach a record (invariant 6). Attribution under overlap, invariant 3, is
 * `request-timing-attribution.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Queue } from "effect";
import { asyncProperty, property, record, string, webPath, webQueryParameters } from "fast-check";

import { check } from "../property.ts";
import {
  type Ending,
  inOperation,
  measure,
  methodOf,
  OperationName,
  requestTiming,
  type Timing,
  type TimingRecord,
  type WaitKind,
  within,
} from "../request-timing.ts";

/** A clock that moves only when the case moves it. */
function virtualClock(start = Date.UTC(2026, 10, 18)) {
  let at = start;
  return {
    now: () => at,
    set: (ms: number) => {
      at = start + ms;
    },
  };
}

/** Timing switched on with a sink that keeps what it is handed. */
function recorded(now: () => number) {
  const records: TimingRecord[] = [];
  return {
    records,
    timing: requestTiming({
      fault: (error) => {
        throw error;
      },
      sink: (made) => void records.push(made),
      now,
    }),
  };
}

const ended = (status = 200): Ending => ({
  method: "GET",
  name: OperationName.registered("/presets/:id"),
  status,
  aborted: false,
  streamed: false,
});

const RESERVED = [
  "requestTiming",
  "at",
  "method",
  "operation",
  "status",
  "totalMs",
  "inFlightMs",
  "db",
  "out",
  "store",
  "aborted",
  "streamed",
];

describe("an operation closes into one record", () => {
  test("in a plain async program", async () => {
    const clock = virtualClock();
    const { records, timing } = recorded(clock.now);
    const operation = timing.open();
    await within(operation, async () => {
      await measure("db", async () => "row");
      await measure("db", async () => "row");
      await measure("store", async () => "hit");
      clock.set(4);
    });
    operation.close({ ...ended(503), aborted: true, streamed: true });

    expect(records).toEqual([
      {
        requestTiming: 1,
        at: "2026-11-18T00:00:00.004Z",
        method: "GET",
        operation: "/presets/:id",
        status: 503,
        totalMs: 4,
        inFlightMs: 0,
        db: { waitMs: 0, count: 2 },
        out: { waitMs: 0, count: 0 },
        store: { waitMs: 0, count: 1 },
        aborted: true,
        streamed: true,
      },
    ]);
    expect(Object.keys(records[0] ?? {}).toSorted()).toEqual(RESERVED.toSorted());
  });

  test("in an Effect program a handler runs", async () => {
    const clock = virtualClock();
    const { records, timing } = recorded(clock.now);
    const operation = timing.open();
    await within(operation, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => measure("db", async () => "row"));
          yield* Effect.tryPromise(() => measure("out", async () => "answer"));
          // A wait in a fiber the program forks is the handler's.
          yield* Fiber.join(
            yield* Effect.forkChild(Effect.promise(() => measure("db", async () => "row"))),
          );
          clock.set(7);
        }),
      ),
    );
    operation.close(ended());

    expect(records).toMatchObject([
      {
        totalMs: 7,
        db: { waitMs: 0, count: 2 },
        out: { waitMs: 0, count: 1 },
        store: { waitMs: 0, count: 0 },
      },
    ]);
  });

  test("and a second close throws without a second record", () => {
    const { records, timing } = recorded(virtualClock().now);
    const operation = timing.open();
    operation.close(ended());
    expect(() => operation.close(ended())).toThrow("closed twice");
    expect(records).toHaveLength(1);
  });

  test("and a status that is not an HTTP one is refused", () => {
    const { records, timing } = recorded(virtualClock().now);
    for (const status of [0, 99, 600, 200.5]) {
      expect(() => timing.open().close(ended(status)), String(status)).toThrow(
        "not an HTTP status",
      );
    }
    expect(records).toEqual([]);
  });
});

describe("an entry connector opens nothing inside a current operation", () => {
  /** An entry connector as the docs page has one written: it asks before it opens. */
  const servePlain = async <T>(timing: Timing, handler: () => Promise<T>): Promise<T> => {
    if (inOperation()) return handler();
    const operation = timing.open();
    try {
      return await within(operation, handler);
    } finally {
      operation.close(ended());
    }
  };

  const expected = [{ db: { waitMs: 0, count: 2 }, out: { waitMs: 0, count: 1 } }];

  test("in a plain async program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    await servePlain(timing, async () => {
      await measure("db", async () => "row");
      await servePlain(timing, async () => {
        await measure("db", async () => "row");
        await measure("out", async () => "answer");
      });
    });
    expect(records).toMatchObject(expected);
  });

  test("from inside an Effect program a handler runs", async () => {
    const { records, timing } = recorded(virtualClock().now);
    await servePlain(timing, () =>
      Effect.runPromise(
        Effect.andThen(
          Effect.promise(() => measure("db", async () => "row")),
          Effect.promise(() =>
            servePlain(timing, async () => {
              await measure("db", async () => "row");
              await measure("out", async () => "answer");
            }),
          ),
        ),
      ),
    );
    expect(records).toMatchObject(expected);
  });
});

describe("a wait that settles after its record was emitted is counted in no record", () => {
  test("in a plain async program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    const write = Promise.withResolvers<string>();
    const operation = timing.open();
    let detached: Promise<string> | undefined;
    let later: (() => Promise<string>) | undefined;
    within(operation, () => {
      detached = measure("db", () => write.promise);
      later = () => measure("db", async () => "begun after the close");
    });
    operation.close(ended());
    write.resolve("written");

    expect(await detached).toBe("written");
    expect(await later?.()).toBe("begun after the close");
    expect(records).toMatchObject([{ db: { waitMs: 0, count: 0 } }]);
  });

  test("in a detached fiber of an Effect program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    const operation = timing.open();
    const write = Effect.runSync(Deferred.make<string>());
    const resume = Effect.runSync(Deferred.make<void>());
    const begun = Promise.withResolvers<void>();
    const detached = await within(operation, () =>
      Effect.runPromise(
        Effect.forkDetach(
          Effect.gen(function* () {
            const first = yield* Effect.promise(() =>
              measure("db", () => {
                begun.resolve();
                return Effect.runPromise(Deferred.await(write));
              }),
            );
            yield* Deferred.await(resume);
            const second = yield* Effect.promise(() =>
              measure("db", async () => "begun after the close"),
            );
            return [first, second];
          }),
        ),
      ),
    );
    // The close comes while the first wait is in flight, not before it begins.
    await begun.promise;
    operation.close(ended());
    await Effect.runPromise(Deferred.succeed(write, "written"));
    await Effect.runPromise(Deferred.succeed(resume, undefined));

    expect(await Effect.runPromise(Fiber.join(detached))).toEqual([
      "written",
      "begun after the close",
    ]);
    expect(records).toMatchObject([{ db: { waitMs: 0, count: 0 } }]);
  });
});

describe("work forked outside every operation is in no record", () => {
  /**
   * Two operations, `/a` then `/b`, each handing one job to a worker a layer
   * forks when it is built, and waiting for it done. The worker makes one
   * `store` wait per job. The runtime is built before `/a` opens, or on `/a`'s
   * own first run, as `ManagedRuntime` does when nothing builds it sooner.
   * Answers each record's `store` count.
   */
  const workerWaits = async (built: "before" | "on the first run") => {
    const { records, timing } = recorded(virtualClock().now);
    const Jobs = Context.Service<Queue.Queue<Deferred.Deferred<void>>>("Jobs");
    const runtime = ManagedRuntime.make(
      Layer.effect(
        Jobs,
        Effect.gen(function* () {
          const jobs = yield* Queue.unbounded<Deferred.Deferred<void>>();
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.flatMap(Queue.take(jobs), (done) =>
                Effect.andThen(
                  Effect.promise(() => measure("store", async () => "done")),
                  Deferred.succeed(done, undefined),
                ),
              ),
            ),
          );
          return jobs;
        }),
      ),
    );
    if (built === "before") await runtime.context();
    for (const name of ["/a", "/b"]) {
      const operation = timing.open();
      await within(operation, () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            yield* Queue.offer(yield* Jobs, done);
            yield* Deferred.await(done);
          }),
        ),
      );
      operation.close({ ...ended(), name: OperationName.registered(name) });
    }
    await runtime.dispose();
    return records.map((made) => made.store.count);
  };

  test("so a layer built before the first request forks its worker into none", async () => {
    expect(await workerWaits("before")).toEqual([0, 0]);
  });

  // The case the page tells an app to avoid: the worker is forked inside the
  // first request's fiber, keeps its context, and counts in its record.
  test("and one built on the first request forks it into that request's record", async () => {
    expect(await workerWaits("on the first run")).toEqual([1, 0]);
  });
});

interface Scripted {
  readonly kind: WaitKind;
  readonly from: number;
  readonly to: number;
}

/**
 * Runs `waits` under one operation opened at 0 and closed at `closeAt`, each
 * wait begun at `from` and settled at `to` on the virtual clock, and answers
 * the record and what the clock reads when every wait has settled.
 */
async function timed(waits: readonly Scripted[], closeAt: number) {
  const clock = virtualClock();
  const { records, timing } = recorded(clock.now);
  const operation = timing.open();
  const running = new Map<Scripted, { settle: () => void; done: Promise<unknown> }>();
  const moments = [...new Set([...waits.flatMap((wait) => [wait.from, wait.to]), closeAt])];
  for (const moment of moments.toSorted((a, b) => a - b)) {
    clock.set(moment);
    for (const wait of waits.filter((candidate) => candidate.to === moment)) {
      const started = running.get(wait);
      started?.settle();
      await started?.done;
    }
    for (const wait of waits.filter((candidate) => candidate.from === moment)) {
      const gate = Promise.withResolvers<void>();
      running.set(wait, {
        settle: () => gate.resolve(),
        done: within(operation, () => measure(wait.kind, () => gate.promise)),
      });
    }
    if (moment === closeAt) operation.close(ended());
  }
  return records;
}

describe("a kind's sum is its waits, and the rest is the time no wait was in flight", () => {
  const cases: readonly {
    readonly name: string;
    readonly waits: readonly Scripted[];
    readonly closeAt: number;
    readonly expected: Partial<TimingRecord>;
  }[] = [
    {
      name: "no wait: the rest is the whole",
      waits: [],
      closeAt: 10,
      expected: { totalMs: 10, inFlightMs: 0 },
    },
    {
      name: "sequential waits of one kind",
      waits: [
        { kind: "db", from: 1, to: 4 },
        { kind: "db", from: 5, to: 7 },
      ],
      closeAt: 10,
      expected: { totalMs: 10, inFlightMs: 5, db: { waitMs: 5, count: 2 } },
    },
    {
      name: "parallel waits of one kind sum past the total",
      waits: [
        { kind: "db", from: 1, to: 9 },
        { kind: "db", from: 2, to: 10 },
      ],
      closeAt: 10,
      expected: { totalMs: 10, inFlightMs: 9, db: { waitMs: 16, count: 2 } },
    },
    {
      name: "overlapping waits of two kinds",
      waits: [
        { kind: "db", from: 1, to: 4 },
        { kind: "out", from: 2, to: 6 },
        { kind: "store", from: 8, to: 9 },
      ],
      closeAt: 10,
      expected: {
        totalMs: 10,
        inFlightMs: 6,
        db: { waitMs: 3, count: 1 },
        out: { waitMs: 4, count: 1 },
        store: { waitMs: 1, count: 1 },
      },
    },
    {
      name: "a wait in flight at the close: its time to the close is in flight, and it is in no sum",
      waits: [
        { kind: "db", from: 1, to: 3 },
        { kind: "out", from: 6, to: 15 },
      ],
      closeAt: 10,
      expected: {
        totalMs: 10,
        inFlightMs: 6,
        db: { waitMs: 2, count: 1 },
        out: { waitMs: 0, count: 0 },
      },
    },
  ];
  for (const { name, waits, closeAt, expected } of cases) {
    test(name, async () => {
      const records = await timed(waits, closeAt);
      expect(records).toMatchObject([expected]);
      const [made] = records;
      expect(made?.totalMs).toBeGreaterThanOrEqual(made?.inFlightMs ?? Number.NaN);
    });
  }
});

describe("nothing a person sent reaches a record", () => {
  /** What `registered` threw for `pattern`, or nothing where it took it. */
  const refusal = (pattern: string) => {
    try {
      OperationName.registered(pattern);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  test("a pattern shaped like a URL is refused, in words that quote none of it", () => {
    check(
      property(webPath(), webQueryParameters(), (path, query) => {
        expect(refusal(`${path}?${query}`)).toBe(refusal("/a?b"));
        expect(refusal(`https://shop.example${path}`)).toBe(refusal("https://a"));
      }),
    );
    expect(refusal("/a?b")).toContain("query string");
  });

  const unprintable = [
    "/presets/\u001b[31m:id",
    "/presets/:id\n1     GET     /fake",
    `/${"x".repeat(256)}`,
  ];
  for (const pattern of unprintable) {
    test(`a pattern a log line could not carry is refused: ${JSON.stringify(pattern.slice(0, 24))}`, () => {
      const said = refusal(pattern);
      expect(said).toBeString();
      expect(said).not.toMatch(/\p{C}/u);
      expect(said).not.toContain(pattern);
    });
  }

  test("a method is one of a closed set", () => {
    check(
      property(string(), (written) => {
        expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]).toContain(
          methodOf(written),
        );
      }),
    );
  });

  /**
   * Two runs of one operation that differ in every value a person could have
   * put in a wait, its query text, its parameters, the rows it answered and the
   * error it failed with, close into the same record. A record that is the same
   * whatever those values were cannot hold any of them.
   */
  const customer = record({
    path: webPath(),
    query: webQueryParameters(),
    sql: string(),
    row: string(),
    failure: string(),
  });
  test("the record is the same whatever the waits carried", async () => {
    const run = async (sent: {
      path: string;
      query: string;
      sql: string;
      row: string;
      failure: string;
    }) => {
      const clock = virtualClock();
      const { records, timing } = recorded(clock.now);
      const operation = timing.open();
      await within(operation, async () => {
        await measure("db", async () => [sent.sql, sent.row]);
        await measure("out", () => Promise.reject(new Error(`${sent.path}?${sent.query}`))).catch(
          (error: unknown) => error,
        );
        await measure("store", async () => sent.failure);
      });
      operation.close(ended());
      return JSON.stringify(records);
    };
    await check(
      asyncProperty(customer, customer, async (one, other) => {
        expect(await run(one)).toBe(await run(other));
      }),
    );
  });
});

describe("measure answers what the wait answers", () => {
  const outcomes = [
    { name: "a value", wait: async () => "row", settles: { value: "row" } },
    {
      name: "a rejection",
      wait: () => Promise.reject(new Error("refused")),
      settles: { error: "refused" },
    },
    {
      name: "a synchronous throw",
      wait: (): Promise<string> => {
        throw new Error("thrown");
      },
      settles: { thrown: "thrown" },
    },
  ];
  const settled = async (run: () => Promise<string>) => {
    try {
      const pending = run();
      return await pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : "" }),
      );
    } catch (error) {
      return { thrown: error instanceof Error ? error.message : "" };
    }
  };
  for (const { name, wait, settles } of outcomes) {
    test(`${name}, under an operation and outside one`, async () => {
      const { timing } = recorded(virtualClock().now);
      const operation = timing.open();
      expect(await settled(() => within(operation, () => measure("db", wait)))).toEqual(settles);
      expect(await settled(() => measure("db", wait))).toEqual(settles);
    });
  }
});

describe("finish hands a fault in closing an operation to the app, never to the caller", () => {
  /** Timing whose faults are kept, with a sink that throws while `refusing` says so. */
  function faulted() {
    const faults: unknown[] = [];
    const records: TimingRecord[] = [];
    let refusing = false;
    const timing = requestTiming({
      sink: (made) => {
        if (refusing) throw new Error("the sink refused");
        records.push(made);
      },
      fault: (error) => void faults.push(error),
      now: virtualClock().now,
    });
    return { timing, faults, records, refuse: () => void (refusing = true) };
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  test("a sink that throws", () => {
    const { timing, faults, refuse } = faulted();
    refuse();
    expect(() => timing.finish(timing.open(), () => ended())).not.toThrow();
    expect(faults.map(message)).toEqual(["the sink refused"]);
  });

  test("a name the core refuses when the request ends", () => {
    const { timing, faults, records } = faulted();
    const ending = () => ({ ...ended(), name: OperationName.registered("/presets?id=42") });
    expect(() => timing.finish(timing.open(), ending)).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(faults.map(message).join("\n")).toContain("query string");
    expect(records).toEqual([]);
  });

  test("a status the core refuses, as Response.error() answers", () => {
    const { timing, faults, records } = faulted();
    expect(() => timing.finish(timing.open(), () => ended(Response.error().status))).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(faults.map(message).join("\n")).toContain("not an HTTP status");
    expect(records).toEqual([]);
  });

  test("a second close, while the first record stands", () => {
    const { timing, faults, records } = faulted();
    const operation = timing.open();
    timing.finish(operation, () => ended());
    timing.finish(operation, () => ended());
    expect(faults).toHaveLength(1);
    expect(faults.map(message).join("\n")).toContain("closed twice");
    expect(records).toHaveLength(1);
  });

  test("and a fault function that throws is the app's own error", () => {
    const timing = requestTiming({
      sink: () => undefined,
      fault: () => {
        throw new Error("the app's fault handler failed");
      },
    });
    expect(() => timing.finish(timing.open(), () => ended(0))).toThrow(
      "the app's fault handler failed",
    );
  });

  /**
   * A connector closes in a `then`, after the response. Closing there with
   * `close` and a status the core refuses ends the process on the unhandled
   * rejection; closing with `finish` hands the fault to the app and the
   * process lives on.
   */
  const closingAfterTheResponse = async (closing: string) => {
    const script = [
      `import { OperationName, requestTiming } from ${JSON.stringify(join(import.meta.dir, "..", "request-timing.ts"))};`,
      `const timing = requestTiming({ sink: () => undefined, fault: (error) => console.log("fault:", error.message) });`,
      `const operation = timing.open();`,
      `const ending = () => ({ method: "GET", name: OperationName.registered("/presets/:id"), status: 0, aborted: false, streamed: false });`,
      `void Promise.resolve().then(() => ${closing});`,
      `await new Promise((resolve) => setTimeout(resolve, 0));`,
      `console.log("alive");`,
    ].join("\n");
    const run = Bun.spawn(["bun", "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [said, status] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return { said: said.trim(), status };
  };

  test("so a connector closing in a then keeps the process alive", async () => {
    expect(await closingAfterTheResponse("operation.close(ending())")).toMatchObject({
      status: 1,
    });
    expect(await closingAfterTheResponse("timing.finish(operation, ending)")).toEqual({
      said: "fault: request timing: GET /presets/:id closed with status 0, which is not an HTTP status\nalive",
      status: 0,
    });
  });
});
