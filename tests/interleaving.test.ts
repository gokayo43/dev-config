import { describe, expect, test } from "bun:test";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  HashSet,
  Latch,
  Random,
  Ref,
  Scheduler,
  Semaphore,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { property } from "fast-check";

import {
  type Interleaving,
  interleavings,
  interleavingsOf,
  simulate,
  unpreempted,
} from "../interleaving.ts";
import { check } from "../property.ts";
import { finished } from "./interleaving-fixtures.ts";

const note = (log: string[], step: string) => Effect.sync(() => void log.push(step));

/** Effect's own tracer, which a tracer of a program's own hands its spans to. */
const nativeTracer = Context.get(Context.empty(), Tracer.Tracer);

describe("the order comes from the interleaving and nothing else", () => {
  /**
   * Every way a fiber gives up the runtime: forks, a yield, a deferred handed
   * between fibers, an uninterruptible region and an interrupt. The result is
   * the order each step executed in, then the order a hash set of plain
   * objects iterates in, which Effect hashes with `Math.random`, and a draw
   * from the `Random` service.
   */
  const mesh = Effect.suspend(() => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const a = yield* Effect.forkChild(
        note(log, "a1").pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(note(log, "a2")),
          Effect.andThen(Deferred.succeed(gate, undefined)),
          Effect.andThen(note(log, "a3")),
        ),
      );
      const b = yield* Effect.forkChild(
        Deferred.await(gate).pipe(Effect.andThen(note(log, "b1")), Effect.andThen(note(log, "b2"))),
      );
      const c = yield* Effect.forkChild(
        Effect.uninterruptible(note(log, "c1").pipe(Effect.andThen(note(log, "c2")))).pipe(
          Effect.andThen(note(log, "c3")),
          Effect.andThen(Deferred.await(never)),
        ),
      );
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      yield* Fiber.interrupt(c);
      const hashed = HashSet.fromIterable(log.map((step) => ({ step })));
      const drawn = yield* Random.nextInt;
      return [...log, "|", ...[...hashed].map(({ step }) => step), "|", drawn].join(" ");
    });
  });

  /** `run`, with `Date.now` answering `now` while it runs. */
  function at<A>(now: number, run: () => A): A {
    const { now: realNow } = Date;
    Date.now = () => now;
    try {
      return run();
    } finally {
      Date.now = realNow;
    }
  }

  // Kills a scheduler that reads the clock to decide, one whose order depends
  // on anything a second run does not reproduce, and a run that leaves
  // `Math.random` or the `Random` service drawing from the process's own state.
  // Regression: a hash set of plain objects iterated in a different order on
  // each run of one interleaving, and the `Random` service drew on.
  test("the same interleaving replays the same order and the same randomness, whatever the clock says", () => {
    const orders = new Set<string>();
    check(
      property(interleavings(64), (interleaving) => {
        const first = at(0, () => simulate(mesh, interleaving));
        const second = at(4_102_444_800_000, () => simulate(mesh, interleaving));
        expect(second).toEqual(first);
        orders.add(finished(mesh, interleaving));
      }),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  /**
   * A program whose run throws from inside: Effect calls a fiber's observers
   * after its run loop, outside the loop's own catch, so what one throws
   * leaves the run. Detached before that, a fiber waits on a deferred nobody
   * completes, and logs when it is interrupted.
   */
  const throwsFromInside = (log: string[]) =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      yield* Deferred.await(never).pipe(
        Effect.onInterrupt(() => note(log, "released")),
        Effect.forkDetach,
      );
      const child = yield* Effect.forkChild(Effect.void);
      child.addObserver(() => {
        throw new Error("an observer threw");
      });
      yield* Fiber.join(child);
    });

  // Kills a run that leaves `Math.random` replaced after it. Regression: the
  // run restored it only when it answered, and a throw from inside the run
  // left the seeded generator in its place for the rest of the process; the
  // limit's throw, raised once the run has answered, never reached that.
  test("Math.random is the process's own again once the run ends, and once it throws from inside", () => {
    const { random } = Math;
    simulate(mesh, unpreempted);
    expect(Math.random).toBe(random);
    expect(() => simulate(throwsFromInside([]), unpreempted)).toThrow("an observer threw");
    const replaced = Math.random !== random;
    Math.random = random;
    expect(replaced).toBe(false);
  });

  // Regression: a throw from inside the run skipped the wind-down, so a
  // detached fiber outlived the call and its finalizer never ran.
  test("a run that throws from inside still interrupts its fibers and runs their finalizers", () => {
    const log: string[] = [];
    expect(() => simulate(throwsFromInside(log), unpreempted)).toThrow("an observer threw");
    expect(log).toEqual(["released"]);
  });

  /**
   * A fork's observer throws when the root's flush runs it, out of the flush
   * and into the root's op, which Effect's run loop catches as that op's
   * defect and goes on from. The root then interrupts a fork that has not
   * started, where Effect 4.1.4 loses an interruption.
   */
  const thrownIntoAnOp = Effect.suspend(() => {
    let flushing = false;
    return Effect.gen(function* () {
      const thrower = yield* Effect.forkChild(Effect.void);
      thrower.addObserver(() => {
        if (flushing) throw new Error("an observer threw");
      });
      yield* Effect.exit(
        Effect.sync(() => {
          flushing = true;
          Fiber.getCurrent()?.currentDispatcher.flush();
        }),
      );
      flushing = false;
      yield* Fiber.interrupt(yield* Effect.forkChild(Effect.never));
      return "done";
    });
  });

  // Regression: a task that threw left the run taking the op that flushed it
  // for the task's own, so the interruption that followed was preempted at its
  // first op, where Effect loses it, and the run parked.
  test("a task that throws into the op that flushed it leaves the run's account of that op as it was", () => {
    const { ops } = simulate(thrownIntoAnOp, unpreempted);
    for (let op = 0; op < ops; op++)
      expect(finished(thrownIntoAnOp, { strategy: "walk", preemptAt: [op], picks: [] })).toBe(
        "done",
      );
  });

  const forkThree = Effect.suspend(() => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const fibers = [
        yield* Effect.forkChild(note(log, "x")),
        yield* Effect.forkChild(note(log, "y")),
        yield* Effect.forkChild(note(log, "z")),
      ];
      yield* Fiber.joinAll(fibers);
      return log.join("");
    });
  });
  const everyOrder = ["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"];

  /**
   * Effect queues a fork's first slice on its parent's dispatcher, which runs
   * its tasks first in first out, so the three start in the order they were
   * forked. Preempted at its first op, each child goes on to its own
   * dispatcher, and the walk's picks order those. The picks are the shortest
   * that reach each order with every op preempted.
   */
  // Kills a scheduler that ignores the walk's picks and runs the queue first in
  // first out, which reaches one order, not six; and one that picks among the
  // tasks of one dispatcher, which reaches more than one without a preemption.
  test("the walk's picks reach every order of three fibers once each is preempted at its first op, and no other without", () => {
    const every = Array.from({ length: simulate(forkThree, unpreempted).ops }, (_, op) => op);
    const picks = [
      [],
      [0, 1, 1, 2],
      [1, 0, 1, 1, 2],
      [0, 1, 1, 1, 1, 1, 1, 2],
      [0, 1, 1, 1, 2, 2, 2, 2],
      [0, 1, 1, 1, 2, 2, 2, 2, 1],
    ];
    const orders = picks.map((pick) =>
      finished(forkThree, { strategy: "walk", preemptAt: every, picks: pick }),
    );
    expect(orders.toSorted()).toEqual(everyOrder);
    const unpreemptedOrders = new Set(
      picks.map((pick) => finished(forkThree, { strategy: "walk", preemptAt: [], picks: pick })),
    );
    expect(unpreemptedOrders).toEqual(new Set(["xyz"]));
  });

  /**
   * The root forks a, then yields at `priority`, both tasks on the root's
   * dispatcher. Effect's dispatcher runs a lower priority number first, and
   * first in first out among equals, so with no preemption the root's next
   * step comes before a's at -1 and after it at 0, whatever the picks.
   */
  // Kills a scheduler that orders one dispatcher's tasks by when they were
  // queued alone, and one that picks among them.
  test.each([
    [-1, "r a"],
    [0, "a r"],
  ] as const)(
    "a yield at priority %d on the dispatcher a's start waits on runs it %s",
    (rank, order) => {
      const program = Effect.suspend(() => {
        const log: string[] = [];
        return Effect.gen(function* () {
          const a = yield* Effect.forkChild(note(log, "a"));
          yield* Effect.yieldNowWith(rank);
          yield* note(log, "r");
          yield* Fiber.join(a);
          return log.join(" ");
        });
      });
      for (const picks of [[], [1], [1, 1], [0, 1, 2, 3]])
        expect(finished(program, { strategy: "walk", preemptAt: [], picks })).toBe(order);
    },
  );

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
        const fiber = yield* Effect.forkChild(note(log, "a"));
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

  /**
   * c completes a deferred w waits on, which Effect resumes w inside c's op,
   * before the rest of that op, the `map` after it, runs.
   */
  // Kills a priority strategy that ranks a fiber resumed inside another's op
  // against the queued tasks alone, which lets it run there although the fiber
  // beneath it outranks it.
  test("a fiber resumed inside another's op runs there only when it outranks it", () => {
    const resumedInside = Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const w = yield* Effect.forkChild(
          Deferred.await(gate).pipe(Effect.andThen(note(log, "w"))),
        );
        const c = yield* Effect.forkChild(
          Deferred.succeed(gate, undefined).pipe(Effect.map(() => void log.push("c"))),
        );
        yield* Fiber.joinAll([w, c]);
        return log.join(" ");
      });
    });
    const under = (priorities: number[]) =>
      finished(resumedInside, { strategy: "priority", priorities, changeAt: [] });
    expect(under([0, 50, 10])).toBe("w c");
    expect(under([0, 10, 50])).toBe("c w");
  });

  // Kills a flush that runs nothing, which leaves the forked fiber's step after
  // the root's, and one that runs another dispatcher's tasks too.
  test("a flush of the root's dispatcher runs its tasks there and then, and no other's", () => {
    const flushed = Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        const a = yield* Effect.forkChild(
          note(log, "a1").pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(note(log, "a2"))),
        );
        yield* Effect.sync(() => Fiber.getCurrent()?.currentDispatcher.flush());
        yield* note(log, "r");
        yield* Fiber.join(a);
        return log.join(" ");
      });
    });
    expect(finished(flushed, unpreempted)).toBe("a1 r a2");
  });

  /**
   * Forks whose first slices the root's flush runs inside one op of the
   * root's, which then logs `r`.
   */
  const flushedForks = (names: readonly string[]) =>
    Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        const forks = [];
        for (const name of names) forks.push(yield* Effect.forkChild(note(log, name)));
        yield* Effect.sync(() => {
          Fiber.getCurrent()?.currentDispatcher.flush();
          log.push("r");
        });
        yield* Fiber.joinAll(forks);
        return log.join(" ");
      });
    });

  // Regression: the exclusion of the op where Effect loses an interruption
  // matched every fiber the run had not seen whose first op ran inside another
  // fiber's op, so a fork whose first slice a flush ran there could never be
  // preempted at its first op: no interleaving ran the flushing op on before
  // a, or b before a.
  test.each([
    [["a"], ["a r", "r a"]],
    [
      ["a", "b"],
      ["a b r", "b r a"],
    ],
  ] as const)(
    "forks %p whose first slices a flush runs inside an op can each be preempted at their first op",
    (names, reachable) => {
      const program = flushedForks(names);
      const orders = new Set(
        Array.from({ length: simulate(program, unpreempted).ops }, (_, op) =>
          finished(program, { strategy: "walk", preemptAt: [op], picks: [] }),
        ),
      );
      for (const order of reachable) expect(orders).toContain(order);
    },
  );

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
        const x = yield* Effect.forkChild(
          note(log, "x1").pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Deferred.succeed(handed, undefined)),
            Effect.andThen(note(log, "x2")),
          ),
        );
        const y = yield* Effect.forkChild(
          note(log, "y1").pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(note(log, "y2"))),
        );
        const z = yield* Effect.forkChild(
          Deferred.await(handed).pipe(Effect.andThen(note(log, "z1"))),
        );
        yield* Fiber.joinAll([x, y, z]);
        return log.join(" ");
      });
    });
    expect(
      finished(dropped, { strategy: "priority", priorities: [99, 50, 40, 30], changeAt: [] }),
    ).toBe("x1 y1 z1 x2 y2");
  });

  /**
   * h holds the lock and waits on the gate, x waits on the gate, w waits on
   * the lock when `contended`, and l opens the gate. Opening it and releasing
   * the lock to w each hand the scheduler work for other fibers, which leaves
   * the opener and the releaser where they rank: h, the highest of the
   * three, runs on to its end.
   */
  // Regression: a lock released to a waiter dropped the releaser below every
  // other fiber, as though it had yielded, so x ran before h.
  test("handing a lock or a latch on to waiters is not a yield", () => {
    const handOff = (contended: boolean) =>
      Effect.suspend(() => {
        const log: string[] = [];
        return Effect.gen(function* () {
          const lock = yield* Semaphore.make(1);
          const gate = yield* Latch.make(false);
          const fibers = [
            yield* Effect.forkChild(
              lock
                .withPermits(1)(gate.await)
                .pipe(Effect.andThen(note(log, "h"))),
            ),
            yield* Effect.forkChild(gate.await.pipe(Effect.andThen(note(log, "x")))),
            yield* Effect.forkChild(
              contended ? lock.withPermits(1)(note(log, "w")) : note(log, "w"),
            ),
            yield* Effect.forkChild(note(log, "l").pipe(Effect.andThen(gate.open))),
          ];
          yield* Fiber.joinAll(fibers);
          return log.join(" ");
        });
      });
    const under = (contended: boolean) =>
      finished(handOff(contended), {
        strategy: "priority",
        priorities: [99, 90, 30, 50, 10],
        changeAt: [],
      });
    expect(under(false)).toBe("w l h x");
    expect(under(true)).toBe("l h w x");
  });

  /**
   * The root forks p, then starts c by `start` and waits for both. Over every
   * priority on a grid, c outranking p runs c first, and p outranking c runs
   * p first.
   */
  // Regression: a fiber `Effect.all` started was taken as having yielded at
  // birth, since Effect starts it from a task scheduled under it, so the
  // priority strategy dropped it below every other fiber before its first op
  // and c never ran before p.
  test.each(["fork", "all"] as const)(
    "a fiber started by %s gets the priority it is given",
    (start) => {
      const pair = Effect.suspend(() => {
        const log: string[] = [];
        const steps = (name: string) =>
          note(log, `${name}1`).pipe(Effect.andThen(note(log, `${name}2`)));
        return Effect.gen(function* () {
          const p = yield* Effect.forkChild(steps("p"));
          if (start === "all")
            yield* Effect.all([steps("c"), Effect.void], { concurrency: "unbounded" });
          else yield* Fiber.join(yield* Effect.forkChild(steps("c")));
          yield* Fiber.join(p);
          return log.join(" ");
        });
      });
      const grid = [0, 25, 50, 75, 99];
      const orders = new Set(
        grid.flatMap((root) =>
          grid.flatMap((first) =>
            grid.flatMap((second) =>
              grid.map((third) =>
                finished(pair, {
                  strategy: "priority",
                  priorities: [root, first, second, third],
                  changeAt: [],
                }),
              ),
            ),
          ),
        ),
      );
      expect(orders).toEqual(new Set(["p1 p2 c1 c2", "c1 c2 p1 p2"]));
    },
  );

  // Regression: the seed was the interleaving's JSON, so one written with its
  // fields in another order drew other numbers.
  test("an interleaving written with its fields in another order replays the same randomness", () => {
    const drawn = Random.nextInt.pipe(
      Effect.zipWith(Random.nextInt, (left, right) => [left, right]),
    );
    expect(simulate(drawn, { picks: [3], preemptAt: [1], strategy: "walk" })).toEqual(
      simulate(drawn, { strategy: "walk", preemptAt: [1], picks: [3] }),
    );
  });
});

describe("a preemption can fall between any two ops, and nowhere else", () => {
  /**
   * Unless the runtime asks the scheduler between two steps, no interleaving
   * can land `b` inside `a`'s run of synchronous steps, whether or not that
   * run is an uninterruptible region. Steps joined by `map` run inside one
   * op, and under `Scheduler.PreventSchedulerYield` the runtime
   * asks nothing at all.
   */
  const steps = ["a1", "a2", "a3", "a4"];
  const regions = {
    plain: (log: string[]) =>
      steps.map((step) => note(log, step)).reduce((left, right) => Effect.andThen(left, right)),
    uninterruptible: (log: string[]) => Effect.uninterruptible(regions.plain(log)),
    gen: (log: string[]) =>
      Effect.gen(function* () {
        for (const step of steps) yield* note(log, step);
      }),
    map: (log: string[]) =>
      steps
        .slice(1)
        .reduce(
          (left, step) => left.pipe(Effect.map(() => void log.push(step))),
          note(log, steps[0] ?? ""),
        ),
    preventYield: (log: string[]) =>
      regions.plain(log).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
  };
  const between = (region: keyof typeof regions) =>
    Effect.suspend(() => {
      const log: string[] = [];
      const run = regions[region](log);
      return Effect.gen(function* () {
        const a = yield* Effect.forkChild(run);
        const b = yield* Effect.forkChild(note(log, "b"));
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

  const gaps = [1, 2, 3].map((gap) => [...steps.slice(0, gap), "b", ...steps.slice(gap)].join(" "));
  const reached = (region: keyof typeof regions, strategy: keyof typeof at) =>
    new Set(Array.from({ length: 200 }, (_, op) => finished(between(region), at[strategy](op))));

  test.each([
    ["plain", "walk"],
    ["plain", "priority"],
    ["uninterruptible", "walk"],
    ["uninterruptible", "priority"],
    ["gen", "walk"],
    ["gen", "priority"],
  ] as const)(
    "%s, %s: b runs in every gap between a's synchronous steps under some interleaving",
    (region, strategy) => {
      const orders = reached(region, strategy);
      for (const order of gaps) expect(orders).toContain(order);
    },
  );

  // Kills a scheduler that preempts where Effect's runtime never asks, which
  // produces an order no real run can.
  test.each([
    ["map", "walk"],
    ["map", "priority"],
    ["preventYield", "walk"],
    ["preventYield", "priority"],
  ] as const)("%s, %s: b never runs between a's steps", (region, strategy) => {
    const orders = reached(region, strategy);
    for (const order of gaps) expect(orders).not.toContain(order);
    expect(orders).toContain([...steps, "b"].join(" "));
  });
});

describe("ops", () => {
  const chain = (steps: number) =>
    Array.from({ length: steps }, () => Effect.sync(() => undefined)).reduce(
      (left, right) => Effect.andThen(left, right),
      Effect.void,
    );

  // Kills an `ops` that counts slices or fibers rather than ops, and one that
  // answers a constant.
  test("every synchronous step a program adds adds the same number of ops", () => {
    const lengths = [1, 2, 3, 4, 5, 6].map((steps) => simulate(chain(steps), unpreempted).ops);
    const added = lengths.slice(1).map((length, at) => length - (lengths[at] ?? 0));
    expect(added[0]).toBeGreaterThan(0);
    expect(new Set(added).size).toBe(1);
  });

  // Kills an `ops` shorter or longer than the run the op indices count: the
  // run needs exactly that many, so a limit of one fewer stops it, and a
  // preemption at or past them never happens. A fiber Effect resumes after a
  // preemption runs the op it was stopped before without asking again, so a
  // preemption below them adds none.
  test("a run asks exactly its ops, a preemption adds none, and one at or past them never happens", () => {
    const program = chain(6);
    const alone = simulate(program, unpreempted);
    expect(simulate(program, unpreempted, { maxOps: alone.ops })).toEqual(alone);
    expect(() => simulate(program, unpreempted, { maxOps: alone.ops - 1 })).toThrow(
      `the run did not finish within ${alone.ops - 1} ops`,
    );
    for (let op = 0; op < alone.ops + 5; op++)
      expect(simulate(program, { strategy: "walk", preemptAt: [op], picks: [] })).toEqual(alone);
  });

  // Regression: `ops` counted the wind-down too, which no interleaving reaches,
  // so a program leaving a daemon with a long finalizer sized the search
  // mostly to ops nothing could preempt.
  test("a program that leaves a detached fiber with a long finalizer counts none of the wind-down", () => {
    const leaving = (finalizer: number) =>
      Effect.forkDetach(Effect.never.pipe(Effect.onInterrupt(() => chain(finalizer)))).pipe(
        Effect.asVoid,
      );
    expect(simulate(leaving(1_000), unpreempted).ops).toBe(simulate(leaving(1), unpreempted).ops);
  });
});

describe("how a run ends", () => {
  /** Two fibers taking two locks in opposite orders: whether they deadlock is the interleaving's call. */
  const inversion = (
    hold: (lock: Semaphore.Semaphore, then: Effect.Effect<void>) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const first = yield* Semaphore.make(1);
      const second = yield* Semaphore.make(1);
      const both = (outer: Semaphore.Semaphore, inner: Semaphore.Semaphore) =>
        hold(outer, Effect.yieldNow.pipe(Effect.andThen(hold(inner, Effect.void))));
      const a = yield* Effect.forkChild(both(first, second));
      const b = yield* Effect.forkChild(both(second, first));
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      return "done";
    });

  // Kills a run reported as finished when it parked, and the reverse: the two
  // outcomes are told apart, each by what the program actually did.
  test("a lock-order inversion parks under some interleavings and finishes under others, and says which", () => {
    const program = inversion((lock, then) => lock.withPermits(1)(then));
    const parked = new Set<boolean>();
    check(
      property(interleavingsOf(program), (interleaving) => {
        const run = simulate(program, interleaving);
        parked.add(run.parked);
        if (run.parked) expect(run.stranded).toBe(0);
        else expect(run.exit).toEqual(Exit.succeed("done"));
      }),
    );
    expect(parked).toEqual(new Set([false, true]));
  });

  // Regression: a deadlock on locks taken by an uninterruptible acquire threw
  // instead of parking. Each such park strands its fibers for the life of the
  // process, so the case parks three runs rather than a property's budget.
  test("a lock-order inversion on uninterruptible acquires parks, naming the fibers it strands", () => {
    const program = inversion((lock, then) =>
      Effect.scoped(
        Effect.acquireRelease(lock.take(1), () => lock.release(1)).pipe(Effect.andThen(then)),
      ),
    );
    const stranded: number[] = [];
    for (let op = 0; op < 200 && stranded.length < 3; op++) {
      const run = simulate(program, { strategy: "walk", preemptAt: [op], picks: [] });
      if (run.parked) stranded.push(run.stranded);
    }
    expect(stranded).toEqual([3, 3, 3]);
  });

  test("a program waiting on a deferred nobody completes is parked under every interleaving", () => {
    const stuck = Deferred.make<void>().pipe(Effect.flatMap(Deferred.await));
    check(
      property(interleavingsOf(stuck), (interleaving) => {
        expect(simulate(stuck, interleaving)).toMatchObject({ parked: true, stranded: 0 });
      }),
    );
  });

  const slept = Effect.gen(function* () {
    const sleeper = yield* Effect.forkChild(Effect.sleep("1 second").pipe(Effect.as("woke")));
    yield* TestClock.adjust("1 second");
    return yield* Fiber.join(sleeper);
  }).pipe(Effect.provide(TestClock.layer()));

  // Pins what the page states of TestClock: Effect 4's wakes its sleepers
  // through the scheduler, so it runs inside a run, and an adjust made before
  // the sleep is registered wakes nothing, which some interleaving finds.
  test("a program on TestClock finishes, and parks under an interleaving that adjusts before the sleep", () => {
    expect(finished(slept, unpreempted)).toBe("woke");
    const parked = new Set<boolean>();
    check(
      property(interleavingsOf(slept), (interleaving) => {
        parked.add(simulate(slept, interleaving).parked);
      }),
      { numRuns: 1_000 },
    );
    expect(parked).toEqual(new Set([false, true]));
  });

  /**
   * The sleeper and an adjust made again until it has woken, which no order
   * can park. Every adjust interrupts the warning fiber the sleep starts,
   * sometimes before that fiber's first slice has run.
   */
  const sleptUntilWoken = Effect.gen(function* () {
    const sleeper = yield* Effect.forkChild(Effect.sleep("1 second").pipe(Effect.as("woke")));
    yield* TestClock.adjust("1 second").pipe(
      Effect.repeat({ until: () => sleeper.pollUnsafe() !== undefined }),
    );
    return yield* Fiber.join(sleeper);
  }).pipe(Effect.provide(TestClock.layer()));

  // Regression: simulate preempted the first op of an interruption of a fiber
  // that had not started, where Effect 4.1.4 loses the interruption, and
  // parked this program in 33 of 20 000 interleavings on seed 1. The count is
  // the page's sizing rule for that share. The fiber forked to start at once
  // kills an exclusion wider than that op: its first op, inside the forking
  // op, can still be preempted.
  test("a program on TestClock with no race of its own never parks, and a fiber forked to start at once can still be preempted at its first op", () => {
    check(
      property(interleavingsOf(sleptUntilWoken), (interleaving) => {
        expect(finished(sleptUntilWoken, interleaving)).toBe("woke");
      }),
      { numRuns: 8_400 },
    );
    const atOnce = Effect.suspend(() => {
      const log: string[] = [];
      return Effect.gen(function* () {
        const child = yield* Effect.forkChild(note(log, "c"), { startImmediately: true });
        yield* note(log, "r");
        yield* Fiber.join(child);
        return log.join(" ");
      });
    });
    const orders = new Set(
      Array.from({ length: simulate(atOnce, unpreempted).ops }, (_, op) =>
        finished(atOnce, { strategy: "walk", preemptAt: [op], picks: [] }),
      ),
    );
    expect(orders).toEqual(new Set(["c r", "r c"]));
    // 8 400 runs take about 7 s of CPU, which a 3% share of a core stretches
    // past the suite's 120 s; the bound is the nightly's per-test one, which
    // test-suite's action.yml sets for its longer search.
  }, 600_000);

  const priority: Interleaving = { strategy: "priority", priorities: [], changeAt: [] };

  test.each([
    ["a fiber that loops forever", Effect.forever(Effect.void)],
    [
      "two fibers that yield to each other forever",
      Effect.gen(function* () {
        const spin = Effect.forever(Effect.yieldNow);
        yield* Fiber.joinAll([yield* Effect.forkChild(spin), yield* Effect.forkChild(spin)]);
      }),
    ],
  ] as const)("%s throws rather than hang", (_name, program) => {
    for (const interleaving of [unpreempted, priority])
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
    expect(() => simulate(long, unpreempted)).toThrow("the run did not finish within 100000 ops");
    expect(finished(long, unpreempted, { maxOps: 1_000_000 })).toBe(120_000);
  });

  /** A fiber waiting for another to set a flag, polling it with `poll` between reads. */
  const waiting = (poll: "yield" | "busy") =>
    Effect.gen(function* () {
      const flag = yield* Ref.make(false);
      const read =
        poll === "yield" ? Effect.yieldNow.pipe(Effect.andThen(Ref.get(flag))) : Ref.get(flag);
      const waiter = yield* Effect.forkChild(read.pipe(Effect.repeat({ until: (set) => set })));
      const setter = yield* Effect.forkChild(Ref.set(flag, true));
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
        unpreempted,
        { strategy: "priority", priorities: [50, 99, 10], changeAt: [] } as const,
      ])
        expect(finished(program, interleaving)).toBe("done");
      check(
        property(interleavingsOf(program), (interleaving) => {
          expect(finished(program, interleaving)).toBe("done");
        }),
      );
    },
  );

  const unyielding = Effect.provideService(Scheduler.PreventSchedulerYield, true);

  // Regression: a parked run's fibers were never interrupted, so their
  // finalizers never ran. The unyielding rows kill a wind-down that finds a
  // run's fibers by the scheduler's questions alone, which Effect never asks
  // under `Scheduler.PreventSchedulerYield`.
  test.each([
    [
      "parked",
      false,
      (log: string[]) =>
        Effect.scoped(
          Effect.addFinalizer(() => note(log, "released")).pipe(
            Effect.andThen(Deferred.make<void>()),
            Effect.flatMap(Deferred.await),
          ),
        ),
    ],
    [
      "finished, leaving a daemon waiting",
      false,
      (log: string[]) =>
        Deferred.make<void>().pipe(
          Effect.flatMap(Deferred.await),
          Effect.onInterrupt(() => note(log, "released")),
          Effect.forkDetach,
        ),
    ],
    [
      "finished, leaving a detached fiber waiting with yields prevented",
      false,
      (log: string[]) =>
        Deferred.make<void>().pipe(
          Effect.flatMap(Deferred.await),
          Effect.onInterrupt(() => note(log, "released")),
          Effect.forkDetach,
          unyielding,
        ),
    ],
    [
      "finished, leaving a detached fiber waiting with yields prevented under a tracer of its own",
      false,
      (log: string[]) =>
        Deferred.make<void>().pipe(
          Effect.flatMap(Deferred.await),
          Effect.onInterrupt(() => note(log, "released")),
          Effect.forkDetach,
          unyielding,
          Effect.withTracer(Tracer.make({ span: (options) => nativeTracer.span(options) })),
        ),
    ],
    [
      "parked with yields prevented",
      false,
      (log: string[]) =>
        Effect.scoped(
          Effect.addFinalizer(() => note(log, "released")).pipe(
            Effect.andThen(Deferred.make<void>()),
            Effect.flatMap(Deferred.await),
          ),
        ).pipe(unyielding),
    ],
    [
      "stopped at the limit",
      true,
      (log: string[]) =>
        Effect.forever(Effect.void).pipe(Effect.onInterrupt(() => note(log, "released"))),
    ],
  ] as const)(
    "a run %s leaves nothing behind: its fibers are interrupted and released",
    (_ending, stopped, program) => {
      for (let run = 0; run < 10; run++) {
        const log: string[] = [];
        const simulated = (): void => {
          simulate(program(log), unpreempted, { maxOps: 20_000 });
        };
        if (stopped) expect(simulated).toThrow("did not finish within 20000 ops");
        else expect(simulated).not.toThrow();
        expect(log).toEqual(["released"]);
      }
    },
  );

  const uninterruptibleWait = Deferred.make<void>().pipe(
    Effect.flatMap(Deferred.await),
    Effect.uninterruptible,
  );

  // Kills a watch that puts the run's tracer in place of the program's, which
  // loses the program's spans and its context hook.
  test("a tracer the program provides still makes its spans and sees every op", () => {
    let spans = 0;
    let steps = 0;
    const own = Tracer.make({
      span: (options) => {
        spans += 1;
        return nativeTracer.span(options);
      },
      context: (primitive, fiber) => {
        steps += 1;
        return primitive["~effect/Effect/evaluate"](fiber);
      },
    });
    const program = Effect.gen(function* () {
      yield* Fiber.join(yield* Effect.forkChild(Effect.void.pipe(Effect.withSpan("child"))));
    }).pipe(Effect.withTracer(own));
    expect(finished(program, unpreempted)).toBeUndefined();
    expect(spans).toBe(1);
    expect(steps).toBeGreaterThan(0);
  });

  test("a parked run whose fiber cannot be interrupted out of its wait says it stranded it", () => {
    expect(simulate(uninterruptibleWait, unpreempted)).toMatchObject({
      parked: true,
      stranded: 1,
    });
  });

  test("a finished run that leaves a fiber interruption cannot end fails loudly", () => {
    expect(() => simulate(Effect.forkDetach(uninterruptibleWait), unpreempted)).toThrow(
      "the run finished; 1 of its fibers did not finish when interrupted",
    );
  });

  // Regression: a resolved promise settles on a microtask, after the run; the
  // wake-up it then delivered threw into whatever ran next.
  test("a run parked on a promise ends there: the promise settling afterwards runs nothing", async () => {
    const log: string[] = [];
    const run = simulate(
      Effect.promise(() => Promise.resolve(1)).pipe(Effect.andThen(note(log, "settled"))),
      unpreempted,
    );
    expect(run.parked).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual([]);
  });

  test("a callback fired after the run wakes nothing", () => {
    const log: string[] = [];
    let wake: (effect: Effect.Effect<void>) => void = () => {
      throw new Error("the program never reached its wait");
    };
    const wait = Effect.callback<void>((resume) => {
      wake = resume;
    }).pipe(Effect.andThen(note(log, "woke")));
    expect(simulate(wait, unpreempted).parked).toBe(true);
    wake(Effect.void);
    expect(log).toEqual([]);
  });
});
