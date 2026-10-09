import { describe, expect, test } from "bun:test";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberStatus,
  HashSet,
  Random,
  Ref,
  TestClock,
  TestContext,
} from "effect";
import { check as explore, property } from "fast-check";

import {
  type Interleaving,
  interleavings,
  interleavingsOf,
  simulate,
  unpreempted,
} from "../interleaving.ts";
import { check } from "../property.ts";
import { covered, depositAndRead, finished, makeLedger, races } from "./interleaving-fixtures.ts";

const note = (log: string[], step: string) => Effect.sync(() => void log.push(step));

/** How many fibers Effect holds as roots, which is everything a finished run must not add to. */
const roots = () => Effect.runSync(Fiber.roots).length;

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

  // Kills a run that leaves `Math.random` replaced after it.
  test("Math.random is the process's own again once the run ends", () => {
    const { random } = Math;
    simulate(mesh, unpreempted);
    expect(Math.random).toBe(random);
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
          const lock = yield* Effect.makeSemaphore(1);
          const gate = yield* Effect.makeLatch(false);
          const fibers = [
            yield* Effect.fork(
              lock
                .withPermits(1)(gate.await)
                .pipe(Effect.zipRight(note(log, "h"))),
            ),
            yield* Effect.fork(gate.await.pipe(Effect.zipRight(note(log, "x")))),
            yield* Effect.fork(contended ? lock.withPermits(1)(note(log, "w")) : note(log, "w")),
            yield* Effect.fork(note(log, "l").pipe(Effect.zipRight(gate.open))),
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
});

describe("a preemption can fall between any two ops", () => {
  /**
   * Unless the runtime asks the scheduler before every op, no interleaving can
   * land `b` inside `a`'s run of synchronous steps, whether or not that run is
   * an uninterruptible region.
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
    const lengths = [1, 2, 3, 4, 5, 6].map((steps) => simulate(chain(steps), unpreempted).ops);
    const added = lengths.slice(1).map((length, at) => length - (lengths[at] ?? 0));
    expect(added[0]).toBeGreaterThan(0);
    expect(new Set(added).size).toBe(1);
  });

  // Kills an `ops` shorter or longer than the run the op indices count: every
  // index below it is reached, and none at or past it.
  // Regression: `ops` counted the wind-down too, which no interleaving reaches,
  // so a program leaving a daemon with a long finalizer sized the search
  // mostly to ops nothing could preempt.
  test.each([
    ["a chain of synchronous steps", chain(6)],
    [
      "a program that leaves a daemon with a long finalizer",
      Effect.forkDaemon(Effect.never.pipe(Effect.onInterrupt(() => chain(1_000)))).pipe(
        Effect.asVoid,
      ),
    ],
  ] as const)(
    "%s: a preemption below its ops lengthens the run, and one at or past them never happens",
    (_name, program) => {
      const alone = simulate(program, unpreempted);
      for (let op = 0; op < alone.ops; op++)
        expect(
          simulate(program, { strategy: "walk", preemptAt: [op], picks: [] }).ops,
        ).toBeGreaterThan(alone.ops);
      for (let op = alone.ops; op < alone.ops + 5; op++)
        expect(simulate(program, { strategy: "walk", preemptAt: [op], picks: [] })).toEqual(alone);
    },
  );
});

describe("how a run ends", () => {
  /** Two fibers taking two locks in opposite orders: whether they deadlock is the interleaving's call. */
  const inversion = (
    hold: (lock: Effect.Semaphore, then: Effect.Effect<void>) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const first = yield* Effect.makeSemaphore(1);
      const second = yield* Effect.makeSemaphore(1);
      const both = (outer: Effect.Semaphore, inner: Effect.Semaphore) =>
        hold(outer, Effect.yieldNow().pipe(Effect.zipRight(hold(inner, Effect.void))));
      const a = yield* Effect.fork(both(first, second));
      const b = yield* Effect.fork(both(second, first));
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
  // instead of parking.
  test("a lock-order inversion on uninterruptible acquires parks, naming the fibers it strands", () => {
    const program = inversion((lock, then) =>
      Effect.scoped(
        Effect.acquireRelease(lock.take(1), () => lock.release(1)).pipe(Effect.zipRight(then)),
      ),
    );
    const stranded = new Set<number>();
    check(
      property(interleavingsOf(program), (interleaving) => {
        const run = simulate(program, interleaving);
        if (run.parked) stranded.add(run.stranded);
        else expect(run.exit).toEqual(Exit.succeed("done"));
      }),
    );
    expect(stranded.size).toBeGreaterThan(0);
    expect([...stranded]).not.toContain(0);
  });

  test("a program waiting on a deferred nobody completes is parked under every interleaving", () => {
    const stuck = Deferred.make<void>().pipe(Effect.flatMap(Deferred.await));
    check(
      property(interleavingsOf(stuck), (interleaving) => {
        expect(simulate(stuck, interleaving)).toMatchObject({ parked: true, stranded: 0 });
      }),
    );
  });

  // Pins a limit the page states: TestClock waits on a real timer between
  // adjusting the clock and running what it woke.
  test("a program on TestClock parks", () => {
    const slept = Effect.gen(function* () {
      const sleeper = yield* Effect.fork(Effect.sleep("1 second"));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(sleeper);
    }).pipe(Effect.provide(TestContext.TestContext));
    expect(simulate(slept, unpreempted)).toMatchObject({ parked: true, stranded: 0 });
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
          simulate(program(log), unpreempted, { maxOps: 20_000 });
        } catch (error) {
          expect(String(error)).toContain("did not finish within 20000 ops");
        }
        expect(log).toEqual(["released"]);
      }
      expect(roots()).toBe(before);
    },
  );

  const uninterruptibleWait = Deferred.make<void>().pipe(
    Effect.flatMap(Deferred.await),
    Effect.uninterruptible,
  );

  test("a parked run whose fiber cannot be interrupted out of its wait says it stranded it", () => {
    expect(simulate(uninterruptibleWait, unpreempted)).toMatchObject({
      parked: true,
      stranded: 1,
    });
  });

  test("a finished run that leaves a fiber interruption cannot end fails loudly", () => {
    expect(() => simulate(Effect.forkDaemon(uninterruptibleWait), unpreempted)).toThrow(
      "the run finished; 1 of its fibers did not finish when interrupted",
    );
  });

  // Regression: a resolved promise settles on a microtask, after the run; the
  // wake-up it then delivered threw into whatever ran next.
  test("a run parked on a promise ends there: the promise settling afterwards runs nothing", async () => {
    const log: string[] = [];
    const before = roots();
    const run = simulate(
      Effect.promise(() => Promise.resolve(1)).pipe(Effect.zipRight(note(log, "settled"))),
      unpreempted,
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
    expect(simulate(wait, unpreempted).parked).toBe(true);
    wake(Effect.void);
    expect(log).toEqual([]);
  });
});

describe("finding races", () => {
  /** The page's run count for the torn read, whose share of failing runs is the lowest: docs/exports/interleaving.md. */
  const RUNS = 3_000;

  // Kills a scheduler that never preempts or never reorders: each fixture's
  // race is out of reach of the first-in-first-out order.
  test.each(races)("$name: found, and its counterexample replays the race", (race) => {
    expect(race.holds(false, unpreempted)).toBe(true);
    const details = explore(
      property(interleavings(race.ops(false)), (interleaving) => {
        expect(race.holds(false, interleaving)).toBe(true);
      }),
      { numRuns: RUNS },
    );
    if (details.counterexample === null) throw new Error(`no race in ${RUNS} runs`);
    const [raced] = details.counterexample;
    expect(race.holds(false, raced)).toBe(false);
  });

  test.each(races)("$name: the fixed version holds over as many runs", (race) => {
    check(
      property(interleavings(race.ops(true)), (interleaving) => {
        expect(race.holds(true, interleaving)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  // The page's reading of a counterexample: the steps it ran, in order, are
  // where the regression case puts its latch.
  test("the torn read's counterexample runs a whole deposit between the reading's two reads", () => {
    const details = explore(
      property(interleavingsOf(depositAndRead(false)), (interleaving) => {
        expect(covered(finished(depositAndRead(false), interleaving))).toBe(true);
      }),
      { numRuns: RUNS },
    );
    if (details.counterexample === null) throw new Error(`no race in ${RUNS} runs`);
    const [raced] = details.counterexample;
    expect(finished(depositAndRead(false), raced).steps).toEqual([
      "read balance",
      "credit",
      "append",
      "read entries",
    ]);
  });

  /**
   * The page's regression case for the torn read: the reading is held at the
   * seam between its two reads, the deposit runs until it has finished or is
   * waiting, and the reading is let go. Answers what the reading saw, and
   * whether the deposit had finished, rather than waiting, when the reading
   * was let go.
   */
  const probe = (locked: boolean) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ledger = yield* makeLedger(
        locked,
        Deferred.succeed(held, undefined).pipe(Effect.zipRight(Deferred.await(release))),
      );
      const reading = yield* Effect.fork(ledger.read);
      yield* Deferred.await(held);
      const deposit = yield* Effect.fork(ledger.deposit);
      const settled = yield* Fiber.status(deposit).pipe(
        Effect.repeat({ until: (status) => !FiberStatus.isRunning(status) }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(deposit);
      return { read: yield* Fiber.join(reading), depositDone: FiberStatus.isDone(settled) };
    });

  test("the probe drives the torn read: a whole deposit between the reading's reads", async () => {
    const { read, depositDone } = await Effect.runPromise(probe(false));
    expect(depositDone).toBe(true);
    expect(covered(read)).toBe(false);
  });

  test("the probe holds the locked ledger, with the deposit waiting on the reading", async () => {
    const { read, depositDone } = await Effect.runPromise(probe(true));
    expect(depositDone).toBe(false);
    expect(covered(read)).toBe(true);
  });
});
