import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import { check as explore, property } from "fast-check";

import { type Interleaving, interleavings, simulate } from "../interleaving.ts";
import { check } from "../property.ts";

/**
 * Every program here builds its state inside the effect, so each `simulate`
 * starts from nothing and two runs of one program share no value.
 */

const note = (log: string[], step: string) => Effect.sync(() => void log.push(step));

/** The run's exit value, failing the case when the run did not finish with one. */
function finished<A, E>(program: Effect.Effect<A, E>, interleaving: Interleaving): A {
  const run = simulate(program, interleaving);
  if (run.parked) throw new Error(`the run parked: ${JSON.stringify(interleaving)}`);
  if (Exit.isFailure(run.exit)) throw new Error(`the run failed: ${String(run.exit.cause)}`);
  return run.exit.value;
}

const fifo: Interleaving = { strategy: "walk", preemptAt: [], picks: [] };

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
});

describe("a preemption can fall between any two ops", () => {
  /**
   * The canary for an Effect upgrade. Everything this module finds rests on the
   * runtime asking the scheduler before every op, which Effect 3.22 does from
   * its run loop. If a release stops asking, or asks only at yields and forks,
   * no interleaving can land `b` inside `a`'s run of synchronous steps.
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
      property(interleavings(128), (interleaving) => {
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
      property(interleavings(32), (interleaving) => {
        expect(simulate(stuck, interleaving).parked).toBe(true);
      }),
    );
  });

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
    for (const interleaving of [
      fifo,
      { strategy: "priority", priorities: [], changeAt: [] } as const,
    ])
      expect(() => simulate(program, interleaving)).toThrow("100000 ops without finishing");
  });

  // Kills a simulator that hands a late wake-up to some other scheduler, which
  // would run the rest of the program after `simulate` had already answered.
  test.each([
    ["parked", true],
    ["finished", false],
  ] as const)(
    "a %s run's fiber woken afterwards throws, and nothing of the program runs again",
    (_ending, parked) => {
      const log: string[] = [];
      let wake: (effect: Effect.Effect<void>) => void = () => {
        throw new Error("the program never reached its wait");
      };
      const wait = Effect.async<void>((resume) => {
        wake = resume;
      }).pipe(Effect.zipRight(note(log, "woke")));
      const program = parked ? wait : Effect.forkDaemon(wait);
      expect(simulate(program, fifo).parked).toBe(parked);
      expect(() => wake(Effect.void)).toThrow("woke after simulate returned");
      expect(log).toEqual([]);
    },
  );
});

describe("finding races", () => {
  /**
   * How many generated interleavings each fixture is searched over, on a fresh
   * seed every run. Measured with `interleavings(64)` on 2026-10-04: the
   * counter's race fails 1.8% of runs, the booking's 14%, so 1 000 runs miss
   * the counter's with probability 0.982^1000, about 1e-8.
   */
  const RUNS = 1_000;

  /**
   * A check-then-act across a yield: two bookings of the last seat, the second
   * arriving two scheduling steps after the first. Run first in first out,
   * the first has written before the second reads.
   */
  const booking = (locked: boolean) =>
    Effect.gen(function* () {
      const seats = yield* Ref.make(1);
      const lock = yield* Effect.makeSemaphore(1);
      const attempt = Effect.gen(function* () {
        const left = yield* Ref.get(seats);
        if (left === 0) return 0;
        yield* Effect.yieldNow();
        yield* Ref.set(seats, left - 1);
        return 1;
      });
      const book = locked ? lock.withPermits(1)(attempt) : attempt;
      const early = yield* Effect.fork(book);
      const late = yield* Effect.fork(
        Effect.yieldNow().pipe(Effect.zipRight(Effect.yieldNow()), Effect.zipRight(book)),
      );
      return (yield* Fiber.join(early)) + (yield* Fiber.join(late));
    });

  /**
   * A read and a write of one counter as two synchronous steps, with nothing
   * between them a test could wrap: only a preemption at the op boundary
   * reaches it.
   */
  const counter = (atomic: boolean) =>
    Effect.suspend(() => {
      let hits = 0;
      const bump = atomic
        ? Effect.sync(() => {
            hits += 1;
          })
        : Effect.sync(() => hits).pipe(
            Effect.flatMap((seen) =>
              Effect.sync(() => {
                hits = seen + 1;
              }),
            ),
          );
      return Effect.gen(function* () {
        yield* Fiber.joinAll([yield* Effect.fork(bump), yield* Effect.fork(bump)]);
        return hits;
      });
    });

  const fixtures = [
    {
      name: "a check-then-act across a yield",
      program: booking,
      holds: (booked: number) => expect(booked).toBe(1),
    },
    {
      name: "a lost update between two synchronous ops",
      program: counter,
      holds: (hits: number) => expect(hits).toBe(2),
    },
  ];

  // Kills a scheduler that never preempts or never reorders: each fixture's
  // race is out of reach of the first-in-first-out order.
  test.each(fixtures)(
    "$name: found, and its counterexample replays the race",
    ({ program, holds }) => {
      expect(() => holds(finished(program(false), fifo))).not.toThrow();
      const details = explore(
        property(interleavings(64), (interleaving) =>
          holds(finished(program(false), interleaving)),
        ),
        { numRuns: RUNS },
      );
      if (details.counterexample === null) throw new Error(`no race in ${RUNS} runs`);
      const raced = finished(program(false), details.counterexample[0]);
      expect(() => holds(raced)).toThrow();
    },
  );

  test.each(fixtures)("$name: the fixed version holds over as many runs", ({ program, holds }) => {
    check(
      property(interleavings(64), (interleaving) => holds(finished(program(true), interleaving))),
      { numRuns: RUNS },
    );
  });
});
