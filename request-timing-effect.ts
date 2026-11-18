/**
 * Request timing for an Effect program: which operation a wait belongs to,
 * carried in the fiber. Never in `AsyncLocalStorage`: a fiber that waits on a
 * shared semaphore, Deferred or queue resumes on the stack of the fiber that
 * released it and inherits that fiber's store (measured on Bun 1.4.4 with
 * effect 3.22.1: 38 of 40 queries attributed to the wrong request).
 * `docs/exports/request-timing.md` is how an app adopts it.
 */
import { Effect, FiberRef } from "effect";

import { beginWait, type Operation, type WaitKind } from "./request-timing-operation.ts";

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
