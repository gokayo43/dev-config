import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { array, check as explore, constantFrom, property } from "fast-check";

import { interleavings, interleavingsOf, simulate, unpreempted } from "../interleaving.ts";
import { check } from "../property.ts";
import {
  covered,
  depositAndRead,
  finished,
  makeLedger,
  makeSeats,
  races,
  stood,
} from "./interleaving-fixtures.ts";

describe("finding races", () => {
  /** The page's run count for the torn read, whose share of failing runs is the lowest: docs/exports/interleaving.md. */
  const RUNS = 1_200;

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
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ledger = yield* makeLedger(
        locked,
        Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const reading = yield* Effect.forkChild(ledger.read);
      yield* Deferred.await(reached);
      const deposit = yield* Effect.forkChild(ledger.deposit);
      yield* Effect.yieldNow;
      const depositStood = stood(deposit);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(deposit);
      return { read: yield* Fiber.join(reading), depositStood };
    });

  test("the probe drives the torn read: a whole deposit between the reading's reads", async () => {
    const { read, depositStood } = await Effect.runPromise(probe(false));
    expect(depositStood).toBe("finished");
    expect(covered(read)).toBe(false);
  });

  test("the probe holds the locked ledger, with the deposit waiting on the reading", async () => {
    const { read, depositStood } = await Effect.runPromise(probe(true));
    expect(depositStood).toBe("waiting");
    expect(covered(read)).toBe(true);
  });
});

describe("the page's examples run as written", () => {
  const bookTwice = Effect.gen(function* () {
    const seats = yield* makeSeats(1);
    const first = yield* Effect.forkChild(seats.book);
    const second = yield* Effect.forkChild(seats.book);
    return [yield* Fiber.join(first), yield* Fiber.join(second)].filter(Boolean).length;
  });

  test("two bookings of the last seat sell it once", () => {
    check(
      property(interleavingsOf(bookTwice), (interleaving) => {
        expect(simulate(bookTwice, interleaving)).toMatchObject({
          parked: false,
          exit: Exit.succeed(1),
        });
      }),
      { numRuns: 1_000 },
    );
  });

  /** The sizing section's program: one booking of the last seat per generated step. */
  const operations = array(constantFrom("book" as const), { minLength: 1, maxLength: 6 });
  const scenario = (steps: readonly "book"[]) =>
    Effect.gen(function* () {
      const seats = yield* makeSeats(1);
      const bookings = [];
      for (const _step of steps) bookings.push(yield* Effect.forkChild(seats.book));
      return yield* Fiber.joinAll(bookings);
    });

  test("the sizing section's property, sized from the largest program its generator produces", () => {
    expect(
      simulate(scenario(Array.from({ length: 6 }, () => "book")), unpreempted).ops,
    ).toBeLessThanOrEqual(400);
    check(
      property(operations, interleavings(400), (steps, interleaving) => {
        expect(simulate(scenario(steps), interleaving)).toMatchObject({ parked: false });
      }),
      { numRuns: 700 },
    );
  });

  /** The page's two bumps of `hits`: one op under `map`, two under `Effect.gen`. */
  const bumps = (bump: (counter: { hits: number }) => Effect.Effect<unknown>) =>
    Effect.suspend(() => {
      const counter = { hits: 0 };
      return Effect.gen(function* () {
        yield* Fiber.joinAll([
          yield* Effect.forkChild(bump(counter)),
          yield* Effect.forkChild(bump(counter)),
        ]);
        return counter.hits;
      });
    });
  const mapped = bumps((counter) =>
    Effect.sync(() => counter.hits).pipe(Effect.map((seen) => (counter.hits = seen + 1))),
  );
  const generated = bumps((counter) =>
    Effect.gen(function* () {
      const seen = yield* Effect.sync(() => counter.hits);
      yield* Effect.sync(() => (counter.hits = seen + 1));
    }),
  );

  test("steps joined by map lose no update under any interleaving, and two yields in Effect.gen lose one under some", () => {
    const counts = new Set<number>();
    check(
      property(interleavingsOf(mapped), (interleaving) => {
        expect(finished(mapped, interleaving)).toBe(2);
      }),
      { numRuns: 1_000 },
    );
    check(
      property(interleavingsOf(generated), (interleaving) => {
        counts.add(finished(generated, interleaving));
      }),
      { numRuns: 1_000 },
    );
    expect(counts).toEqual(new Set([1, 2]));
  });
});
