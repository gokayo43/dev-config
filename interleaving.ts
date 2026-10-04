import { Effect, type Exit, type Fiber, type Scheduler } from "effect";
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
 * highest, first in first out among equals, and drops the running fiber below
 * every other at each op in `changeAt`.
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

/** Runs of the suite's fixtures stay under 250 ops, and a fiber that loops forever reaches this in well under a second. */
const QUIESCENCE_LIMIT = 100_000;

type AnyFiber = Fiber.RuntimeFiber<unknown, unknown>;

interface Task {
  readonly run: () => void;
  readonly fiber: AnyFiber | undefined;
}

interface Strategy {
  readonly next: (queue: readonly Task[]) => number;
  readonly preempt: (fiber: AnyFiber, op: number, queue: readonly Task[]) => boolean;
}

/**
 * Every interleaving of a program whose runs take about `ops` ops: the op
 * indices it preempts or changes priority at are drawn below `ops`, so a run
 * longer than that is never preempted past it by the walk. `simulate` answers
 * a run's length as `ops`.
 *
 * Both strategies, because the prototype this comes from (dev-config#140)
 * needed both to find its races. The priority strategy is PCT (Burckhardt et
 * al., ASPLOS 2010) with ties allowed. The lengths and bounds are the ones that
 * prototype was measured with.
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
  };
}

function priority(priorities: readonly number[], changeAt: readonly number[]): Strategy {
  const at = new Set(changeAt);
  const held = new Map<AnyFiber | undefined, number>();
  let lowered = 0;
  const of = (fiber: AnyFiber | undefined): number => {
    const known = held.get(fiber);
    if (known !== undefined) return known;
    const given = priorities[held.size] ?? 0;
    held.set(fiber, given);
    return given;
  };
  return {
    next: (queue) => {
      const ranks = queue.map((task) => of(task.fiber));
      return ranks.indexOf(Math.max(...ranks));
    },
    preempt: (fiber, op, queue) => {
      if (at.has(op)) {
        lowered += 1;
        held.set(fiber, -lowered);
        return true;
      }
      const mine = of(fiber);
      return queue.some((task) => of(task.fiber) > mine);
    },
  };
}

/**
 * Runs `program` to quiescence under `interleaving`, synchronously: each
 * fiber's next slice is a queued task the interleaving picks among, and the
 * runtime asks the interleaving before every op whether the running fiber
 * yields there. No timer and no microtask takes part, so a fiber waiting on a
 * real timer, real I/O or a callback from outside the program reads as parked.
 *
 * Throws when a run executes 100 000 ops without finishing, and when a fiber
 * is woken after `simulate` returned, since nothing is left to run it.
 */
export function simulate<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
): Simulated<A, E> {
  const strategy =
    interleaving.strategy === "walk"
      ? walk(interleaving.preemptAt, interleaving.picks)
      : priority(interleaving.priorities, interleaving.changeAt);
  const queue: Task[] = [];
  let ops = 0;
  let open = true;
  const scheduler: Scheduler.Scheduler = {
    scheduleTask: (run, _priority, fiber) => {
      if (!open) {
        throw new Error(
          "a fiber woke after simulate returned. The program waited on something outside it, such as a real timer, real I/O or a callback the test fired afterwards, and no interleaving can order that",
        );
      }
      queue.push({ run, fiber });
    },
    shouldYield: (fiber) => {
      if (ops === QUIESCENCE_LIMIT) {
        throw new Error(
          `the run executed ${QUIESCENCE_LIMIT} ops without finishing: a fiber loops or yields forever, so the program never finishes on its own`,
        );
      }
      return strategy.preempt(fiber, ops++, queue) ? 0 : false;
    },
  };
  // `immediate: false` queues the root like every other fiber; without it
  // `runFork` runs the root's first slice itself, before any pick is made.
  const root = Effect.runFork(program, { scheduler, immediate: false });
  try {
    while (queue.length > 0) {
      for (const task of queue.splice(queue.length > 1 ? strategy.next(queue) : 0, 1)) task.run();
    }
  } finally {
    open = false;
  }
  const exit = root.unsafePoll();
  return exit === null ? { parked: true, ops } : { parked: false, exit, ops };
}
