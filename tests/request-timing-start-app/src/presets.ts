/**
 * The programs the routes and server functions run, each with a known number
 * of database waits, and the latches the suite holds them at.
 */
import { count, eq } from "drizzle-orm";
import { Effect, Semaphore } from "effect";

import { latch } from "../../request-timing-fixture.ts";
import { Db, type DbError, type Preset, presets } from "./db.ts";
import { Contended } from "./runtime.ts";

/** One preset and how many there are: two waits. */
export const findPreset = (
  id: number,
): Effect.Effect<{ preset: Preset | undefined; total: number | undefined }, DbError, Db> =>
  Effect.gen(function* () {
    const { use } = yield* Db;
    const [preset] = yield* use((db) => db.select().from(presets).where(eq(presets.id, id)));
    const [total] = yield* use((db) => db.select({ total: count() }).from(presets));
    return { preset, total: total?.total };
  });

/** Every preset: one wait. */
export const listPresets: Effect.Effect<Preset[], DbError, Db> = Effect.flatMap(Db, ({ use }) =>
  use((db) => db.select().from(presets).orderBy(presets.id)),
);

/** What `/hang` waits on between its two queries, until the suite's client has gone. */
export const held = latch();

/** How many lanes are about to wait on the contended permit, and who is told when enough are. */
const arrivals = { waiting: 0, wanted: 0, all: Promise.withResolvers<void>() };

/** Resolves once `lanes` lanes have arrived at the permit, counting from now. */
export function arrived(lanes: number): Promise<void> {
  arrivals.waiting = 0;
  arrivals.wanted = lanes;
  arrivals.all = Promise.withResolvers<void>();
  return arrivals.all.promise;
}

/** What one lane does: `queries` waits, then a transaction of three where `transaction` is set. */
export interface Plan {
  readonly queries: number;
  readonly transaction: boolean;
}

/**
 * A lane: it arrives at the contended permit and, holding it, makes its
 * plan's waits. The permit is the shared resource attribution is graded
 * through: a lane waiting on it is woken by the fiber that released it.
 */
export const lane = (plan: Plan, label: string): Effect.Effect<string, DbError, Db | Contended> =>
  Effect.gen(function* () {
    const { semaphore } = yield* Contended;
    const { use } = yield* Db;
    yield* Effect.sync(() => {
      arrivals.waiting += 1;
      if (arrivals.waiting === arrivals.wanted) arrivals.all.resolve();
    });
    yield* Semaphore.withPermits(
      semaphore,
      1,
      Effect.gen(function* () {
        for (let query = 0; query < plan.queries; query += 1) {
          yield* use((db) => db.select().from(presets).where(eq(presets.id, 1)));
        }
        if (plan.transaction) {
          yield* use((db) =>
            db.transaction((tx) => tx.select().from(presets).where(eq(presets.label, label))),
          );
        }
      }),
    );
    return label;
  });

/** Takes the contended permit outside every operation, answering what gives it back. */
export const holdPermit = Effect.gen(function* () {
  const { semaphore } = yield* Contended;
  yield* Semaphore.take(semaphore, 1);
  return Semaphore.release(semaphore, 1);
});
