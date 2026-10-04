import { Effect, Fiber, Ref } from "effect";

/** The racy fixtures `interleaving.test.ts` searches, each with its fixed version. */

export interface Booked {
  /** How many of the two bookings sold the seat. */
  readonly sold: number;
  /** Whether both bookings were ever in flight at once: started, neither returned. */
  readonly overlapped: boolean;
}

/**
 * A check-then-act across a yield: two bookings of the last seat, the second
 * arriving one scheduling step after the first. Run first in first out, the
 * first has written before the second reads. `padding` is how many synchronous
 * steps sit between the read and the write, which is how a case moves the
 * code's shape.
 */
export const booking = (locked: boolean, padding = 1): Effect.Effect<Booked> =>
  Effect.gen(function* () {
    const seats = yield* Ref.make(1);
    const lock = yield* Effect.makeSemaphore(1);
    let inFlight = 0;
    let overlapped = false;
    const attempt = Effect.gen(function* () {
      const left = yield* Ref.get(seats);
      if (left === 0) return 0;
      yield* Effect.yieldNow();
      for (let step = 0; step < padding; step++) yield* Effect.sync(() => step);
      yield* Ref.set(seats, left - 1);
      return 1;
    });
    const book = Effect.sync(() => {
      inFlight += 1;
      overlapped ||= inFlight === 2;
    }).pipe(
      Effect.zipRight(locked ? lock.withPermits(1)(attempt) : attempt),
      Effect.ensuring(
        Effect.sync(() => {
          inFlight -= 1;
        }),
      ),
    );
    const early = yield* Effect.fork(book);
    const late = yield* Effect.fork(Effect.yieldNow().pipe(Effect.zipRight(book)));
    const sold = (yield* Fiber.join(early)) + (yield* Fiber.join(late));
    return { sold, overlapped };
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
