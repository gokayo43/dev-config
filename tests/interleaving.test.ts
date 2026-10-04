import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import { check as explore, property } from "fast-check";

import { type Interleaving, interleavings, simulate } from "../interleaving.ts";
import { check } from "../property.ts";
import { booking, counter } from "./interleaving-fixtures.ts";

/**
 * Every program here builds its state inside the effect, so each `simulate`
 * starts from nothing and two runs of one program share no value.
 */

const note = (log: string[], step: string) => Effect.sync(() => void log.push(step));

/** The run's exit value, failing the case when the run did not finish with one. */
function finished<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
  maxOps?: number,
): A {
  const run =
    maxOps === undefined
      ? simulate(program, interleaving)
      : simulate(program, interleaving, { maxOps });
  if (run.parked) throw new Error(`the run parked: ${JSON.stringify(interleaving)}`);
  if (Exit.isFailure(run.exit)) throw new Error(`the run failed: ${String(run.exit.cause)}`);
  return run.exit.value;
}

const fifo: Interleaving = { strategy: "walk", preemptAt: [], picks: [] };

/** The page's sizing rule: the run's length under the interleaving that preempts nothing. */
const sized = <A, E>(program: Effect.Effect<A, E>) => interleavings(simulate(program, fifo).ops);

/** How many fibers Effect holds as roots, which is everything a finished run must not add to. */
const roots = () => Effect.runSync(Fiber.roots).length;

describe("the order comes from the interleaving and nothing else", () => {
  /**
   * Every way a fiber gives up the runtime: forks, a yield, a deferred handed
   * between fibers, an uninterruptible region and an interrupt. The result is
   * the order each step executed in.
   */
  const mesh = Effect.suspend(() => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const a = yield* Effect.fork(
        note(log, "a1").pipe(
          Effect.zipRight(Effect.yieldNow()),
          Effect.zipRight(note(log, "a2")),
          Effect.zipRight(Deferred.succeed(gate, undefined)),
          Effect.zipRight(note(log, "a3")),
        ),
      );
      const b = yield* Effect.fork(
        Deferred.await(gate).pipe(
          Effect.zipRight(note(log, "b1")),
          Effect.zipRight(note(log, "b2")),
        ),
      );
      const c = yield* Effect.fork(
        Effect.uninterruptible(note(log, "c1").pipe(Effect.zipRight(note(log, "c2")))).pipe(
          Effect.zipRight(note(log, "c3")),
          Effect.zipRight(Deferred.await(never)),
        ),
      );
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      yield* Fiber.interrupt(c);
      return log.join(" ");
    });
  });

  /** `run`, with `Date.now` and `Math.random` answering what the case says while it runs. */
  function pinned<A>(now: number, random: number, run: () => A): A {
    const { now: realNow } = Date;
    const { random: realRandom } = Math;
    Date.now = () => now;
    Math.random = () => random;
    try {
      return run();
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  }

  // Kills a scheduler that reads the clock or `Math.random` to decide, and one
  // whose order depends on anything a second run does not reproduce.
  test("the same interleaving replays the same order, whatever the clock and Math.random say", () => {
    const orders = new Set<string>();
    check(
      property(interleavings(64), (interleaving) => {
        const first = pinned(0, 0, () => simulate(mesh, interleaving));
        const second = pinned(4_102_444_800_000, 0.999_999, () => simulate(mesh, interleaving));
        expect(second).toEqual(first);
        orders.add(finished(mesh, interleaving));
      }),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  const forkThree = Effect.suspend(() => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const fibers = [
        yield* Effect.fork(note(log, "x")),
        yield* Effect.fork(note(log, "y")),
        yield* Effect.fork(note(log, "z")),
      ];
      yield* Fiber.joinAll(fibers);
      return log.join("");
    });
  });
  const everyOrder = ["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"];

  // Kills a scheduler that ignores the walk's picks and runs the queue first in
  // first out: without a preemption point that is one order, not six.
  test("the walk's picks alone reach every order of three fibers", () => {
    const picks = [0, 1, 2].flatMap((first) => [0, 1].map((second) => [first, second]));
    const orders = picks.map((pick) =>
      finished(forkThree, { strategy: "walk", preemptAt: [], picks: pick }),
    );
    expect(orders.toSorted()).toEqual(everyOrder);
  });

  // Kills a priority strategy that ignores the priorities it was given.
  test("priorities alone reach every order of three fibers", () => {
    const ranks = [
      [1, 2, 3],
      [1, 3, 2],
      [2, 1, 3],
      [2, 3, 1],
      [3, 1, 2],
      [3, 2, 1],
    ];
    const orders = ranks.map((rank) =>
      finished(forkThree, { strategy: "priority", priorities: [99, ...rank], changeAt: [] }),
    );
    expect(orders.toSorted()).toEqual(everyOrder);
  });

  // Kills a priority strategy that preempts only at its change points: a
  // higher-priority fiber made runnable has to run before the next op of a
  // lower one.
  test("a fiber made runnable with a higher priority runs before the running fiber's next op", () => {
    const forkBetween = Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        yield* note(log, "r1");
        const fiber = yield* Effect.fork(note(log, "a"));
        yield* note(log, "r2");
        yield* Fiber.join(fiber);
        return log.join(" ");
      });
    });
    const under = (priorities: number[]) =>
      finished(forkBetween, { strategy: "priority", priorities, changeAt: [] });
    expect(under([10, 99])).toBe("r1 a r2");
    expect(under([99, 10])).toBe("r1 r2 a");
  });

  // Kills a pick of the last of the highest rather than the first.
  test("fibers of equal priority run first in first out", () => {
    for (const priorities of [[], [5, 5, 5, 5]])
      expect(finished(forkThree, { strategy: "priority", priorities, changeAt: [] })).toBe("xyz");
  });

  /**
   * x and y each yield and so drop below every other fiber, x first. x then
   * hands z a deferred, z outranks x and preempts it, and x goes back on the
   * queue behind y. Dropped later, y sits below x, so x runs first although
   * it is queued second.
   */
  // Kills a drop that puts every dropped fiber at one level, which runs them
  // first in first out, and a priority strategy that ignores a voluntary yield.
  test("a fiber that yields drops below every other, including one that yielded before it", () => {
    const dropped = Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        const handed = yield* Deferred.make<void>();
        const x = yield* Effect.fork(
          note(log, "x1").pipe(
            Effect.zipRight(Effect.yieldNow()),
            Effect.zipRight(Deferred.succeed(handed, undefined)),
            Effect.zipRight(note(log, "x2")),
          ),
        );
        const y = yield* Effect.fork(
          note(log, "y1").pipe(
            Effect.zipRight(Effect.yieldNow()),
            Effect.zipRight(note(log, "y2")),
          ),
        );
        const z = yield* Effect.fork(Deferred.await(handed).pipe(Effect.zipRight(note(log, "z1"))));
        yield* Fiber.joinAll([x, y, z]);
        return log.join(" ");
      });
    });
    expect(
      finished(dropped, { strategy: "priority", priorities: [99, 50, 40, 30], changeAt: [] }),
    ).toBe("x1 y1 z1 x2 y2");
  });
});

describe("a preemption can fall between any two ops", () => {
  /**
   * The canary for an Effect upgrade, over the version this repo pins: unless
   * the runtime asks the scheduler before every op, no interleaving can land
   * `b` inside `a`'s run of synchronous steps.
   */
  const steps = ["a1", "a2", "a3", "a4"];
  const between = (region: "plain" | "uninterruptible") =>
    Effect.suspend(() => {
      const log: string[] = [];
      const run = steps
        .map((step) => note(log, step))
        .reduce((left, right) => Effect.zipRight(left, right));
      return Effect.gen(function* () {
        const a = yield* Effect.fork(region === "plain" ? run : Effect.uninterruptible(run));
        const b = yield* Effect.fork(note(log, "b"));
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        return log.join(" ");
      });
    });

  /** One preemption at `op`: the walk's, and the priority strategy's change point. */
  const at = {
    walk: (op: number): Interleaving => ({ strategy: "walk", preemptAt: [op], picks: [] }),
    priority: (op: number): Interleaving => ({
      strategy: "priority",
      priorities: [99, 50, 10],
      changeAt: [op],
    }),
  };

  test.each([
    ["plain", "walk"],
    ["plain", "priority"],
    ["uninterruptible", "walk"],
    ["uninterruptible", "priority"],
  ] as const)(
    "%s, %s: b runs in every gap between a's synchronous steps under some interleaving",
    (region, strategy) => {
      const reached = new Set(
        Array.from({ length: 200 }, (_, op) => finished(between(region), at[strategy](op))),
      );
      for (const gap of [1, 2, 3]) {
        const order = [...steps.slice(0, gap), "b", ...steps.slice(gap)].join(" ");
        expect(reached).toContain(order);
      }
    },
  );
});

describe("ops", () => {
  const chain = (steps: number) =>
    Array.from({ length: steps }, () => Effect.sync(() => undefined)).reduce(
      (left, right) => Effect.zipRight(left, right),
      Effect.void,
    );

  // Kills an `ops` that counts slices or fibers rather than ops, and one that
  // answers a constant.
  test("every synchronous step a program adds adds the same number of ops", () => {
    const lengths = [1, 2, 3, 4, 5, 6].map((steps) => simulate(chain(steps), fifo).ops);
    const added = lengths.slice(1).map((length, at) => length - (lengths[at] ?? 0));
    expect(added[0]).toBeGreaterThan(0);
    expect(new Set(added).size).toBe(1);
  });

  // Kills an `ops` shorter or longer than the run the op indices count: every
  // index below it is reached, and none at or past it.
  test("a preemption below a run's ops lengthens it, and one at or past them never happens", () => {
    const program = chain(6);
    const unpreempted = simulate(program, fifo);
    for (let op = 0; op < unpreempted.ops; op++)
      expect(
        simulate(program, { strategy: "walk", preemptAt: [op], picks: [] }).ops,
      ).toBeGreaterThan(unpreempted.ops);
    for (let op = unpreempted.ops; op < unpreempted.ops + 5; op++)
      expect(simulate(program, { strategy: "walk", preemptAt: [op], picks: [] })).toEqual(
        unpreempted,
      );
  });
});

describe("how a run ends", () => {
  /** Two fibers taking two locks in opposite orders: whether they deadlock is the interleaving's call. */
  const inversion = Effect.gen(function* () {
    const first = yield* Effect.makeSemaphore(1);
    const second = yield* Effect.makeSemaphore(1);
    const both = (outer: Effect.Semaphore, inner: Effect.Semaphore) =>
      outer.withPermits(1)(
        Effect.yieldNow().pipe(Effect.zipRight(inner.withPermits(1)(Effect.void))),
      );
    const a = yield* Effect.fork(both(first, second));
    const b = yield* Effect.fork(both(second, first));
    yield* Fiber.join(a);
    yield* Fiber.join(b);
    return "done";
  });

  // Kills a run reported as finished when it parked, and the reverse: the two
  // outcomes are told apart, each by what the program actually did.
  test("a lock-order inversion parks under some interleavings and finishes under others, and says which", () => {
    const parked = new Set<boolean>();
    check(
      property(sized(inversion), (interleaving) => {
        const run = simulate(inversion, interleaving);
        parked.add(run.parked);
        if (!run.parked) expect(run.exit).toEqual(Exit.succeed("done"));
      }),
    );
    expect(parked).toEqual(new Set([false, true]));
  });

  test("a program waiting on a deferred nobody completes is parked under every interleaving", () => {
    const stuck = Deferred.make<void>().pipe(Effect.flatMap(Deferred.await));
    check(
      property(sized(stuck), (interleaving) => {
        expect(simulate(stuck, interleaving).parked).toBe(true);
      }),
    );
  });

  const priority: Interleaving = { strategy: "priority", priorities: [], changeAt: [] };

  test.each([
    ["a fiber that loops forever", Effect.forever(Effect.void)],
    [
      "two fibers that yield to each other forever",
      Effect.gen(function* () {
        const spin = Effect.forever(Effect.yieldNow());
        yield* Fiber.joinAll([yield* Effect.fork(spin), yield* Effect.fork(spin)]);
      }),
    ],
  ] as const)("%s throws rather than hang", (_name, program) => {
    for (const interleaving of [fifo, priority])
      expect(() => simulate(program, interleaving, { maxOps: 20_000 })).toThrow(
        "the run did not finish within 20000 ops",
      );
  });

  /** A program that finishes, and needs more ops than the default limit to. */
  const long = Effect.gen(function* () {
    let count = 0;
    for (let step = 0; step < 120_000; step++)
      yield* Effect.sync(() => {
        count += 1;
      });
    return count;
  });

  // Regression: a fixed limit reported a program that finishes as one that
  // loops forever.
  test("a program longer than the default limit finishes under a limit raised to fit it", () => {
    expect(() => simulate(long, fifo)).toThrow("the run did not finish within 100000 ops");
    expect(finished(long, fifo, 1_000_000)).toBe(120_000);
  });

  /** A fiber waiting for another to set a flag, polling it with `poll` between reads. */
  const waiting = (poll: "yield" | "busy") =>
    Effect.gen(function* () {
      const flag = yield* Ref.make(false);
      const read =
        poll === "yield" ? Effect.yieldNow().pipe(Effect.zipRight(Ref.get(flag))) : Ref.get(flag);
      const waiter = yield* Effect.fork(read.pipe(Effect.repeat({ until: (set) => set })));
      const setter = yield* Effect.fork(Ref.set(flag, true));
      yield* Fiber.join(waiter);
      yield* Fiber.join(setter);
      return "done";
    });

  // Regression: the priority strategy ran a yielding waiter above the fiber it
  // waited for, forever; and a fiber that polls without yielding, which
  // Effect's own scheduler yields after a long slice, ran forever under every
  // strategy.
  test.each(["yield", "busy"] as const)(
    "a fiber polling for another (%s) finishes under every interleaving",
    (poll) => {
      const program = waiting(poll);
      for (const interleaving of [
        fifo,
        { strategy: "priority", priorities: [50, 99, 10], changeAt: [] } as const,
      ])
        expect(finished(program, interleaving)).toBe("done");
      check(
        property(sized(program), (interleaving) => {
          expect(finished(program, interleaving)).toBe("done");
        }),
      );
    },
  );

  // Regression: a parked run's fibers stayed among Effect's roots for the life
  // of the process, with everything they held, and their finalizers never ran.
  test.each([
    [
      "parked",
      (log: string[]) =>
        Effect.scoped(
          Effect.addFinalizer(() => note(log, "released")).pipe(
            Effect.zipRight(Deferred.make<void>()),
            Effect.flatMap(Deferred.await),
          ),
        ),
    ],
    [
      "finished, leaving a daemon waiting",
      (log: string[]) =>
        Deferred.make<void>().pipe(
          Effect.flatMap(Deferred.await),
          Effect.onInterrupt(() => note(log, "released")),
          Effect.forkDaemon,
        ),
    ],
    [
      "stopped at the limit",
      (log: string[]) =>
        Effect.forever(Effect.void).pipe(Effect.onInterrupt(() => note(log, "released"))),
    ],
  ] as const)(
    "a run %s leaves nothing behind: its fibers are interrupted and released",
    (_ending, program) => {
      const before = roots();
      for (let run = 0; run < 10; run++) {
        const log: string[] = [];
        try {
          simulate(program(log), fifo, { maxOps: 20_000 });
        } catch (error) {
          expect(String(error)).toContain("did not finish within 20000 ops");
        }
        expect(log).toEqual(["released"]);
      }
      expect(roots()).toBe(before);
    },
  );

  test("a fiber that cannot be interrupted out of its wait fails the run loudly", () => {
    const stuck = Deferred.make<void>().pipe(
      Effect.flatMap(Deferred.await),
      Effect.uninterruptible,
    );
    expect(() => simulate(stuck, fifo)).toThrow("did not finish when interrupted");
  });

  // Regression: a resolved promise settles on a microtask, after the run; the
  // wake-up it then delivered threw into whatever ran next.
  test("a run parked on a promise ends there: the promise settling afterwards runs nothing", async () => {
    const log: string[] = [];
    const before = roots();
    const run = simulate(
      Effect.promise(() => Promise.resolve(1)).pipe(Effect.zipRight(note(log, "settled"))),
      fifo,
    );
    expect(run.parked).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual([]);
    expect(roots()).toBe(before);
  });

  test("a callback fired after the run wakes nothing", () => {
    const log: string[] = [];
    let wake: (effect: Effect.Effect<void>) => void = () => {
      throw new Error("the program never reached its wait");
    };
    const wait = Effect.async<void>((resume) => {
      wake = resume;
    }).pipe(Effect.zipRight(note(log, "woke")));
    expect(simulate(wait, fifo).parked).toBe(true);
    wake(Effect.void);
    expect(log).toEqual([]);
  });
});

describe("finding races", () => {
  /** At least the page's run count for the counter, whose share of failing runs is the lower: docs/exports/interleaving.md. */
  const RUNS = 1_000;

  const fixtures = [
    {
      name: "a check-then-act across a yield",
      program: (fixed: boolean): Effect.Effect<unknown> => booking(fixed),
      holds: (fixed: boolean, interleaving: Interleaving) =>
        expect(finished(booking(fixed), interleaving).sold).toBe(1),
    },
    {
      name: "a lost update between two synchronous ops",
      program: counter,
      holds: (fixed: boolean, interleaving: Interleaving) =>
        expect(finished(counter(fixed), interleaving)).toBe(2),
    },
  ];

  // Kills a scheduler that never preempts or never reorders: each fixture's
  // race is out of reach of the first-in-first-out order.
  test.each(fixtures)(
    "$name: found, and its counterexample replays the race",
    ({ program, holds }) => {
      expect(() => holds(false, fifo)).not.toThrow();
      const details = explore(
        property(sized(program(false)), (interleaving) => holds(false, interleaving)),
        { numRuns: RUNS },
      );
      if (details.counterexample === null) throw new Error(`no race in ${RUNS} runs`);
      const [raced] = details.counterexample;
      expect(() => holds(false, raced)).toThrow("toBe");
    },
  );

  test.each(fixtures)("$name: the fixed version holds over as many runs", ({ program, holds }) => {
    check(
      property(sized(program(true)), (interleaving) => holds(true, interleaving)),
      { numRuns: RUNS },
    );
  });

  /**
   * The page's regression case for a race the search found, run over the
   * booking: one preemption at every op of the unpreempted run, in order, with
   * the seat sold once in each and both bookings in flight at once in at least
   * one. Answers which preemption points broke the invariant.
   */
  function swept(locked: boolean, padding: number): number[] {
    const program = booking(locked, padding);
    const broken: number[] = [];
    let overlapped = 0;
    for (let op = 0; op < simulate(program, fifo).ops; op++) {
      const run = finished(program, { strategy: "walk", preemptAt: [op], picks: [] });
      if (run.sold !== 1) broken.push(op);
      if (run.overlapped) overlapped += 1;
    }
    expect(overlapped).toBeGreaterThan(0);
    return broken;
  }

  const shapes = [
    ["as written", 1],
    ["with one more op", 2],
    ["with one fewer op", 0],
  ] as const;

  test.each(shapes)("the sweep over a racy booking %s finds the race", (_shape, padding) => {
    expect(swept(false, padding)).not.toEqual([]);
  });

  test.each(shapes)(
    "the sweep over a locked booking %s holds, with both bookings in flight at once",
    (_shape, padding) => {
      expect(swept(true, padding)).toEqual([]);
    },
  );
});
