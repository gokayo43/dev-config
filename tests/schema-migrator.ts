/**
 * The `db:migrate` a repo with more than one lineage has to have: drizzle's own
 * migrator, run once per lineage, each keeping its journal in a schema of its
 * own. A repo that pointed every lineage at one journal table would give them a
 * shared high-water mark — `appliedIn` in replay.ts says why that is not a
 * repo shape this gate can be honest about.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { required } from "../.github/actions/_lib/gate.ts";

const url = required("DATABASE_URL", "the migrator applies each lineage to the database it names");

const folders = Bun.argv.slice(2);
if (folders.length === 0) throw new Error("usage: schema-migrator.ts <migrations folder>...");

const client = new SQL(url);
const db = drizzle({ client });
for (const migrationsFolder of folders) {
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: `journal_${migrationsFolder.replaceAll(/[^a-z0-9]/gu, "_")}`,
  });
}
await client.close();
