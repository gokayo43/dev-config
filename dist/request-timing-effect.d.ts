import { f as WaitKind, i as Operation } from "./request-timing-operation-BW73YQNi.js";
import { Cause, Effect } from "effect";
//#region request-timing-effect.d.ts
/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` in it, and in every fiber it forks,
 * counts in `operation`.
 */
export declare const within: <A, E, R>(operation: Operation, handler: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * Runs `wait` and adds its duration to the current fiber's operation under
 * `kind`, or answers `wait` itself when the fiber has none. The wait ends when
 * `wait` exits: with a value, a failure, a defect or an interruption.
 */
export declare const measure: <A, E, R>(kind: WaitKind, wait: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * Whether the fiber has an operation: the Effect carrier's half of the
 * no-nesting rule an entry connector holds to, as the plain `inOperation` is.
 */
export declare const inOperation: Effect.Effect<boolean>;
/**
 * The crossing from a plain handler into an Effect program: `program` with the
 * plain carrier's current operation, read now, carried in its fiber, or
 * `program` itself when none is current. Call it where the handler hands the
 * program to its runtime, `runtime.runPromise(carryOperation(program))`, since
 * `AsyncLocalStorage` holds the right operation only up to that call; a
 * program carried once and run again later keeps the operation it was carried
 * with.
 */
export declare function carryOperation<A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
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
export declare function tryPromiseCarried<A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (error: unknown) => E;
}): Effect.Effect<A, E>;
export declare function tryPromiseCarried<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, Cause.UnknownException>;
//#endregion