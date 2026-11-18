/**
 * The operation and its record, through both carriers: the record's fields
 * (invariant 6's list), sealing at emission (invariant 4), sums against the
 * rest on a virtual clock (invariant 5), and that nothing a customer sent can
 * reach a record (invariant 6). Attribution under overlap, invariant 3, is
 * `request-timing-attribution.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { asyncProperty, property, record, string, webPath, webQueryParameters } from "fast-check";

import { check } from "../property.ts";
import * as effectCarrier from "../request-timing-effect.ts";
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
  return { records, timing: requestTiming({ sink: (made) => void records.push(made), now }) };
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

  test("in an Effect program", async () => {
    const clock = virtualClock();
    const { records, timing } = recorded(clock.now);
    const operation = timing.open();
    await Effect.runPromise(
      effectCarrier.within(
        operation,
        Effect.gen(function* () {
          yield* effectCarrier.measure("db", Effect.succeed("row"));
          yield* effectCarrier.measure("out", Effect.succeed("answer"));
          // A wait in a fiber the handler forks is the handler's.
          yield* Fiber.join(yield* Effect.fork(effectCarrier.measure("db", Effect.succeed("row"))));
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

  /** The same connector in the Effect carrier. */
  const serveEffect = <A>(timing: Timing, handler: Effect.Effect<A>): Effect.Effect<A> =>
    Effect.flatMap(effectCarrier.inOperation, (inside) => {
      if (inside) return handler;
      return Effect.suspend(() => {
        const operation = timing.open();
        return Effect.ensuring(
          effectCarrier.within(operation, handler),
          Effect.sync(() => operation.close(ended())),
        );
      });
    });

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

  test("in an Effect program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    await Effect.runPromise(
      serveEffect(
        timing,
        Effect.zipRight(
          effectCarrier.measure("db", Effect.succeed("row")),
          serveEffect(
            timing,
            Effect.zipRight(
              effectCarrier.measure("db", Effect.succeed("row")),
              effectCarrier.measure("out", Effect.succeed("answer")),
            ),
          ),
        ),
      ),
    );
    expect(records).toMatchObject(expected);
  });

  test("across the crossing from a plain handler into an Effect program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    await servePlain(timing, async () => {
      await measure("db", async () => "row");
      await Effect.runPromise(
        effectCarrier.carryOperation(
          serveEffect(
            timing,
            Effect.zipRight(
              effectCarrier.measure("db", Effect.succeed("row")),
              effectCarrier.measure("out", Effect.succeed("answer")),
            ),
          ),
        ),
      );
    });
    expect(records).toMatchObject(expected);
  });

  test("and the crossing changes nothing where no operation is current", async () => {
    const { records } = recorded(virtualClock().now);
    const program = effectCarrier.measure("db", Effect.succeed("row"));
    expect(effectCarrier.carryOperation(program)).toBe(program);
    expect(await Effect.runPromise(effectCarrier.carryOperation(effectCarrier.inOperation))).toBe(
      false,
    );
    expect(records).toEqual([]);
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

  test("in an Effect program", async () => {
    const { records, timing } = recorded(virtualClock().now);
    const operation = timing.open();
    const write = Effect.runSync(Deferred.make<string>());
    const resume = Effect.runSync(Deferred.make<void>());
    const detached = await Effect.runPromise(
      effectCarrier.within(
        operation,
        Effect.forkDaemon(
          Effect.gen(function* () {
            const first = yield* effectCarrier.measure("db", Deferred.await(write));
            yield* Deferred.await(resume);
            const second = yield* effectCarrier.measure(
              "db",
              Effect.succeed("begun after the close"),
            );
            return [first, second];
          }),
        ),
      ),
    );
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

describe("nothing a customer sent reaches a record", () => {
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
   * Two runs of one operation that differ in every value a customer could have
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

describe("the way back out to plain code behaves as Effect.tryPromise does", () => {
  const refused = new Error("refused");
  const thrown = new Error("thrown");
  const thunks: readonly { readonly name: string; readonly thunk: () => Promise<string> }[] = [
    { name: "a value", thunk: async () => "row" },
    { name: "a rejection", thunk: () => Promise.reject(refused) },
    {
      name: "a synchronous throw",
      thunk: () => {
        throw thrown;
      },
    },
  ];
  const mapped = (error: unknown) => ({ mapped: error });
  for (const { name, thunk } of thunks) {
    test(`${name}, bare and with a catch`, async () => {
      expect(await Effect.runPromiseExit(effectCarrier.tryPromiseCarried(thunk))).toEqual(
        await Effect.runPromiseExit(Effect.tryPromise(thunk)),
      );
      expect(
        await Effect.runPromiseExit(effectCarrier.tryPromiseCarried({ try: thunk, catch: mapped })),
      ).toEqual(await Effect.runPromiseExit(Effect.tryPromise({ try: thunk, catch: mapped })));
    });
  }

  /**
   * Interrupts a fiber while the thunk it handed out is pending, under an
   * operation that is closed once the fiber has ended. The thunk calls out once
   * before the close, holds a query open across it, and makes one more after. Answers how the fiber ended, whether the thunk saw its signal
   * aborted, and the records.
   */
  const interrupted = async (
    run: (
      thunk: (signal: AbortSignal) => Promise<void>,
    ) => Effect.Effect<void, Cause.UnknownException>,
  ) => {
    const { records, timing } = recorded(virtualClock().now);
    const operation = timing.open();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let seen: AbortSignal | undefined;
    const finished = Promise.withResolvers<void>();
    const thunk = async (signal: AbortSignal) => {
      seen = signal;
      await measure("out", async () => "before the close");
      const pending = measure("db", () => gate.promise);
      started.resolve();
      await pending;
      await measure("db", async () => "after the close");
      finished.resolve();
    };
    const fiber = Effect.runFork(effectCarrier.within(operation, run(thunk)));
    await started.promise;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    operation.close(ended());
    gate.resolve();
    await finished.promise;
    return { interrupted: Exit.isInterrupted(exit), aborted: seen?.aborted, records };
  };

  test("an interruption while the thunk is pending, whose waits follow the seal", async () => {
    const carried = await interrupted((thunk) => effectCarrier.tryPromiseCarried(thunk));
    const { records, ...ending } = await interrupted((thunk) => Effect.tryPromise(thunk));
    expect({ interrupted: carried.interrupted, aborted: carried.aborted }).toEqual(ending);
    expect(ending).toEqual({ interrupted: true, aborted: true });
    expect(carried.records).toMatchObject([
      { out: { waitMs: 0, count: 1 }, db: { waitMs: 0, count: 0 } },
    ]);
    expect(records).toHaveLength(1);
  });
});
