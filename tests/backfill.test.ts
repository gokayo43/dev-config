import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import {
  backfillDatabase,
  backfillGate,
  type Evidence,
} from "../.github/actions/db-gate/backfill.ts";
import type { Verdict } from "../.github/actions/_lib/gate.ts";

import { containing } from "./matchers.ts";
import { lineage, type Migration, migratesFrom } from "./lineage.ts";
import { history } from "./tree.ts";

/**
 * A real Postgres, for the reason the replay suite drives one: what a backfill
 * leaves behind is a fact about rows in a database, and a fake that agreed with
 * the gate about it would be grading its own copy of the answer. The gate also
 * builds a database beside the one it is handed, which PGlite has no room for.
 *
 * Both commands under test are real processes reading DATABASE_URL out of their
 * environment, because that is the whole of the contract a repo's backfill has
 * with this gate.
 */
const SERVER =
  Bun.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/postgres";

const MIGRATOR = new URL("./journalled-migrator.ts", import.meta.url).pathname;

const CREATES_THING: Migration = {
  tag: "0000_thing",
  when: 1_000,
  sql: `CREATE TABLE "thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL,\n\t"slug" text\n);\nCREATE TABLE "audit" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"what" text NOT NULL\n);\n`,
};

/** A script the fixture tree carries, run through `bun` against DATABASE_URL. */
function runs(statements: readonly string[]): string {
  return [
    `import { SQL } from "bun";`,
    `const db = new SQL(Bun.env["DATABASE_URL"]);`,
    ...statements.map((sql) => `await db.unsafe(${JSON.stringify(sql)});`),
    `await db.close();`,
    ``,
  ].join("\n");
}

/** Two rows for the backfill to find: the state a phased rollout's expand step leaves. */
const SEEDS = `insert into "thing" ("id", "name") values (1, 'One Thing'), (2, 'Two Thing')`;

/** The guarded shape: the second run finds nothing left to do. */
const GUARDED = `update "thing" set "slug" = lower("name") where "slug" is null`;

/** The shape this gate exists to catch: no guard, so every run appends again. */
const APPENDS = `insert into "audit" ("what") select 'backfilled ' || "id" from "thing"`;

const temps: string[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  const server = new SQL(SERVER);
  for (const name of databases.splice(0)) {
    await server.unsafe(`drop database if exists "${name}" with (force)`);
  }
  await server.close();
});

async function evidenceDir(): Promise<Evidence> {
  const dir = await mkdtemp(join(tmpdir(), "backfill-evidence-"));
  temps.push(dir);
  return {
    seeded: join(dir, "backfill-seeded.sql"),
    first: join(dir, "backfill-first.sql"),
    second: join(dir, "backfill-second.sql"),
  };
}

interface Ran {
  readonly verdict: Verdict;
  readonly evidence: Evidence;
  readonly database: string;
}

/**
 * The gate against a repo whose migrations build the tables above, with the two
 * commands the caller would have written. Nothing here creates the database the
 * gate works in: making its own is what the gate does, and a suite that made
 * one for it would be the reason nobody noticed it had stopped.
 */
async function ran(backfill: string, seed: string = SEEDS): Promise<Ran> {
  const repo = await history({
    ...migratesFrom(MIGRATOR, "drizzle"),
    ...lineage("drizzle", CREATES_THING),
    "seed.ts": runs([seed]),
    "backfill.ts": runs([backfill]),
  });
  const evidence = await evidenceDir();
  const database = backfillDatabase(repo.root);
  databases.push(database);
  return {
    verdict: await backfillGate({
      root: repo.root,
      url: SERVER,
      seed: SEEDING,
      command: BACKFILLING,
      evidence,
    }),
    evidence,
    database,
  };
}

const SEEDING = "bun ./seed.ts";
const BACKFILLING = "bun ./backfill.ts";

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

async function exists(database: string): Promise<boolean> {
  const server = new SQL(SERVER);
  const rows = (await server.unsafe(
    `select 1 from pg_database where datname = '${database}'`,
  )) as unknown[];
  await server.close();
  return rows.length > 0;
}

describe("the backfill check", () => {
  test("a backfill guarded on the state it produces passes", async () => {
    const { verdict } = await ran(GUARDED);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.divergence).toEqual([]);
    expect(verdict.summary).toContain("leaves the same data when it runs a second time");
  });

  // The shape principles.md is written against: an insert with no guard. Run
  // once it is right, run twice it has doubled the rows — and nothing errors,
  // which is why the exit code is not what this gate reads.
  test("a backfill that appends on every run is refused, and says what it added", async () => {
    const { verdict } = await ran(APPENDS);

    expect(messages(verdict)).toEqual([
      containing("running the backfill a second time changed the data"),
    ]);
    expect(messages(verdict)[0]).toContain("guard each statement on the state it produces");
    expect(verdict.summary).toBeUndefined();
    expect(verdict.divergence.join("\n")).toContain("backfilled 1");
    expect(verdict.divergence.join("\n")).toContain("the data after a second backfill");
  });

  // The most likely false positive: an unguarded UPDATE. It rewrites every row
  // on the second run — new tuples, new physical positions — and writes the same
  // values into them. What this compares is rows, so that is a pass, and a
  // comparison that had drifted into reading anything about the write itself
  // would refuse a backfill nobody should have to defend.
  test("an unguarded update that writes the same values is the same data", async () => {
    const { verdict } = await ran(`update "thing" set "slug" = lower("name")`);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("leaves the same data");
  });

  // A backfill against a database the migrations have just built has nothing to
  // find, so it is trivially idempotent — which is exactly the pass that would
  // certify nothing at all.
  test("a seed that writes no rows is refused rather than passed", async () => {
    const { verdict } = await ran(GUARDED, `select 1`);

    expect(messages(verdict)).toEqual([containing("left no rows behind")]);
    expect(messages(verdict)[0]).toContain("compare two empty databases");
  });

  test("the three dumps it compared are left where the run can publish them", async () => {
    const { evidence } = await ran(GUARDED);

    expect(await Bun.file(evidence.seeded).text()).toContain(`'One Thing'`);
    expect(await Bun.file(evidence.seeded).text()).not.toContain(`'one thing'`);
    expect(await Bun.file(evidence.first).text()).toContain(`'one thing'`);
    expect(await Bun.file(evidence.second).text()).toBe(await Bun.file(evidence.first).text());
  });

  // The evidence is worth most on the run that failed, which is the one that
  // stopped before writing all of it.
  test("a refused run still leaves what it had read", async () => {
    const { evidence } = await ran(APPENDS);

    expect(await Bun.file(evidence.seeded).text()).toContain(`'One Thing'`);
    expect(await Bun.file(evidence.first).text()).not.toBe(await Bun.file(evidence.second).text());
  });

  test("the database it builds is gone whichever way it went", async () => {
    const clean = await ran(GUARDED);
    expect(await exists(clean.database)).toBe(false);

    const dirty = await ran(APPENDS);
    expect(await exists(dirty.database)).toBe(false);
  });

  // The declared database is what the app boots against a few steps later, and
  // the seed's rows have no business being in it.
  test("the database the caller declared is untouched", async () => {
    const before = await tables();
    await ran(GUARDED);
    expect(await tables()).toEqual(before);
  });

  // Half a pair is a caller who asked for this and would not get it. Silence is
  // the failure mode every input guard in check.yml exists to prevent.
  test("a seed with no backfill beside it is refused", async () => {
    const verdict = await backfillGate({
      root: ".",
      url: SERVER,
      seed: SEEDING,
      command: "",
      evidence: await evidenceDir(),
    });

    expect(messages(verdict)).toEqual([
      containing("backfill-seed is set and backfill-command is empty"),
    ]);
  });

  test("a backfill with no seed beside it is refused", async () => {
    const verdict = await backfillGate({
      root: ".",
      url: SERVER,
      seed: "",
      command: BACKFILLING,
      evidence: await evidenceDir(),
    });

    expect(messages(verdict)).toEqual([
      containing("backfill-command is set and backfill-seed is empty"),
    ]);
    expect(messages(verdict)[0]).toContain("running it twice proves nothing");
  });

  // A command that dies is the repo's own error, so its output goes to the log
  // and the diagnostic says which of the three runs it was — the second one
  // having succeeded on the first is a different bug from the first failing.
  test("a seed that fails says so, naming what it was for", async () => {
    const failing = ran(GUARDED, `select * from "nothing_here"`);

    expect(await refusal(failing)).toContain("backfill-seed (`bun ./seed.ts`) failed");
  });

  test("a backfill that fails on its second run only says which run it was", async () => {
    // Idempotent in data and not in what it can survive: the second run meets a
    // table the first one dropped.
    const failing = ran(`drop table "audit"`);

    const said = await refusal(failing);
    expect(said).toContain("failed on its second run");
    expect(said).toContain("having just succeeded on the first");
  });
});

/** Every table on the declared database, to say that the gate wrote none of them. */
async function tables(): Promise<string[]> {
  const server = new SQL(SERVER);
  const rows = (await server.unsafe(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  )) as { table_name: string }[];
  await server.close();
  return rows.map(({ table_name }) => table_name);
}

/** What the gate threw, as the text a case can read. A rejection is the diagnostic here. */
async function refusal(running: Promise<Ran>): Promise<string> {
  return await running.then(
    () => "the gate returned a verdict instead of refusing",
    (error: unknown) => String(error),
  );
}
