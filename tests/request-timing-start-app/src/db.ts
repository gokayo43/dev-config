/**
 * The database, as the template's `src/server/db.ts` has it: one Bun.sql
 * client, drizzle over it, and a `Db` service the Effect programs reach it
 * through. The service crosses back out to the client with
 * `tryPromiseCarried`, so every query of a thunk counts in the program's
 * operation.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";

import { required } from "../../../.github/actions/_lib/gate.ts";
import { timedSql } from "../../../request-timing-bun-sql.ts";
import { tryPromiseCarried } from "../../../request-timing-effect.ts";
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
export class Db extends Effect.Service<Db>()("Db", {
  succeed: {
    use: <A>(query: (database: typeof db) => Promise<A>) =>
      tryPromiseCarried({ try: () => query(db), catch: (cause) => new DbError({ cause }) }),
  },
}) {}
