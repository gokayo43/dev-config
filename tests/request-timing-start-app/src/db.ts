/**
 * The database, as the template's `src/server/db.ts` has it: one Bun.sql
 * client, drizzle over it, and a `Db` service the Effect programs reach it
 * through, whose thunk runs drizzle under `Effect.tryPromise`.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { Context, Data, Effect, Layer } from "effect";

import { required } from "../../../.github/actions/_lib/gate.ts";
import { timedSql } from "../../../request-timing-bun-sql.ts";
import { timed } from "./timing.ts";

export const presets = pgTable("presets", {
  id: serial().primaryKey(),
  label: varchar({ length: 64 }).notNull().unique(),
});

const bare = new SQL(
  required(
    "FIXTURE_DATABASE_URL",
    "the fixture app reaches the scratch database its suite made for it",
  ),
);
const client = timed ? timedSql(bare) : bare;

export const db = drizzle({ client });

export type Preset = typeof presets.$inferSelect;

/** The database refused or failed a statement. */
export class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}

/** The database as an Effect service: one thunk over drizzle, with typed failures. */
export class Db extends Context.Service<
  Db,
  {
    readonly use: <A>(query: (database: typeof db) => Promise<A>) => Effect.Effect<A, DbError>;
  }
>()("Db") {}

export const DbLive = Layer.succeed(Db, {
  use: (query) =>
    Effect.tryPromise({ try: () => query(db), catch: (cause) => new DbError({ cause }) }),
});
