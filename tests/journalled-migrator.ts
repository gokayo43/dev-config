/**
 * The `db:migrate` of a fixture repo on the house stack: drizzle's own migrator
 * over its own journal, run against the database DATABASE_URL names.
 *
 * A program rather than fixture text, because what the suite is asking about is
 * what the real migrator does with a migration it has already applied — see
 * docs/gates/upgrade-path.md — and a hand-written stand-in would only be able
 * to answer what its author already believed.
 *
 * The lineage directories are arguments, the way a real migrator has them from
 * its own source: a fixture that relocates or drops a lineage relocates or
 * drops this too, and a monorepo root script naming two of them looks like this.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { required } from "../.github/actions/_lib/gate.ts";

const url = required("DATABASE_URL", "the migrator applies its lineage to the database it names");

const folders = Bun.argv.slice(2);
if (folders.length === 0) throw new Error("usage: journalled-migrator.ts <migrations folder>...");

const client = new SQL(url);
const db = drizzle({ client });
for (const migrationsFolder of folders) await migrate(db, { migrationsFolder });
await client.close();
