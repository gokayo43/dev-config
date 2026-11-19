import { AsyncLocalStorage } from "node:async_hooks";

import { Context, Effect, type Exit, Fiber, Hash, Random, type Scheduler, Tracer } from "effect";
import { type Arbitrary, array, constant, nat, oneof, record, uniqueArray } from "fast-check";

import { verifyRuntime } from "./interleaving-runtime.ts";

/**
 * The decisions one run of a program is scheduled by, as plain data: fast-check
 * generates it, prints it in a counterexample and shrinks it like any other
 * value.
 *
 * An op index counts every op the run asks the scheduler about, across all
 * its fibers, from 0. `walk` preempts the running fiber at each op in
 * `preemptAt`, and picks the next task to run by `picks`, an index into the
 * tasks the runtime allows next taken modulo their number, first in first out
 * once they run out. `priority` gives each fiber a priority in the order the
 * run first meets it, always runs the highest, first in first out among
 * equals, and drops a fiber below every other when it yields of its own
 * accord, when it has run `Scheduler.MaxOpsBeforeYield` ops in one slice, and
 * at each op in `changeAt`.
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
 * fibers of a parked run that the wind-down could not end.
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

type AnyFiber = Fiber.Fiber<unknown, unknown>;

/** A task the runtime handed one of the run's dispatchers. */
interface Task {
  readonly run: () => void;
  /** The dispatcher it was handed to: Effect orders tasks within one dispatcher alone. */
  readonly dispatcher: number;
  readonly priority: number;
  /** When it was queued, across the run. */
  readonly seq: number;
  /** The fiber running when it was queued. */
  readonly by: AnyFiber | undefined;
  /** The fiber it resumes, when it is one the scheduler told to yield; else unknown until it runs. */
  readonly resumes: AnyFiber | undefined;
}

/** What the strategy is told when the runtime asks whether `fiber` yields. */
interface Asked {
  readonly fiber: AnyFiber;
  readonly op: number;
  /** The fiber is starting a slice it queued itself: it yielded of its own accord. */
  readonly yielded: boolean;
  /** The fiber has run its `Scheduler.MaxOpsBeforeYield`, where Effect's own scheduler yields it. */
  readonly spent: boolean;
  /** The tasks the runtime allows to run next. */
  readonly next: () => readonly Task[];
  /** The ops this fiber's slice runs inside of, by the fiber each is of. */
  readonly beneath: readonly { readonly fiber: AnyFiber }[];
}

interface Strategy {
  /** Which of `next`, the tasks the runtime allows next, runs. Asked only when there are two or more. */
  readonly pick: (next: readonly Task[]) => number;
  readonly preempt: (asked: Asked) => boolean;
}

function walk(preemptAt: readonly number[], picks: readonly number[]): Strategy {
  const at = new Set(preemptAt);
  let picked = 0;
  return {
    pick: (next) => (picks[picked++] ?? 0) % next.length,
    preempt: ({ op, spent }) => spent || at.has(op),
  };
}

function priority(priorities: readonly number[], changeAt: readonly number[]): Strategy {
  const at = new Set(changeAt);
  const held = new Map<AnyFiber, number>();
  let dropped = 0;
  const of = (fiber: AnyFiber): number => {
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
  /** A task's rank, once the fiber it resumes is known. */
  const rank = ({ resumes }: Task) => (resumes === undefined ? undefined : of(resumes));
  return {
    // A task whose fiber is unknown runs first: no op of the program runs
    // before its first ask, where its fiber is ranked and, when it is
    // outranked, told to yield.
    pick: (next) => {
      let highest = 0;
      let best = Number.NEGATIVE_INFINITY;
      for (const [index, task] of next.entries()) {
        const known = rank(task);
        if (known === undefined) return index;
        if (known > best) [highest, best] = [index, known];
      }
      return highest;
    },
    preempt: ({ fiber, op, yielded, spent, next, beneath }) => {
      // Without the drop at a yield, a fiber waiting for another by yielding
      // outranks it forever.
      const changed = spent || at.has(op);
      if (yielded || changed) drop(fiber);
      if (changed) return true;
      const mine = of(fiber);
      return (
        next().some((task) => (rank(task) ?? Number.POSITIVE_INFINITY) > mine) ||
        beneath.some((other) => of(other.fiber) > mine)
      );
    },
  };
}

/**
 * The strategy `interleaving` schedules a run by, and the seed the run's
 * randomness draws from: its values, in an order that does not depend on the
 * order its fields are written in.
 */
function scheduleOf(interleaving: Interleaving): { strategy: Strategy; seed: number } {
  const [strategy, values] =
    interleaving.strategy === "walk"
      ? [
          walk(interleaving.preemptAt, interleaving.picks),
          [interleaving.strategy, interleaving.preemptAt, interleaving.picks],
        ]
      : [
          priority(interleaving.priorities, interleaving.changeAt),
          [interleaving.strategy, interleaving.priorities, interleaving.changeAt],
        ];
  return { strategy, seed: Hash.string(JSON.stringify(values)) };
}

/** Preempts only where Effect's own scheduler would, and picks first in first out. */
const inert: Strategy = { pick: () => 0, preempt: ({ spent }) => spent };

/** What one drain did: whether it left no task queued, and how many ops it executed. */
interface Drained {
  readonly emptied: boolean;
  readonly ops: number;
}

/**
 * The state of one run: its fibers, the tasks its dispatchers hold, and the
 * task running now. It is the run's `Scheduler`, and its `Tracer`, whose
 * context hook sees every op of every fiber, those under
 * `Scheduler.PreventSchedulerYield` included, which the scheduler is never
 * asked about. A tracer the program provides is watched the same way.
 */
class Run {
  readonly #fibers = new Set<AnyFiber>();
  #queue: Task[] = [];
  #strategy = inert;
  #ops = 0;
  #end = 0;
  #seq = 0;
  #dispatchers = 0;
  #current: Task | undefined;
  #entered = false;
  /** The fiber just told to yield, whose continuation is the next task queued. */
  #yielding: AnyFiber | undefined;
  /** The ops in the middle of being evaluated, innermost last, each by its fiber and an id of its own. */
  readonly #evaluating: { readonly fiber: AnyFiber; readonly id: number }[] = [];
  /** The id of the op whose async context is the current one. */
  readonly #context = new AsyncLocalStorage<number>();
  #ids = 0;
  /** How many ops were in the middle of being evaluated when the running task started. */
  #depth = 0;

  readonly scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => this.#ask(fiber),
    makeDispatcher: () => {
      const dispatcher = this.#dispatchers++;
      return {
        scheduleTask: (run, rank) => {
          this.#queue.push({
            run,
            dispatcher,
            priority: rank,
            seq: this.#seq++,
            by: Fiber.getCurrent(),
            resumes: this.#yielding,
          });
          this.#yielding = undefined;
        },
        // Effect's own callers flush a dispatcher to have its tasks run on the spot.
        flush: () => {
          const ofThis = () => this.#next().filter((task) => task.dispatcher === dispatcher);
          for (let tasks = ofThis(); tasks.length > 0; tasks = ofThis())
            for (const task of tasks) this.#runTask(task);
        },
      };
    },
  };

  readonly #watched = new WeakSet<Tracer.Tracer>();
  readonly tracer = this.#watch(nativeTracer);

  /**
   * `traced`, its spans and its own context hook kept, with every op it is
   * the tracer of passing through the run first. An op that provides a
   * tracer of the program's own replaces this one in the fiber's context, and
   * the fiber's later ops, and every fiber it forks, would pass the run by:
   * the watch puts that tracer back watched.
   */
  #watch(traced: Tracer.Tracer): Tracer.Tracer {
    const watching = Tracer.make({
      span: (options) => traced.span(options),
      context: (primitive, fiber) => {
        this.#fibers.add(fiber);
        const id = this.#ids++;
        this.#evaluating.push({ fiber, id });
        try {
          return this.#context.run(id, () =>
            traced.context === undefined
              ? primitive["~effect/Effect/evaluate"](fiber)
              : traced.context(primitive, fiber),
          );
        } finally {
          this.#evaluating.pop();
          const now = fiber.getRef(Tracer.Tracer);
          if (!this.#watched.has(now))
            fiber.setContext(Context.add(fiber.context, Tracer.Tracer, this.#watch(now)));
        }
      },
    });
    this.#watched.add(watching);
    return watching;
  }

  #ask(fiber: AnyFiber): boolean {
    if (this.#interruptedBeforeStart(fiber)) return false;
    this.#fibers.add(fiber);
    const task = this.#current;
    const first = task !== undefined && !this.#entered;
    this.#entered = true;
    if (this.#ops >= this.#end) {
      this.#yielding = fiber;
      return true;
    }
    const yielding = this.#strategy.preempt({
      fiber,
      op: this.#ops++,
      yielded: first && task.resumes === undefined && task.by === fiber,
      spent: fiber.currentOpCount >= fiber.cache.maxOpsBeforeYield,
      next: () => this.#next(),
      beneath: this.#evaluating,
    });
    if (yielding) this.#yielding = fiber;
    return yielding;
  }

  /**
   * Whether `fiber` is asked about the first op of an interruption that
   * another fiber's op made before `fiber`'s first slice ran. Effect 4.1.4
   * loses that interruption when the fiber yields there: the fiber's first
   * slice, still queued, then runs the fiber's program in the interruption's
   * place (dev-config#210).
   *
   * A fiber the run has never seen that Effect evaluates from inside another
   * fiber's op, rather than from a task, runs in that op's async context,
   * unless it was forked to start later: then it runs in the context Effect
   * captured at the fork, that of the op that forked it, and only that
   * interruption evaluates such a fiber there. A task a flush runs from inside
   * an op starts one level deeper, and its fiber is evaluated from that task.
   */
  #interruptedBeforeStart(fiber: AnyFiber): boolean {
    const inside = this.#evaluating.at(-1);
    return (
      inside !== undefined &&
      this.#evaluating.length > this.#depth &&
      !this.#fibers.has(fiber) &&
      this.#context.getStore() !== inside.id
    );
  }

  /**
   * The tasks the runtime allows to run next, one per dispatcher, its lowest
   * priority number and first in first out among equals, in the order they
   * were queued.
   */
  #next(): Task[] {
    const heads = new Map<number, Task>();
    for (const task of this.#queue) {
      const head = heads.get(task.dispatcher);
      if (head === undefined || task.priority < head.priority) heads.set(task.dispatcher, task);
    }
    return [...heads.values()].toSorted((left, right) => left.seq - right.seq);
  }

  #runTask(task: Task): void {
    this.#queue.splice(this.#queue.indexOf(task), 1);
    const outer = { current: this.#current, entered: this.#entered, depth: this.#depth };
    this.#current = task;
    this.#entered = false;
    this.#depth = this.#evaluating.length;
    // A task that throws from inside, out of a fiber's observer, throws into
    // the op that flushed it, which Effect's run loop catches and goes on from.
    try {
      task.run();
    } finally {
      ({ current: this.#current, entered: this.#entered, depth: this.#depth } = outer);
    }
  }

  /** Sets the strategy the runtime's questions are answered by, its op indices counted from 0, for `budget` ops. */
  schedule(strategy: Strategy, budget: number): void {
    this.#strategy = strategy;
    this.#ops = 0;
    this.#end = budget;
  }

  /** Runs queued tasks in the order the strategy decides until none is left or the budget is spent. */
  drain(): Drained {
    while (this.#queue.length > 0) {
      if (this.#ops >= this.#end) return { emptied: false, ops: this.#ops };
      const next = this.#next();
      for (const task of next.slice(next.length > 1 ? this.#strategy.pick(next) : 0).slice(0, 1))
        this.#runTask(task);
    }
    return { emptied: true, ops: this.#ops };
  }

  /**
   * Interrupts every fiber of the run still unfinished, detached ones
   * included, and drains first in first out, again for any fiber that starts
   * meanwhile, within `budget` ops, then lets go of everything the run held.
   * Answers how many fibers are still unfinished: each is waiting where
   * interruption cannot reach it.
   */
  windDown(budget: number): number {
    const unfinished = () => [...this.#fibers].filter((fiber) => fiber.pollUnsafe() === undefined);
    const interrupted = new Set<AnyFiber>();
    let left = budget;
    let fresh = unfinished();
    while (fresh.length > 0) {
      // Interrupting a fiber runs it at once, so the runtime asks about it
      // here, and that has to be the wind-down's question.
      this.schedule(inert, left);
      for (const fiber of fresh) {
        interrupted.add(fiber);
        fiber.interruptUnsafe();
      }
      const { emptied, ops } = this.drain();
      if (!emptied) break;
      left -= ops;
      fresh = unfinished().filter((fiber) => !interrupted.has(fiber));
    }
    const stranded = unfinished().length;
    this.#fibers.clear();
    this.#queue = [];
    return stranded;
  }
}

const nativeTracer = Context.get(Context.empty(), Tracer.Tracer);

/** `run`, with `Math.random`, which Effect's default `Random` draws from, drawing from Effect's generator seeded by `seed`. */
function seeded<A>(seed: number, run: () => A): A {
  const generator = Effect.runSync(
    Effect.gen(function* () {
      return yield* Random.Random;
    }).pipe(Random.withSeed(seed)),
  );
  const { random } = Math;
  Math.random = () => generator.nextDoubleUnsafe();
  try {
    return run();
  } finally {
    Math.random = random;
  }
}

/**
 * One run of `program` scheduled by `strategy` until no task is left or the
 * run reaches `maxOps`, then wound down within as many again, classified by
 * how the program ended.
 */
function execute<A, E>(
  program: Effect.Effect<A, E>,
  strategy: Strategy,
  maxOps: number,
  seed: number,
): Simulated<A, E> {
  let stranded = 0;
  const { drained, exit } = seeded(seed, () => {
    const run = new Run();
    run.schedule(strategy, maxOps);
    try {
      const root = Effect.runForkWith(Context.make(Tracer.Tracer, run.tracer))(program, {
        scheduler: run.scheduler,
      });
      return { drained: run.drain(), exit: root.pollUnsafe() };
    } finally {
      stranded = run.windDown(maxOps);
    }
  });
  const { ops } = drained;
  const outliving =
    stranded > 0
      ? `; ${stranded} of its fibers did not finish when interrupted, waiting in an uninterruptible region or on a finalizer that never completes`
      : "";
  if (!drained.emptied) {
    throw new Error(
      `the run did not finish within ${maxOps} ops: a fiber loops or yields forever, or the program needs more and simulate's maxOps has to be raised${outliving}`,
    );
  }
  if (exit === undefined) return { parked: true, ops, stranded };
  if (stranded > 0) throw new Error(`the run finished${outliving}`);
  return { parked: false, exit, ops };
}

/**
 * Runs `program` until no fiber can run, synchronously: each task the runtime
 * queues is one the interleaving picks among, and the runtime asks the
 * interleaving at every op whether the running fiber yields there, but the
 * first op of an interruption of a fiber that has not started, where Effect
 * 4.1.4 loses the interruption (dev-config#210). No timer, microtask or clock
 * takes part, so a fiber waiting on anything outside the program reads as
 * parked. For the run's duration
 * `Math.random`, and through it the program's default `Random`, draw from a
 * generator seeded by the interleaving.
 *
 * Before answering or throwing, every fiber of the run still unfinished,
 * detached ones included, is interrupted and the run drained, so its finalizers run. Throws
 * when the run does not finish within `limits.maxOps` ops, and when a run
 * that finished leaves a fiber that does not finish once interrupted.
 */
export function simulate<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
  limits: Limits = { maxOps: 100_000 },
): Simulated<A, E> {
  verifyRuntime();
  const { strategy, seed } = scheduleOf(interleaving);
  return execute(program, strategy, limits.maxOps, seed);
}
