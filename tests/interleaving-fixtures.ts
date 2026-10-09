import { Effect, Exit, Fiber, Ref } from "effect";
import { type Interleaving, type Limits, simulate, unpreempted } from "../interleaving.ts";

/** The run's exit value, throwing when the run did not finish with one. */
export function finished<A, E>(
  program: Effect.Effect<A, E>,
  interleaving: Interleaving,
  limits?: Limits,
): A {
  const run = simulate(program, interleaving, limits);
  if (run.parked) throw new Error(`the run parked: ${JSON.stringify(interleaving)}`);
  if (Exit.isFailure(run.exit)) throw new Error(`the run failed: ${String(run.exit.cause)}`);
  return run.exit.value;
}

/** One call of an operation: when it started and ended, on a clock the program ticks, and what it answered. */
export interface Call<A> {
  readonly start: number;
  readonly end: number;
  readonly answer: A;
}

/**
 * Whether some serial order of `calls`, each placed after every call that
 * ended before it started, gives each call its answer when `apply` runs them
 * one at a time from `state`, and ends in `final`.
 */
export function serial<S, A>(
  calls: readonly Call<A>[],
  state: S,
  apply: (state: S) => readonly [A, S],
  final: S,
): boolean {
  if (calls.length === 0) return state === final;
  return calls.some((call) => {
    if (calls.some((other) => other.end < call.start)) return false;
    const [answer, next] = apply(state);
    return (
      answer === call.answer &&
      serial(
        calls.filter((other) => other !== call),
        next,
        apply,
        final,
      )
    );
  });
}

/** A racy program and its fixed version, judged by whether a run's answer holds the invariant. */
export interface Race {
  readonly name: string;
  /** The run's length under `unpreempted`, which sizes the search. */
  readonly ops: (fixed: boolean) => number;
  /** Whether the run finished with an answer that holds the invariant; throws when it did not finish. */
  readonly holds: (fixed: boolean, interleaving: Interleaving) => boolean;
}

const race = <A>(
  name: string,
  program: (fixed: boolean) => Effect.Effect<A>,
  holds: (answer: A) => boolean,
): Race => ({
  name,
  ops: (fixed) => simulate(program(fixed), unpreempted).ops,
  holds: (fixed, interleaving) => holds(finished(program(fixed), interleaving)),
});

/** The seat's two bookings, each with its answer, and how many seats are left. */
export interface Booked {
  readonly calls: readonly Call<boolean>[];
  readonly left: number;
}

/** One booking applied to the seats left, alone: what it answers and leaves. */
export const book = (left: number): readonly [boolean, number] =>
  left > 0 ? [true, left - 1] : [false, left];

/**
 * A check-then-act across a yield: two bookings of the last seat, the second
 * arriving one scheduling step after the first. Run first in first out, the
 * first has written before the second reads.
 */
export const booking = (locked: boolean): Effect.Effect<Booked> =>
  Effect.gen(function* () {
    const seats = yield* Ref.make(1);
    const lock = yield* Effect.makeSemaphore(1);
    let clock = 0;
    const calls: Call<boolean>[] = [];
    const attempt = Effect.gen(function* () {
      const left = yield* Ref.get(seats);
      if (left === 0) return false;
      yield* Effect.yieldNow();
      yield* Ref.set(seats, left - 1);
      return true;
    });
    const call = Effect.gen(function* () {
      const start = clock++;
      const answer = yield* locked ? lock.withPermits(1)(attempt) : attempt;
      calls.push({ start, end: clock++, answer });
    });
    const early = yield* Effect.fork(call);
    const late = yield* Effect.fork(Effect.yieldNow().pipe(Effect.zipRight(call)));
    yield* Fiber.join(early);
    yield* Fiber.join(late);
    return { calls, left: yield* Ref.get(seats) };
  });

/**
 * A read and a write of one counter as two synchronous steps, with nothing
 * between them a test could wrap: only a preemption at the op boundary
 * reaches it. Answers the count, which two bumps leave at 2.
 */
export const counter = (atomic: boolean): Effect.Effect<number> =>
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

/** What a reading of the ledger saw, and every step the run took, in order. */
export interface Read {
  readonly balance: number;
  readonly entries: number;
  readonly steps: readonly string[];
}

/**
 * A ledger whose deposit credits the balance and then appends the entry, and
 * whose reading reads the balance and then the entries, calling `seam` between
 * the two. A reading never sees more entries than the balance pays for unless
 * a whole deposit runs between its two reads: two preemptions.
 */
export const makeLedger = (locked: boolean, seam: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const lock = yield* Effect.makeSemaphore(1);
    let balance = 0;
    let entries = 0;
    const steps: string[] = [];
    /** One synchronous op, recorded in `steps` by `name` as it runs. */
    const step = <A>(name: string, run: () => A) =>
      Effect.sync(() => {
        steps.push(name);
        return run();
      });
    const guarded = <A>(effect: Effect.Effect<A>) =>
      locked ? lock.withPermits(1)(effect) : effect;
    return {
      deposit: guarded(
        step("credit", () => (balance += 1)).pipe(
          Effect.zipRight(step("append", () => (entries += 1))),
        ),
      ),
      read: guarded(
        Effect.gen(function* () {
          const seen = yield* step("read balance", () => balance);
          yield* seam;
          return { balance: seen, entries: yield* step("read entries", () => entries), steps };
        }),
      ),
    };
  });

/** One deposit and one reading of a fresh ledger, overlapping: the reading's view. */
export const depositAndRead = (locked: boolean): Effect.Effect<Read> =>
  Effect.gen(function* () {
    const ledger = yield* makeLedger(locked);
    const deposit = yield* Effect.fork(ledger.deposit);
    const read = yield* Effect.fork(ledger.read);
    yield* Fiber.join(deposit);
    return yield* Fiber.join(read);
  });

/** Whether a reading saw no entry the balance does not pay for. */
export const covered = (read: Read): boolean => read.entries <= read.balance;

/** The racy fixtures the suite searches and the measurement script measures, each with its fixed version. */
export const races: Race[] = [
  race("a check-then-act across a yield", booking, ({ calls, left }) =>
    serial(calls, 1, book, left),
  ),
  race("a lost update between two synchronous ops", counter, (count) => count === 2),
  race("a torn read across a whole write", depositAndRead, covered),
];
