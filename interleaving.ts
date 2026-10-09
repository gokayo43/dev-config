import {
  Context,
  DefaultServices,
  Effect,
  Exit,
  Fiber,
  FiberId,
  FiberRef,
  FiberRefs,
  Hash,
  Random,
  type Scheduler,
  Utils,
} from "effect";
import { type Arbitrary, array, constant, nat, oneof, record, uniqueArray } from "fast-check";

/**
 * The decisions one run of a program is scheduled by, as plain data: fast-check
 * generates it, prints it in a counterexample and shrinks it like any other
 * value.
 *
 * An op index counts every op the run executes, across all its fibers, from 0.
 * `walk` preempts the running fiber before each op in `preemptAt`, and picks
 * the next fiber to run by `picks`, an index into the runnable queue taken
 * modulo its length, first in first out once they run out. `priority` gives
 * each fiber a priority in the order the run first meets it, always runs the
 * highest, first in first out among equals, and drops a fiber below every
 * other when it yields of its own accord and at each op in `changeAt`. Tasks
 * the runtime schedules for no fiber, such as a Mailbox handing on to its next
 * taker, share one priority.
 */
export type Interleaving =
  | {
      readonly strategy: "walk";
      readonly preemptAt: readonly number[];
      readonly picks: readonly number[];
    }
  | {
      readonly strategy: "priority";
      readonly priorities: readonly number[];
      readonly changeAt: readonly number[];
    };

/**
 * How a simulated run ended, and how many ops it executed before it was wound
 * down. A parked run is one whose every fiber was waiting with the program
 * unfinished, which no further scheduling can change. `stranded` counts the
 * fibers of a parked run that the wind-down could not end, which stay alive
 * for the life of the process.
 */
export type Simulated<A, E> =
  | { readonly parked: false; readonly exit: Exit.Exit<A, E>; readonly ops: number }
  | { readonly parked: true; readonly ops: number; readonly stranded: number };

/** How many ops a run may execute before `simulate` gives up on it finishing. */
export interface Limits {
  readonly maxOps: number;
}

/** Preempts nothing and picks first in first out: the order a run takes when nothing intervenes. */
export const unpreempted: Interleaving = { strategy: "walk", preemptAt: [], picks: [] };

/**
 * Every interleaving of a program whose run takes `ops` ops when nothing
 * preempts it: the op indices it preempts or drops a priority at are drawn
 * below `ops`. The priority strategy is PCT (Burckhardt et al., ASPLOS 2010)
 * with ties allowed.
 */
export function interleavings(ops: number): Arbitrary<Interleaving> {
  const op = nat({ max: ops - 1 });
  // The 60 preemptions and 24 priorities are the values the table on the
  // export's page was measured with, by tests/interleaving-measure.ts. Three
  // change points reach every bug of depth up to 4 (Burckhardt et al.).
  // Priorities over 0 to 99 tie for two fibers once in a hundred, and shrink
  // towards all equal, which is first in first out.
  return oneof(
    record({
      strategy: constant("walk" as const),
      preemptAt: uniqueArray(op, { maxLength: 60, size: "max" }),
      picks: array(nat(), { maxLength: 60, size: "max" }),
    }),
    record({
      strategy: constant("priority" as const),
      priorities: array(nat({ max: 99 }), { maxLength: 24, size: "max" }),
      changeAt: uniqueArray(op, { maxLength: 3 }),
    }),
  );
}

/** `interleavings` sized to `program`'s run under `unpreempted`. */
export function interleavingsOf<A, E>(
  program: Effect.Effect<A, E>,
  limits?: Limits,
): Arbitrary<Interleaving> {
  return interleavings(simulate(program, unpreempted, limits).ops);
}

type AnyFiber = Fiber.RuntimeFiber<unknown, unknown>;

interface Task {
  readonly run: () => void;
  readonly fiber: AnyFiber | undefined;
}

interface Strategy {
  /**
   * Which queued task runs next, as an index into `queue`. Asked only when more
   * than one is queued, so a pick is spent on a real choice.
   */
  readonly next: (queue: readonly Task[]) => number;
  /** Whether `fiber` gives way before global op `op`. */
  readonly preempt: (fiber: AnyFiber, op: number, queue: readonly Task[]) => boolean;
  /** `fiber` gave way of its own accord: a yield, or the runtime's own after a long slice. */
  readonly yielded: (fiber: AnyFiber) => void;
}

function walk(preemptAt: readonly number[], picks: readonly number[]): Strategy {
  const at = new Set(preemptAt);
  let picked = 0;
  return {
    next: (queue) => (picks[picked++] ?? 0) % queue.length,
    preempt: (_fiber, op) => at.has(op),
    yielded: () => undefined,
  };
}

function priority(priorities: readonly number[], changeAt: readonly number[]): Strategy {
  const at = new Set(changeAt);
  const held = new Map<AnyFiber | undefined, number>();
  let dropped = 0;
  const of = (fiber: AnyFiber | undefined): number => {
    const known = held.get(fiber);
    if (known !== undefined) return known;
    const given = priorities[held.size] ?? 0;
    held.set(fiber, given);
    return given;
  };
  const drop = (fiber: AnyFiber) => {
    dropped += 1;
    held.set(fiber, -dropped);
  };
  return {
    next: (queue) => {
      const ranks = queue.map((task) => of(task.fiber));
      return ranks.indexOf(Math.max(...ranks));
    },
    preempt: (fiber, op, queue) => {
      if (at.has(op)) {
        drop(fiber);
        return true;
      }
      const mine = of(fiber);
      return queue.some((task) => of(task.fiber) > mine);
    },
    // Without this, a fiber waiting for another by yielding outranks it forever.
    yielded: drop,
  };
}

const strategyOf = (interleaving: Interleaving): Strategy =>
  interleaving.strategy === "walk"
    ? walk(interleaving.preemptAt, interleaving.picks)
    : priority(interleaving.priorities, interleaving.changeAt);

/**
 * Whether `task` is `fiber` going on with its own work. Effect 3.22 schedules a
 * fiber's continuation as the fiber's `run`, which its public type does not
 * declare, and schedules other work under a fiber too: a semaphore release
 * waking its waiters, and the task `Effect.all` starts a child from.
 * `verifyRuntime` checks both.
 */
const continues = (fiber: AnyFiber, task: () => void): boolean =>
  "run" in fiber && fiber.run === task;

/** Gives way nowhere, picks first in first out, and records nothing. */
const inert: Strategy = { next: () => 0, preempt: () => false, yielded: () => undefined };

/** What one drain did: whether it left no task queued, and how many ops it executed. */
interface Drained {
  readonly emptied: boolean;
  readonly ops: number;
}

/** The state of one run: its fibers, the tasks queued for them, and the task running now. */
class Run {
  readonly fibers = new Set<AnyFiber>();
  #queue: Task[] = [];
  #strategy = inert;
  #ops = 0;
  #end = 0;
  #current: Task | undefined;
  #slice = 0;
  #preempted = false;

  readonly scheduler: Scheduler.Scheduler = {
    scheduleTask: (run, _priority, fiber) => {
      if (fiber !== undefined) {
        this.fibers.add(fiber);
        if (!this.#preempted && this.#current?.run === run && continues(fiber, run))
          this.#strategy.yielded(fiber);
      }
      this.#queue.push({ run, fiber });
    },
    shouldYield: (fiber) => {
      if (this.#ops >= this.#end) {
        this.#preempted = true;
        return 0;
      }
      this.#slice += 1;
      this.#preempted = this.#strategy.preempt(fiber, this.#ops++, this.#queue);
      return this.#preempted || this.#slice > fiber.getFiberRef(FiberRef.currentMaxOpsBeforeYield)
        ? 0
        : false;
    },
  };

  /**
   * Runs queued tasks in the order `strategy` decides, its op indices counted
   * from 0, until none is left or `budget` ops have executed.
   */
  drain(strategy: Strategy, budget: number): Drained {
    this.#strategy = strategy;
    this.#ops = 0;
    this.#end = budget;
    while (this.#queue.length > 0) {
      if (this.#ops >= this.#end) return { emptied: false, ops: this.#ops };
      // One task: `splice` answers the task at the picked index.
      for (const task of this.#queue.splice(
        this.#queue.length > 1 ? strategy.next(this.#queue) : 0,
        1,
      )) {
        this.#current = task;
        this.#slice = 0;
        this.#preempted = false;
        task.run();
        this.#current = undefined;
      }
    }
    return { emptied: true, ops: this.#ops };
  }

  /**
   * Interrupts every fiber of the run still unfinished, daemons included, and
   * drains first in first out, again for any fiber that starts meanwhile,
   * within `budget` ops, then lets go of everything the run held. Answers how
   * many fibers are still unfinished: each is waiting where interruption
   * cannot reach it.
   */
  windDown(budget: number): number {
    const unfinished = () => [...this.fibers].filter((fiber) => fiber.unsafePoll() === null);
    const interrupted = new Set<AnyFiber>();
    let left = budget;
    let fresh = unfinished();
    while (fresh.length > 0) {
      for (const fiber of fresh) {
        interrupted.add(fiber);
        fiber.unsafeInterruptAsFork(FiberId.none);
      }
      const { emptied, ops } = this.drain(inert, left);
      if (!emptied) break;
      left -= ops;
      fresh = unfinished().filter((fiber) => !interrupted.has(fiber));
    }
    const stranded = unfinished().length;
    this.fibers.clear();
    this.#queue = [];
    this.#strategy = inert;
    return stranded;
  }
}

/** `run`, with `Math.random` drawing from a generator seeded by `seed` while it runs. */
function seeded<A>(seed: number, run: () => A): A {
  const { random } = Math;
  const generator = new Utils.PCGRandom(seed);
  Math.random = () => generator.number();
  try {
    return run();
  } finally {
    Math.random = random;
  }
}

/**
 * One run of `program` scheduled by `strategy` until no task is left or the
 * run reaches `maxOps`, then wound down within as many again, classified by
 * how the program ended. Throughout, `Math.random` and the program's `Random`
 * service draw from generators seeded by `seed`.
 */
function execute<A, E>(
  program: Effect.Effect<A, E>,
  strategy: Strategy,
  maxOps: number,
  seed: number,
): Simulated<A, E> {
  const { drained, exit, stranded } = seeded(seed, () => {
    const run = new Run();
    const root = Effect.runFork(program, {
      scheduler: run.scheduler,
      immediate: false,
      updateRefs: (refs, fiberId) =>
        FiberRefs.updateAs(refs, {
          fiberId,
          fiberRef: DefaultServices.currentServices,
          value: Context.add(
            FiberRefs.getOrDefault(refs, DefaultServices.currentServices),
            Random.Random,
            Random.make(seed),
          ),
        }),
    });
    const scheduled = run.drain(strategy, maxOps);
    const ended = root.unsafePoll();
    return { drained: scheduled, exit: ended, stranded: run.windDown(maxOps) };
  });
  const { ops } = drained;
  const outliving =
    stranded > 0
      ? `; ${stranded} of its fibers did not finish when interrupted, waiting in an uninterruptible region or on a finalizer that never completes, and stay alive for the life of the process`
      : "";
  if (!drained.emptied) {
    throw new Error(
      `the run did not finish within ${maxOps} ops: a fiber loops or yields forever, or the program needs more and simulate's maxOps has to be raised${outliving}`,
    );
  }
  if (exit === null) return { parked: true, ops, stranded };
  if (stranded > 0) throw new Error(`the run finished${outliving}`);
  return { parked: false, exit, ops };
}

let runtimeAnswered = false;

/**
 * Whether this process's Effect behaves as everything `simulate` finds rests
 * on: it asks the scheduler between two synchronous ops, which Effect 3.22
 * does before every op from its run loop; it hands the scheduler the fiber
 * each task is for, which the wind-down and the priority strategy count
 * fibers by; and it schedules a fiber's yield as the fiber's own continuation.
 * A release that broke the first would leave every race property passing
 * without reaching a race, and one that broke the second would leave a run's
 * fibers alive after it.
 */
function verifyRuntime(): void {
  if (runtimeAnswered) return;
  const probe = Effect.suspend(() => {
    const log: string[] = [];
    const step = (name: string) => Effect.sync(() => void log.push(name));
    return Effect.gen(function* () {
      const a = yield* Effect.fork(step("a1").pipe(Effect.zipRight(step("a2"))));
      const b = yield* Effect.fork(step("b"));
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      return log.join(" ");
    });
  });
  const between = Array.from({ length: 64 }, (_, op) =>
    execute(probe, walk([op], []), 10_000, 0),
  ).some((run) => !run.parked && Exit.isSuccess(run.exit) && run.exit.value === "a1 b a2");
  if (!between) {
    throw new Error(
      "this process's effect never lets a fiber run between two synchronous ops of another, so simulate cannot reach the races it exists to find; it was written against effect 3.22.0",
    );
  }
  const yielded = new Set<AnyFiber>();
  const run = new Run();
  const root = Effect.runFork(
    Effect.gen(function* () {
      yield* Effect.all([Effect.void, Effect.void], { concurrency: "unbounded" });
      const child = yield* Effect.fork(Effect.yieldNow());
      yield* Fiber.join(child);
      return child;
    }),
    { scheduler: run.scheduler, immediate: false },
  );
  run.drain({ ...inert, yielded: (fiber) => yielded.add(fiber) }, 10_000);
  const exit = root.unsafePoll();
  if (exit === null || Exit.isFailure(exit)) {
    throw new Error("this process's effect did not fork a fiber under simulate's scheduler");
  }
  const child = exit.value;
  if (!run.fibers.has(child)) {
    throw new Error(
      "this process's effect schedules a fiber's work without naming the fiber, so simulate can neither rank fibers nor end a run's fibers before answering; it was written against effect 3.22.0",
    );
  }
  if (!yielded.has(child) || yielded.size > 1) {
    throw new Error(
      "this process's effect schedules a fiber's yield differently from the fiber's own run rescheduling itself, so the priority strategy cannot tell a yield from a fiber starting or from work a fiber hands others; it was written against effect 3.22.0",
    );
  }
  runtimeAnswered = true;
}

/**
 * Runs `program` until no fiber can run, synchronously: each fiber's next
 * slice is a queued task the interleaving picks among, and the runtime asks
 * the interleaving before every op whether the running fiber yields there. No
 * timer, microtask or clock takes part, so a fiber waiting on anything outside
 * the program reads as parked: a real timer, real I/O, a callback, and any
 * promise, an already resolved one included, since a promise settles on a
 * microtask. For the run's duration `Math.random` and the program's `Random`
 * service draw from generators seeded by the interleaving.
 *
 * Before answering, every fiber of the run still unfinished, daemons included,
 * is interrupted and the run drained, so its finalizers run. Throws when the
 * run does not finish within `limits.maxOps` ops, and when a run that finished
 * leaves a fiber that does not finish once interrupted.
 */
export function simulate<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
  limits: Limits = { maxOps: 100_000 },
): Simulated<A, E> {
  verifyRuntime();
  return execute(
    program,
    strategyOf(interleaving),
    limits.maxOps,
    Hash.string(
      JSON.stringify(
        interleaving.strategy === "walk"
          ? [interleaving.strategy, interleaving.preemptAt, interleaving.picks]
          : [interleaving.strategy, interleaving.priorities, interleaving.changeAt],
      ),
    ),
  );
}
