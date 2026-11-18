/**
 * Request timing for an Effect program: which operation a wait belongs to,
 * carried in the fiber. Never in `AsyncLocalStorage`: a fiber that waits on a
 * shared semaphore, Deferred or queue resumes on the stack of the fiber that
 * released it and inherits that fiber's store (measured on Bun 1.4.4 with
 * effect 3.22.1: 38 of 40 queries attributed to the wrong request). It
 * touches that storage at the two crossings alone: `carryOperation` reads it,
 * synchronously, in the caller's context, before any fiber runs, and
 * `tryPromiseCarried` sets it from the fiber, or clears it, for the length of
 * one thunk.
 * `docs/exports/request-timing.md` is how an app adopts it.
 */
import { type Cause, Effect, FiberRef } from "effect";

import {
  beginWait,
  type Operation,
  plainStorage,
  type WaitKind,
} from "./request-timing-operation.ts";

/**
 * A fiber forked under an operation inherits it. A joined child never hands
 * its operation back to the parent, whatever it ran under.
 */
const current = FiberRef.unsafeMake<Operation | undefined>(undefined, {
  join: (parent) => parent,
});

/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` in it, and in every fiber it forks,
 * counts in `operation`.
 */
export const within = <A, E, R>(
  operation: Operation,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.locally(handler, current, operation);

/**
 * Runs `wait` and adds its duration to the current fiber's operation under
 * `kind`, or answers `wait` itself when the fiber has none. The wait ends when
 * `wait` exits: with a value, a failure, a defect or an interruption.
 */
export const measure = <A, E, R>(
  kind: WaitKind,
  wait: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  FiberRef.getWith(current, (operation) => {
    if (operation === undefined) return wait;
    return Effect.suspend(() => {
      const end = beginWait(operation, kind);
      return Effect.ensuring(
        wait,
        Effect.sync(() => end()),
      );
    });
  });

/**
 * Whether the fiber has an operation: the Effect carrier's half of the
 * no-nesting rule an entry connector holds to, as the plain `inOperation` is.
 */
export const inOperation: Effect.Effect<boolean> = FiberRef.getWith(current, (operation) =>
  Effect.succeed(operation !== undefined),
);

/**
 * The crossing from a plain handler into an Effect program: `program` with the
 * plain carrier's current operation, read now, carried in its fiber, or
 * `program` itself when none is current. Call it where the handler hands the
 * program to its runtime, `runtime.runPromise(carryOperation(program))`, since
 * `AsyncLocalStorage` holds the right operation only up to that call; a
 * program carried once and run again later keeps the operation it was carried
 * with.
 */
export function carryOperation<A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const operation = plainStorage.getStore();
  return operation === undefined ? program : within(operation, program);
}

/** Runs `evaluate` under the plain carrier with `operation`, or under none at all. */
const carriedOut =
  <A>(operation: Operation | undefined, evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
  (signal: AbortSignal): PromiseLike<A> =>
    operation === undefined
      ? plainStorage.exit(() => evaluate(signal))
      : plainStorage.run(operation, () => evaluate(signal));

/**
 * The crossing back from an Effect program into plain async code: exactly
 * `Effect.tryPromise`, with the promise run under the plain carrier holding the
 * fiber's operation, so every wait a plain connector measures inside it,
 * across all of its awaits, counts in the fiber's operation. With no operation
 * in the fiber the promise runs under no operation, whatever
 * `AsyncLocalStorage` holds where the fiber happens to run, so a stale store
 * from another request never leaks in. Rejection, a synchronous throw, the
 * abort signal and interruption are `Effect.tryPromise`'s: a driver's
 * rejection is an expected failure the wrapping service maps to its own error,
 * where `Effect.promise` would make it a defect.
 */
export function tryPromiseCarried<A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (error: unknown) => E;
}): Effect.Effect<A, E>;
export function tryPromiseCarried<A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, Cause.UnknownException>;
export function tryPromiseCarried<A, E>(
  given:
    | ((signal: AbortSignal) => PromiseLike<A>)
    | {
        readonly try: (signal: AbortSignal) => PromiseLike<A>;
        readonly catch: (error: unknown) => E;
      },
): Effect.Effect<A, E | Cause.UnknownException> {
  return FiberRef.getWith(current, (operation): Effect.Effect<A, E | Cause.UnknownException> => {
    const evaluate = typeof given === "function" ? given : given.try;
    const carried = carriedOut(operation, evaluate);
    return typeof given === "function"
      ? Effect.tryPromise(carried)
      : Effect.tryPromise({ try: carried, catch: given.catch });
  });
}
