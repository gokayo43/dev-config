import { Effect, Exit, Fiber, FiberId, FiberRef, type Scheduler } from "effect";
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
 * other when it yields and at each op in `changeAt`. Tasks the runtime
 * schedules for no fiber, such as a Mailbox handing on to its next taker,
 * share one priority.
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
 * How a simulated run ended, and how many ops it executed. A parked run is one
 * whose every fiber was waiting with the program unfinished, which no further
 * scheduling can change.
 */
export type Simulated<A, E> =
  | { readonly parked: false; readonly exit: Exit.Exit<A, E>; readonly ops: number }
  | { readonly parked: true; readonly ops: number };

/** How many ops a run may execute before `simulate` gives up on it finishing. */
export interface Limits {
  readonly maxOps: number;
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

/**
 * Every interleaving of a program whose run takes `ops` ops when nothing
 * preempts it: the op indices it preempts or drops a priority at are drawn
 * below `ops`. The priority strategy is PCT (Burckhardt et al., ASPLOS 2010)
 * with ties allowed.
 */
export function interleavings(ops: number): Arbitrary<Interleaving> {
  const op = nat({ max: ops - 1 });
  return oneof(
    record({
      strategy: constant("walk" as const),
      preemptAt: uniqueArray(op, { maxLength: 60, size: "max" }),
      picks: array(nat({ max: 7 }), { maxLength: 60, size: "max" }),
    }),
    record({
      strategy: constant("priority" as const),
      priorities: array(nat({ max: 99 }), { maxLength: 24, size: "max" }),
      changeAt: uniqueArray(op, { maxLength: 3 }),
    }),
  );
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

/** Gives way nowhere and picks first in first out: the order the run is wound down in. */
const windDown: Strategy = { next: () => 0, preempt: () => false, yielded: () => undefined };

/**
 * One run of `program`, scheduled by `strategy` until no task is left or the
 * run reaches `maxOps`, then wound down: every fiber of the run still
 * unfinished is interrupted and the run drained, first in first out, until
 * none is.
 */
function execute<A, E>(
  program: Effect.Effect<A, E>,
  strategy: Strategy,
  maxOps: number,
): Simulated<A, E> {
  const fibers = new Set<AnyFiber>();
  const queue: Task[] = [];
  let deciding = strategy;
  let ops = 0;
  let budget = maxOps;
  let running: AnyFiber | undefined;
  let slice = 0;
  let preempted = false;
  const scheduler: Scheduler.Scheduler = {
    scheduleTask: (run, _priority, fiber) => {
      if (fiber !== undefined) {
        fibers.add(fiber);
        if (fiber === running && !preempted) deciding.yielded(fiber);
      }
      queue.push({ run, fiber });
    },
    shouldYield: (fiber) => {
      if (spent()) {
        preempted = true;
        return 0;
      }
      slice += 1;
      preempted = deciding.preempt(fiber, ops++, queue);
      return preempted || slice > fiber.getFiberRef(FiberRef.currentMaxOpsBeforeYield) ? 0 : false;
    },
  };
  const spent = () => ops >= budget;
  const drain = () => {
    while (queue.length > 0 && !spent()) {
      // One task: `splice` answers the task at the picked index.
      for (const task of queue.splice(queue.length > 1 ? deciding.next(queue) : 0, 1)) {
        running = task.fiber;
        slice = 0;
        preempted = false;
        task.run();
        running = undefined;
      }
    }
  };

  const root = Effect.runFork(program, { scheduler, immediate: false });
  drain();
  const exit = root.unsafePoll();
  const quiesced = queue.length === 0;

  deciding = windDown;
  budget = ops + maxOps;
  const interrupted = new Set<AnyFiber>();
  const unfinished = () => [...fibers].filter((fiber) => fiber.unsafePoll() === null);
  for (
    let waiting = unfinished().filter((fiber) => !interrupted.has(fiber));
    waiting.length > 0 && !spent();
    waiting = unfinished().filter((fiber) => !interrupted.has(fiber))
  ) {
    for (const fiber of waiting) {
      interrupted.add(fiber);
      fiber.unsafeInterruptAsFork(FiberId.none);
    }
    drain();
  }
  const left = unfinished().length;
  if (left > 0) {
    throw new Error(
      `${left} of the run's fibers did not finish when interrupted: a fiber waits in an uninterruptible region or a finalizer never completes, so they outlive simulate`,
    );
  }
  if (!quiesced) {
    throw new Error(
      `the run did not finish within ${maxOps} ops: a fiber loops or yields forever, or the program needs more and simulate's maxOps has to be raised`,
    );
  }
  return exit === null ? { parked: true, ops } : { parked: false, exit, ops };
}

/**
 * Whether this process's Effect asks the scheduler between two synchronous
 * ops, which everything `simulate` finds rests on. Effect 3.22 asks before
 * every op from its run loop; a release that asked only at yields and forks
 * would leave every race property passing without reaching a race.
 */
let runtimeAnswered = false;

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
    execute(probe, walk([op], []), 10_000),
  ).some((run) => !run.parked && Exit.isSuccess(run.exit) && run.exit.value === "a1 b a2");
  if (!between) {
    throw new Error(
      "this process's effect never lets a fiber run between two synchronous ops of another, so simulate cannot reach the races it exists to find; it was written against effect 3.22.0",
    );
  }
  runtimeAnswered = true;
}

/**
 * Runs `program` until no fiber can run, synchronously: each fiber's next
 * slice is a queued task the interleaving picks among, and the runtime asks
 * the interleaving before every op whether the running fiber yields there. No
 * timer, microtask, clock or `Math.random` takes part, so a fiber waiting on
 * anything outside the program reads as parked: a real timer, real I/O, a
 * callback, and any promise, an already resolved one included, since a promise
 * settles on a microtask.
 *
 * Before answering, every fiber of the run still unfinished, daemons included,
 * is interrupted and the run drained, so its finalizers run and nothing of it
 * outlives the call. Throws when the run does not finish within
 * `limits.maxOps` ops, and when a fiber does not finish once interrupted.
 */
export function simulate<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
  limits: Limits = { maxOps: 100_000 },
): Simulated<A, E> {
  verifyRuntime();
  return execute(
    program,
    interleaving.strategy === "walk"
      ? walk(interleaving.preemptAt, interleaving.picks)
      : priority(interleaving.priorities, interleaving.changeAt),
    limits.maxOps,
  );
}
