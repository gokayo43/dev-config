/**
 * The `db:migrate` of a fixture repo on the house stack: drizzle's own migrator
 * over its own journal, run against the database DATABASE_URL names.
 *
 * A program rather than fixture text, because what the suite is asking about is
 * what the real migrator does with a migration it has already applied — see
 * docs/gates/upgrade-path.md — and a hand-written stand-in would only be able
 * to answer what its author already believed.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

const url = Bun.env["DATABASE_URL"];
if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");

const client = new SQL(url);
await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
await client.close();
