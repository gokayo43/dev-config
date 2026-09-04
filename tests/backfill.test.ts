// oxlint-disable-next-line eslint/no-restricted-imports -- scratch databases and evidence directories dropped after each case, not setup it hides — the await using migration is dev-config#85
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import {
  backfillDatabase,
  backfillGate,
  type Evidence,
} from "../.github/actions/db-gate/backfill.ts";
import { rows, textColumn } from "../.github/actions/db-gate/database.ts";

import { containing } from "./matchers.ts";
import { SERVER } from "./postgres.ts";
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

const MIGRATOR = new URL("./journalled-migrator.ts", import.meta.url).pathname;

const CREATES_THING: Migration = {
  tag: "0000_thing",
  when: 1_000,
  sql: `CREATE TABLE "thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL,\n\t"slug" text,\n\t"note" text\n);\nCREATE TABLE "audit" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"what" text NOT NULL\n);\n`,
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
function SEEDS_FOR(table: string): string {
  return `insert into "${table}" ("id", "name") values (1, 'One Thing'), (2, 'Two Thing')`;
}

const SEEDS = SEEDS_FOR("thing");

/** The guarded shape: the second run finds nothing left to do. */
const GUARDED = `update "thing" set "slug" = lower("name") where "slug" is null`;

/** The shape this gate exists to catch: no guard, so every run appends again. */
const APPENDS = `insert into "audit" ("what") select 'backfilled ' || "id" from "thing"`;

/**
 * Tables whose names have to be quoted in the dump, and the two ways a scanner
 * that walks past a quoted name without knowing it is one gets the answer
 * wrong. `aaa_thing` sorts first and `zzz_audit` last, because pg_dump writes
 * tables in name order and each fixture needs the quoted name in a particular
 * place relative to the rows that matter.
 */
function CREATES_APOSTROPHE(): Migration {
  return {
    tag: "0000_quoted",
    when: 1_000,
    sql:
      `CREATE TABLE "aaa_thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n` +
      `CREATE TABLE "it's" (\n\t"id" integer PRIMARY KEY NOT NULL\n);\n` +
      `CREATE TABLE "zzz_audit" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"what" text NOT NULL\n);\n`,
  };
}

function CREATES_DOUBLE_DASH(): Migration {
  return {
    tag: "0000_quoted",
    when: 1_000,
    sql:
      `CREATE TABLE "aaa_thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n` +
      `CREATE TABLE "zzz--audit" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"what" text NOT NULL UNIQUE\n);\n`,
  };
}

/** Rows in `it's` too, so that the quoted name reaches the dump the gate reads. */
const APOSTROPHE_SEEDS = `${SEEDS_FOR("aaa_thing")}; insert into "it's" ("id") values (1)`;

const DOUBLE_DASH_SEEDS = SEEDS_FOR("aaa_thing");

/** Unguarded, into the table that sorts after the quoted name. */
const APPENDS_PAST_QUOTE = `insert into "zzz_audit" ("what") select 'backfilled ' || "id" from "aaa_thing"`;

/**
 * Guarded, into the quoted-name table itself — and guarded by a conflict clause
 * rather than a `where`, so the second run writes no row but still draws from
 * the sequence. That is what makes the `setval` pg_dump writes after the rows
 * differ between the two runs while the rows themselves do not.
 */
const GUARDED_PAST_DASH =
  `insert into "zzz--audit" ("what") select 'backfilled ' || "id" from "aaa_thing"` +
  ` on conflict ("what") do nothing`;

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
    seeded: join(dir, "backfill-seeded.rows"),
    first: join(dir, "backfill-first.rows"),
    second: join(dir, "backfill-second.rows"),
  };
}

interface Ran {
  readonly verdict: Verdict;
  readonly evidence: Evidence;
  readonly database: string;
}

async function running(
  backfill: string,
  seed: string = SEEDS,
  creates: Migration = CREATES_THING,
): Promise<{ verdict: Promise<Verdict>; evidence: Evidence; database: string }> {
  const repo = await history({
    ...migratesFrom(MIGRATOR, "drizzle"),
    ...lineage("drizzle", creates),
    "seed.ts": runs([seed]),
    "backfill.ts": runs([backfill]),
  });
  const evidence = await evidenceDir();
  const database = backfillDatabase(repo.root);
  databases.push(database);
  return {
    verdict: backfillGate({
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

/**
 * The gate against a repo whose migrations build the tables above, with the two
 * commands the caller would have written. Nothing here creates the database the
 * gate works in: making its own is what the gate does, and a suite that made
 * one for it would be the reason nobody noticed it had stopped. `running` is
 * the same thing for the cases that need the evidence paths of a run that
 * throws, which cannot come back through a return.
 */
async function ran(
  backfill: string,
  seed: string = SEEDS,
  creates: Migration = CREATES_THING,
): Promise<Ran> {
  const started = await running(backfill, seed, creates);
  return { verdict: await started.verdict, evidence: started.evidence, database: started.database };
}

const SEEDING = "bun ./seed.ts";
const BACKFILLING = "bun ./backfill.ts";

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

async function exists(database: string): Promise<boolean> {
  const server = new SQL(SERVER);
  const found = await rows(server, `select 1 from pg_database where datname = '${database}'`);
  await server.close();
  return found.length > 0;
}

describe("the backfill check", () => {
  test("a backfill guarded on the state it produces passes", async () => {
    const { verdict } = await ran(GUARDED);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.log).toBeUndefined();
    expect(verdict.note).toContain("leaves the same data when it runs a second time");
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
    expect(verdict.note).toBeUndefined();
    expect(verdict.log).toContain("backfilled 1");
    expect(verdict.log).toContain("the data after a second backfill");
  });

  // The most likely false positive: an unguarded UPDATE. It rewrites every row
  // on the second run — new tuples, new physical positions — and writes the same
  // values into them. What this compares is rows, so that is a pass, and a
  // comparison that had drifted into reading anything about the write itself
  // would refuse a backfill nobody should have to defend.
  test("an unguarded update that writes the same values is the same data", async () => {
    const { verdict } = await ran(`update "thing" set "slug" = lower("name")`);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toContain("leaves the same data");
  });

  // `--inserts` puts raw newlines inside string literals, so a comparison cut
  // into lines holds fragments rather than rows — and sorting is then free to
  // rearrange one row's fragments into another's. This backfill writes one pair
  // of values on a row it has not touched and the other pair on one it has, so
  // the second run swaps the two tails: different rows, identical multiset of
  // line fragments, and a line-wise comparison calls it a pass.
  test("rows that share their fragments with each other are not the same rows", async () => {
    const { verdict } = await ran(
      `update "thing" set "note" = case when "note" is null` +
        ` then (case "id" when 1 then 'A\nB' else 'C\nD' end)` +
        ` else (case "id" when 1 then 'A\nD' else 'C\nB' end) end`,
    );

    expect(messages(verdict)).toEqual([
      containing("running the backfill a second time changed the data"),
    ]);
    expect(verdict.log).toContain("A\nD");
  });

  // The same class from the other side: the second run drops a blank line from
  // *inside* a value. A comparison that filters blank lines before it knows
  // what a statement is drops that one too, and reads two different paragraphs
  // as one.
  test("a blank line inside a value is part of the value", async () => {
    const { verdict } = await ran(
      `update "thing" set "note" = case when "note" is null` +
        ` then 'para one\n\npara two' else 'para one\npara two' end`,
    );

    expect(messages(verdict)).toEqual([
      containing("running the backfill a second time changed the data"),
    ]);
  });

  // A table whose name needs quoting is written back quoted, and the quoted name
  // is data the scanner walks through. Both cases below are the same root — the
  // cutter loses its place on a quoted name — and they are two tests because
  // the two characters break it in opposite directions, so a fix for one does
  // not demonstrate the other.
  //
  // Not a hypothetical pairing: `dataOf` compares whole sorted statements
  // *because* a line-wise reading traded fragments between rows, and a cutter
  // wrong about where a statement ends is that same false verdict by another
  // route.
  //
  // The apostrophe is the dangerous one. It opens a literal that runs to the
  // next `'` in the dump, so the `;` terminators after it stop cutting and the
  // rows of every table sorting after the quoted name fall out of the
  // comparison — out of *both* runs' dumps equally, which is what makes it a
  // pass rather than a crash. The `.rows` evidence is written from the same
  // reading, so it corroborates the wrong answer: a reader checking the gate's
  // work sees two files that agree and no sign of the rows that went missing.
  test("an apostrophe in a table name does not hide what a second run changed", async () => {
    const { verdict } = await ran(APPENDS_PAST_QUOTE, APOSTROPHE_SEEDS, CREATES_APOSTROPHE());

    expect(messages(verdict)).toEqual([
      containing("running the backfill a second time changed the data"),
    ]);
  });

  // The double dash breaks it the other way. It opens a comment that ends at
  // the newline, so nothing is lost — but the `;` that ended the row goes with
  // it, and the row merges with whatever pg_dump wrote next into a single unit
  // that still begins `INSERT INTO ` and so still passes the row filter. What
  // rides in with it is whatever follows: here the `setval` for a sequence,
  // which is exactly what that filter exists to keep out of a comparison, and
  // in general anything at all.
  //
  // The assertion is on the evidence rather than the verdict, because whether a
  // merged unit changes the verdict depends on what happens to sit after the
  // quoted name in the dump — which makes it a bad oracle, not a safe one. What
  // is true either way is that the file the step publishes as the rows it
  // compared has to be rows: one `INSERT` per line, nothing else. With the
  // scanner reading `--` inside a name as a comment, this file carries a
  // `SELECT pg_catalog.setval(...)` and the comment block above it.
  test("a double dash in a table name leaves the comparison rows and nothing else", async () => {
    const { verdict, evidence } = await ran(
      GUARDED_PAST_DASH,
      DOUBLE_DASH_SEEDS,
      CREATES_DOUBLE_DASH(),
    );

    expect(messages(verdict)).toEqual([]);
    const compared = (await Bun.file(evidence.first).text()).trimEnd().split("\n");
    expect(compared.filter((line) => !line.startsWith("INSERT INTO "))).toEqual([]);
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

  // A refused run read all three and is refused on what they say, so all three
  // are there: failing is not a reason to discard the evidence for it.
  test("a refused run still leaves what it had read", async () => {
    const { evidence } = await ran(APPENDS);

    expect(await Bun.file(evidence.seeded).text()).toContain(`'One Thing'`);
    expect(await Bun.file(evidence.first).text()).not.toBe(await Bun.file(evidence.second).text());
  });

  // The run that stopped partway is the other half, and the one the evidence is
  // worth most on: the backfill died on its first run, so the state it was
  // handed is on disk and the two dumps the comparison would have made are not.
  test("a run that stopped partway leaves what it had already read", async () => {
    const started = await running(`select * from "nothing_here"`);
    expect(await refusal(started.verdict)).toContain("backfill-command");

    expect(await Bun.file(started.evidence.seeded).text()).toContain(`'One Thing'`);
    expect(await Bun.file(started.evidence.first).exists()).toBe(false);
    expect(await Bun.file(started.evidence.second).exists()).toBe(false);
  });

  // Two full gate runs in one case, where every other case here is one, so this
  // is the case that trips the default per-test timeout when the suite shares a
  // machine with another run — which review does routinely. The timeout is what
  // it takes for that to stop being a signal about the machine.
  test("the database it builds is gone whichever way it went", async () => {
    const clean = await ran(GUARDED);
    expect(await exists(clean.database)).toBe(false);

    const dirty = await ran(APPENDS);
    expect(await exists(dirty.database)).toBe(false);
  }, 30_000);

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
  const names = await textColumn(
    server,
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    "table_name",
  );
  await server.close();
  return names;
}

/** What the gate threw, as the text a case can read. A rejection is the diagnostic here. */
async function refusal(verdict: Promise<unknown>): Promise<string> {
  return await verdict.then(
    () => "the gate returned a verdict instead of refusing",
    (error: unknown) => String(error),
  );
}
