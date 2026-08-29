// oxlint-disable-next-line eslint/no-restricted-imports -- scratch databases dropped after each case, not setup it hides — an afterAll would keep one alive per case on a server two runs share; the await using migration is dev-config#85
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import { beside, rows } from "../.github/actions/db-gate/database.ts";
import { replayGate, upgradeDatabase } from "../.github/actions/db-gate/replay.ts";
import { fixtureDatabase } from "../.github/actions/db-gate/semantic-fixtures.ts";

import { containing } from "./matchers.ts";
import { lineage, type Migration, migratesFrom } from "./lineage.ts";
import { history, type Repo, type Tree } from "./tree.ts";

/**
 * A real Postgres and a real migrator, because the property under test is what
 * a *value* means after a migration has run over it. Every stand-in for either
 * would be this suite deciding for itself what `timestamp → timestamptz` does
 * to a row, which is the one thing the gate exists to find out rather than to
 * assume.
 *
 * The whole suite is built around one case: a column whose type converges and
 * whose meaning does not. Both branches below apply the same DDL and reach the
 * same schema, so the upgrade gate passes both — which is what makes them the
 * right fixture for a gate written because a schema comparison cannot see this.
 */
const SERVER =
  Bun.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/postgres";

const MIGRATOR = new URL("./journalled-migrator.ts", import.meta.url).pathname;

const CREATES_EVENT: Migration = {
  tag: "0000_event",
  when: 1_000,
  sql: `CREATE TABLE "event" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"at" timestamp NOT NULL\n);\n`,
};

/**
 * The migration written on a machine whose clock is UTC, which is right for
 * every row its author tried it on. `2026-01-01 12:00:00` in a `timestamp`
 * column is digits with no zone attached; reading them as UTC is a choice, and
 * this is the choice the rows were written under.
 */
const READS_THEM_AS_UTC: Migration = {
  tag: "0001_zone",
  when: 2_000,
  sql: `ALTER TABLE "event" ALTER COLUMN "at" TYPE timestamptz USING "at" AT TIME ZONE 'UTC';\n`,
};

/**
 * The same migration with the other choice made — the shape principles.md's
 * "the meaning shifted" is about. It reaches the *same schema*: `timestamptz`
 * either way, so `pg_dump --schema-only` cannot tell the two apart, and every
 * row in the database has moved thirteen hours.
 */
const READS_THEM_AS_AUCKLAND: Migration = {
  ...READS_THEM_AS_UTC,
  sql: `ALTER TABLE "event" ALTER COLUMN "at" TYPE timestamptz USING "at" AT TIME ZONE 'Pacific/Auckland';\n`,
};

/**
 * The same migration as CREATES_EVENT, edited after it had already been
 * applied. A deployed database keeps the column-less table; a rebuild gets this
 * one — which is the divergence the upgrade path exists to refuse.
 */
const EVENT_WITH_TAG = `CREATE TABLE "event" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"at" timestamp NOT NULL,\n\t"tag" text\n);\n`;

/** A migration that cannot apply to a table with rows in it, which every deployed one has. */
const DEMANDS_A_KIND: Migration = {
  tag: "0001_kind",
  when: 2_000,
  sql: `ALTER TABLE "event" ADD COLUMN "kind" text NOT NULL;\n`,
};

/** The same column, added the way a migration meeting real rows has to add it. */
const ADDS_A_KIND: Migration = {
  ...DEMANDS_A_KIND,
  sql: `ALTER TABLE "event" ADD COLUMN "kind" text;\n`,
};

/** A second lineage's own table, for the case about one this branch stops naming. */
const CREATES_NOTE: Migration = {
  tag: "0000_note",
  when: 1_500,
  sql: `CREATE TABLE "note" (\n\t"id" integer PRIMARY KEY NOT NULL\n);\n`,
};

const FIXTURES = "fixtures";

/** One row, written the way a database deployed at the base ref already holds it. */
const LEGACY_ROW = `insert into "event" ("id", "at") values (1, '2026-01-01 12:00:00');\n`;

/** The current contract, asked of that row after this branch's migrations ran over it. */
const STILL_NOON_UTC =
  `select 'event ' || "id" || ' is no longer the instant it was written as' as violation\n` +
  `from "event" where "at" <> timestamptz '2026-01-01 12:00:00+00';\n`;

const databases: string[] = [];

afterEach(async () => {
  const server = new SQL(SERVER);
  for (const name of databases.splice(0)) {
    await server.unsafe(`drop database if exists "${name}" with (force)`);
  }
  await server.close();
});

/** How many empty databases this suite has asked for, counted the way replay.test.ts counts them. */
let asked = 0;

async function emptyDatabase(): Promise<string> {
  const name = `fixtures_${process.pid}_${asked++}`;
  const server = new SQL(SERVER);
  await server.unsafe(`drop database if exists "${name}" with (force)`);
  await server.unsafe(`create database "${name}"`);
  await server.close();
  databases.push(name);
  return beside(SERVER, name);
}

/**
 * A repo whose history is the base ref's lineage and then this branch's, with a
 * fixture directory of the caller's choosing. The gate is driven through
 * `replayGate`, because the fixtures are written into the base replay it owns:
 * a suite that reached past it would be grading the fixture gate against a
 * database this repo's wiring never builds.
 */
async function repoWith(head: readonly Migration[], fixtures: Tree): Promise<Repo> {
  return await history(
    { ...migratesFrom(MIGRATOR, "drizzle"), ...lineage("drizzle", CREATES_EVENT) },
    {
      ...migratesFrom(MIGRATOR, "drizzle"),
      ...lineage("drizzle", CREATES_EVENT, ...head),
      ...fixtures,
    },
  );
}

const NOON_UTC_FIXTURE: Tree = {
  [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
  [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC,
};

async function ran(
  head: readonly Migration[],
  fixtures: Tree = NOON_UTC_FIXTURE,
  dir: string = FIXTURES,
): Promise<Verdict> {
  const repo = await repoWith(head, fixtures);
  databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
  return await replayGate({
    root: repo.root,
    url: await emptyDatabase(),
    upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
    fixtures: dir,
  });
}

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

/** Every database on the server, so a case can say the gate left none of its own behind. */
async function present(name: string): Promise<boolean> {
  const server = new SQL(SERVER);
  const found = await rows(server, `select 1 from pg_database where datname = '${name}'`);
  await server.close();
  return found.length > 0;
}

const TIMEOUT = 60_000;

describe("the semantic-fixture gate", () => {
  test(
    "legacy rows that still mean what they meant pass, and the note says so",
    async () => {
      const verdict = await ran([READS_THEM_AS_UTC]);

      expect(messages(verdict)).toEqual([]);
      expect(verdict.note).toContain("reaches the same schema");
      expect(verdict.note).toContain("every assertion coming back empty");
    },
    TIMEOUT,
  );

  // The whole reason this gate exists, and the case the upgrade gate cannot
  // reach: both branches apply DDL that lands on `timestamptz`, so the schema
  // comparison passes — and every row the deployed database holds has moved
  // thirteen hours. An implementation that read the assertion's exit status
  // rather than its rows, or that took a non-empty answer as an answer rather
  // than as a violation, passes this too.
  test(
    "a migration that converges on the schema and moves the rows is refused",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND]);

      expect(messages(verdict)).toEqual([
        containing("event 1 is no longer the instant it was written as"),
      ]);
      expect(messages(verdict)[0]).toContain("Fix the migration that produced it");
      // The upgrade gate saw nothing, which is the point: it says the schemas
      // agree in the same verdict this says the data does not.
      expect(verdict.note).toContain("reaches the same schema");
      expect(verdict.problems[0]?.file).toBe(`${FIXTURES}/01-legacy-events.assert.sql`);
    },
    TIMEOUT,
  );

  // The property the whole gate rests on. A fixture that could name a column
  // only this branch adds would be a fixture written against HEAD — which is
  // application code's view of the data, testing the new semantics against
  // themselves. The database refuses it because the fixtures run before the
  // branch's migrations, and this case is what says they do.
  test(
    "a fixture that names a column this branch adds is refused as not base-compatible",
    async () => {
      const verdict = await ran([ADDS_A_KIND], {
        [`${FIXTURES}/01-legacy-events.sql`]: `insert into "event" ("id", "at", "kind") values (1, '2026-01-01 12:00:00', 'note');\n`,
        [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC,
      });

      expect(messages(verdict)).toEqual([
        containing(`${FIXTURES}/01-legacy-events.sql did not apply to a database built from`),
      ]);
      expect(messages(verdict)[0]).toContain(`column "kind" of relation "event" does not exist`);
      expect(messages(verdict)[0]).toContain("may name only what");
    },
    TIMEOUT,
  );

  // A migration is written against a database the developer has just rebuilt,
  // which is empty. Every deployed one has rows, and this is the class that
  // only ever fails on the deploy: the fixtures are what put rows there before
  // the branch's migrations run.
  test(
    "a migration that cannot apply to a database with rows in it says which rows",
    async () => {
      const verdict = await ran([DEMANDS_A_KIND]);

      expect(messages(verdict)).toEqual([
        containing("failed applying this branch's migrations onto"),
      ]);
      expect(messages(verdict)[0]).toContain(`holding the rows ${FIXTURES} wrote`);
      expect(messages(verdict)[0]).toContain("not to one that already has rows in it");
      // Graded, not thrown: the upgrade path's own verdict is still in the
      // envelope beside it.
      expect(verdict.note).toContain("reaches the same schema");
    },
    TIMEOUT,
  );

  // The whole reason a migrator refusal is a verdict rather than a throw. This
  // branch carries two independent faults — an already-applied migration edited
  // under the upgrade path, and a new one that cannot meet rows — and an author
  // has to be told about both in one run. A throw out of the fixture half
  // carries the schema half's finding away with it: the wrong implementation
  // here reports only the migrator, and the divergence vanishes.
  test(
    "a branch that both diverges and breaks its rows reports both faults",
    async () => {
      const repo = await history(
        { ...migratesFrom(MIGRATOR, "drizzle"), ...lineage("drizzle", CREATES_EVENT) },
        {
          ...migratesFrom(MIGRATOR, "drizzle"),
          // The applied migration, edited: fresh and upgraded part company.
          ...lineage("drizzle", { ...CREATES_EVENT, sql: EVENT_WITH_TAG }, DEMANDS_A_KIND),
          ...NOON_UTC_FIXTURE,
        },
      );
      databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).toEqual([
        containing("does not reach the schema this branch builds from empty"),
        containing("failed applying this branch's migrations onto"),
      ]);
      expect(messages(verdict)[1]).toContain(`holding the rows ${FIXTURES} wrote`);
    },
    TIMEOUT,
  );

  // Numbered because the order is part of the fixture: a row a later file
  // updates is a row an earlier one wrote, which is how a real history of rows
  // accumulates. Directory order is a fact about the filesystem, and an
  // implementation that took it would apply these two in whichever order the
  // machine handed them back.
  test(
    "fixtures apply in the order their names give them",
    async () => {
      const verdict = await ran([READS_THEM_AS_UTC], {
        [`${FIXTURES}/02-corrected.sql`]: `update "event" set "at" = '2026-01-01 12:00:00';\n`,
        [`${FIXTURES}/02-corrected.assert.sql`]: STILL_NOON_UTC,
        [`${FIXTURES}/01-legacy-events.sql`]: `insert into "event" ("id", "at") values (1, '1999-01-01 00:00:00');\n`,
        [`${FIXTURES}/01-legacy-events.assert.sql`]:
          `select 'event ' || "id" || ' was never corrected' as violation\n` +
          `from "event" where "at" <> timestamptz '2026-01-01 12:00:00+00';\n`,
      });

      expect(messages(verdict)).toEqual([]);
    },
    TIMEOUT,
  );

  // A fixture is a file, not a statement: the rows a deployed database holds
  // arrive as however many inserts it takes. The whole file goes to Postgres as
  // one query string, and the wrong implementation this kills is the one that
  // runs only the first statement in it — which passes every other case in this
  // suite, because every other fixture here has exactly one.
  test(
    "a fixture of several statements applies all of them",
    async () => {
      const verdict = await ran([READS_THEM_AS_UTC], {
        [`${FIXTURES}/01-legacy-events.sql`]:
          `insert into "event" ("id", "at") values (1, '2026-01-01 12:00:00');\n` +
          `insert into "event" ("id", "at") values (2, '2026-01-01 12:00:00');\n` +
          `insert into "event" ("id", "at") values (3, '2026-01-01 12:00:00');\n`,
        [`${FIXTURES}/01-legacy-events.assert.sql`]:
          `select 'the fixture left ' || count(*) || ' of its 3 rows' as violation\n` +
          `from "event" having count(*) <> 3;\n`,
      });

      expect(messages(verdict)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the database the caller declared is untouched by any of it",
    async () => {
      const url = await emptyDatabase();
      const repo = await repoWith([READS_THEM_AS_UTC], NOON_UTC_FIXTURE);
      databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
      await replayGate({
        root: repo.root,
        url,
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      const declared = new SQL(url);
      const found = await rows(declared, `select * from "event"`);
      await declared.close();
      expect(found).toEqual([]);
    },
    TIMEOUT,
  );

  // Whichever way it went: a gate that left its database behind on a refusal
  // would leave one per red build on a server two runs share.
  test(
    "the database it builds is gone whichever way it went",
    async () => {
      const repo = await repoWith([READS_THEM_AS_AUCKLAND], NOON_UTC_FIXTURE);
      const own = fixtureDatabase(repo.root);
      databases.push(own, upgradeDatabase(repo.root));
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).not.toEqual([]);
      expect(await present(own)).toBe(false);
    },
    TIMEOUT,
  );
});

/**
 * The directory cases drive the whole gate, because the whole gate is what has
 * to refuse them cheaply. `replayGate` reads the directory beside its own input
 * guard, ahead of the first migrator run — so a case here needs no database,
 * and the bogus URL below is what says so: reaching a database at all would
 * fail these outright rather than quietly costing a replay.
 */
async function reading(fixtures: Tree, dir: string = FIXTURES): Promise<Verdict> {
  const repo = await history({ ...migratesFrom(MIGRATOR, "drizzle"), ...fixtures });
  return await replayGate({
    root: repo.root,
    url: "postgres://nobody@127.0.0.1:1/no-database-should-be-reached",
    upgrade: { baseRef: "", before: "" },
    fixtures: dir,
  });
}

describe("the fixture directory", () => {
  test("a fixture with no assertion beside it asserts nothing, and is refused", async () => {
    const verdict = await reading({ [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW });

    expect(messages(verdict)).toEqual([
      containing(`${FIXTURES}/01-legacy-events.sql has no 01-legacy-events.assert.sql beside it`),
    ]);
    expect(verdict.problems[0]?.file).toBe(`${FIXTURES}/01-legacy-events.sql`);
  });

  test("an assertion with no fixture beside it asks about no rows, and is refused", async () => {
    const verdict = await reading({ [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC });

    expect(messages(verdict)).toEqual([
      containing(`${FIXTURES}/01-legacy-events.assert.sql has no 01-legacy-events.sql beside it`),
    ]);
  });

  // Every unpaired file at once, rather than the first: one edit to make, and
  // one run to be told the whole of it.
  test("every unpaired file is named in one run", async () => {
    const verdict = await reading({
      [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
      [`${FIXTURES}/02-more.sql`]: LEGACY_ROW,
    });

    expect(messages(verdict)).toEqual([
      containing("01-legacy-events.assert.sql beside it"),
      containing("02-more.assert.sql beside it"),
    ]);
  });

  // A file nobody spelled correctly must not sit in the directory looking like
  // a fixture that runs. `01-legacy.SQL` is the whole class.
  test("a file that is not a fixture is refused rather than skipped", async () => {
    const verdict = await reading({
      [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
      [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC,
      [`${FIXTURES}/02-legacy.SQL`]: LEGACY_ROW,
    });

    expect(messages(verdict)).toEqual([containing("02-legacy.SQL, which is not a fixture")]);
  });

  test("a directory that is not there is refused rather than passed", async () => {
    const verdict = await reading({}, "nowhere");

    expect(messages(verdict)).toEqual([
      containing("semantic-fixtures names nowhere, which this project does not have"),
    ]);
    expect(messages(verdict)[0]).toContain(
      "a gate pointed at nothing passes without having looked",
    );
  });

  // Without this the gate builds a database, replays the base ref into it,
  // migrates it and asserts nothing — a pass with no fixture behind it, which
  // is a gate that passed by not having looked.
  test("a directory holding no fixture is refused rather than passed", async () => {
    const repo = await history({ ...migratesFrom(MIGRATOR, "drizzle") });
    await mkdir(join(repo.root, FIXTURES), { recursive: true });
    const verdict = await replayGate({
      root: repo.root,
      url: "postgres://nobody@127.0.0.1:1/no-database-should-be-reached",
      upgrade: { baseRef: "", before: "" },
      fixtures: FIXTURES,
    });

    expect(messages(verdict)).toEqual([containing("which holds no fixture")]);
    expect(messages(verdict)[0]).toContain("NN-<name>.assert.sql");
  });
});

/**
 * The class the CTE wrapper and the row-count rule exist to make
 * unrepresentable: a pair that looks like a fixture, runs without error, and
 * asserts nothing. Every case here was **green** before, against the Auckland
 * migration that moves every row thirteen hours — which is the wrong
 * implementation each of them kills.
 */
describe("a pair that asserts nothing", () => {
  test(
    "an assertion that is an insert rather than a select is refused",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
        [`${FIXTURES}/01-legacy-events.assert.sql`]: `insert into "event" ("id", "at") values (2, '2026-01-01 12:00:00');\n`,
      });

      expect(messages(verdict)).toEqual([containing("is not an assertion this can read")]);
      expect(messages(verdict)[0]).toContain("does not have a RETURNING clause");
    },
    TIMEOUT,
  );

  // The sharpest member: a `delete` answered `[]` exactly as an empty select
  // does, so the pair passed *and* took the next pair's rows with it — the
  // second assertion then found nothing to report either.
  test(
    "an assertion that deletes is refused, and the next pair's rows survive it",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-first.sql`]: LEGACY_ROW,
        [`${FIXTURES}/01-first.assert.sql`]: `delete from "event";\n`,
        [`${FIXTURES}/02-second.sql`]: `insert into "event" ("id", "at") values (2, '2026-01-01 12:00:00');\n`,
        [`${FIXTURES}/02-second.assert.sql`]: STILL_NOON_UTC,
      });

      expect(messages(verdict)).toEqual([
        containing("01-first.assert.sql is not an assertion this can read"),
        containing("event 1 is no longer the instant it was written as"),
        containing("event 2 is no longer the instant it was written as"),
      ]);
    },
    TIMEOUT,
  );

  // The one write the wrapper cannot see. A nested data-modifying CTE is
  // refused by the wrapper itself — Postgres wants those at the top level — but
  // a plain `select` calling a VOLATILE function that writes parses cleanly and
  // has the same effect. The read-only session is what refuses it, which is why
  // both are here rather than either.
  test(
    "an assertion whose function writes is refused by the read-only session",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-legacy-events.sql`]:
          `create function "wipe"() returns integer as $$ begin delete from "event"; return 1; end; $$ language plpgsql volatile;\n` +
          LEGACY_ROW,
        [`${FIXTURES}/01-legacy-events.assert.sql`]: `select 'gone ' || "wipe"() as violation;\n`,
      });

      expect(messages(verdict)).toEqual([containing("is not an assertion this can read")]);
      expect(messages(verdict)[0]).toContain("read-only transaction");
    },
    TIMEOUT,
  );

  test.each([
    ["an empty fixture", ""],
    ["a fixture that is only a comment", "-- the rows go here one day\n"],
    [
      "a fixture whose insert matches nothing",
      `insert into "event" select * from "event" where false;\n`,
    ],
  ])(
    "%s writes no rows and is refused",
    async (_written, fixture) => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-legacy-events.sql`]: fixture,
        [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC,
      });

      expect(messages(verdict)).toEqual([
        containing(`${FIXTURES}/01-legacy-events.sql wrote no rows`),
      ]);
    },
    TIMEOUT,
  );

  // A fixture that only reads has written nothing whatever row count the driver
  // reports for it, which is why the command tag decides rather than the count.
  test(
    "a fixture that only selects has written nothing",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-legacy-events.sql`]: `select 1;\n`,
        [`${FIXTURES}/01-legacy-events.assert.sql`]: STILL_NOON_UTC,
      });

      expect(messages(verdict)).toEqual([containing("wrote no rows")]);
    },
    TIMEOUT,
  );
});

describe("what an assertion has to be", () => {
  async function asserting(assertion: string): Promise<Verdict> {
    return await ran([READS_THEM_AS_UTC], {
      [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
      [`${FIXTURES}/01-legacy-events.assert.sql`]: assertion,
    });
  }

  // Not `select *`: a positional read would take whatever column came first as
  // a sentence about the data, and a fixture author renaming a column would
  // silently change what every violation says.
  test(
    "an assertion whose rows carry no violation column is refused",
    async () => {
      const verdict = await asserting(`select "id" from "event";\n`);

      expect(messages(verdict)).toEqual([
        containing(`${FIXTURES}/01-legacy-events.assert.sql is not an assertion this can read`),
      ]);
      expect(messages(verdict)[0]).toContain("violation");
    },
    TIMEOUT,
  );

  // Several statements come back as a list of answers rather than as rows, and
  // nothing can say which of them was the verdict. An implementation that read
  // the first, or the last, would be choosing for the author.
  test(
    "an assertion of several statements is refused rather than half-read",
    async () => {
      const verdict = await asserting(`select 1 as violation; ${STILL_NOON_UTC}`);

      expect(messages(verdict)).toEqual([containing("is not an assertion this can read")]);
      expect(messages(verdict)[0]).toContain("one `select` over the migrated schema");
    },
    TIMEOUT,
  );

  test(
    "an assertion the database refuses names the file rather than the driver",
    async () => {
      const verdict = await asserting(`select "nope" as violation from "event";\n`);

      expect(messages(verdict)).toEqual([containing("is not an assertion this can read")]);
      expect(messages(verdict)[0]).toContain(`column "nope" does not exist`);
    },
    TIMEOUT,
  );
});

describe("what an assertion answers with", () => {
  // A row whose `violation` is NULL is a fault in the assertion — but reading
  // each row as text *threw* on it, and the throw took the real violations
  // found before it. Collected now, so both reach the author.
  test(
    "real violations before a null one are not lost with it",
    async () => {
      const verdict = await ran([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-legacy-events.sql`]:
          LEGACY_ROW + `insert into "event" ("id", "at") values (2, '2026-01-01 12:00:00');\n`,
        [`${FIXTURES}/01-legacy-events.assert.sql`]:
          `select case when "id" = 1 then 'event 1 moved' else null end::text as violation\n` +
          `from "event" where "at" <> timestamptz '2026-01-01 12:00:00+00' order by "id";\n`,
      });

      expect(messages(verdict)).toEqual([
        containing("event 1 moved"),
        containing("whose `violation` is not text"),
      ]);
      expect(messages(verdict)[1]).toContain("(1 of 2)");
    },
    TIMEOUT,
  );

  // The fixture wrote rows into that table a moment earlier, so a table that is
  // gone is a fact about this branch's migration rather than about the SQL in
  // the assertion. Telling the author their assertion is unreadable sends them
  // to the wrong file.
  test(
    "a table this branch's migration dropped names the migration, not the assertion",
    async () => {
      const verdict = await ran(
        [{ tag: "0001_drop", when: 2_000, sql: `DROP TABLE "event";\n` }],
        NOON_UTC_FIXTURE,
      );

      expect(messages(verdict)).toEqual([
        containing("asks about event, which this branch's migrations left the database without"),
      ]);
      expect(messages(verdict)[0]).toContain("not something a migration may drop");
    },
    TIMEOUT,
  );

  // The limit of the case above, said out loud: this gate grades the questions
  // the repo asked, so an assertion that stops asking about the dropped table
  // has nothing left to fail on. What a dropped table did to the rows is the
  // fixture author's to assert, not something the gate can infer.
  test(
    "an assertion that asks only about a surviving table passes, by design",
    async () => {
      const verdict = await ran(
        [
          {
            tag: "0001_drop",
            when: 2_000,
            sql: `DROP TABLE "event";\nCREATE TABLE "record" ("id" integer PRIMARY KEY NOT NULL);\n`,
          },
        ],
        {
          [`${FIXTURES}/01-legacy-events.sql`]: LEGACY_ROW,
          [`${FIXTURES}/01-legacy-events.assert.sql`]: `select 'record left over' as violation from "record";\n`,
        },
      );

      expect(messages(verdict)).toEqual([]);
    },
    TIMEOUT,
  );

  // The default decoder substitutes U+FFFD, which reaches the database as data
  // and comes back as a violation about a row the migration never touched — a
  // finding manufactured by the reader. Refused at the file instead.
  test(
    "a fixture that is not UTF-8 is refused rather than repaired",
    async () => {
      const repo = await repoWith([READS_THEM_AS_UTC], NOON_UTC_FIXTURE);
      // A latin-1 'é' inside the string literal, written after the commit.
      await Bun.write(
        join(repo.root, FIXTURES, "01-legacy-events.sql"),
        new Uint8Array([
          ...new TextEncoder().encode(
            `insert into "event" values (1, '2026-01-01 12:00:00'); -- caf`,
          ),
          0xe9,
          10,
        ]),
      );
      databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).toEqual([containing("is not UTF-8")]);
      expect(messages(verdict)[0]).toContain("comes back as a violation");
    },
    TIMEOUT,
  );

  // The same rule on the other half of the pair. An assertion is read after the
  // fixtures have already been written, so it is refused per file and the
  // fixtures beside it are still graded.
  test(
    "an assertion that is not UTF-8 is refused, and its neighbours are still graded",
    async () => {
      const repo = await repoWith([READS_THEM_AS_AUCKLAND], {
        [`${FIXTURES}/01-broken.sql`]: LEGACY_ROW,
        [`${FIXTURES}/01-broken.assert.sql`]: STILL_NOON_UTC,
        [`${FIXTURES}/02-fine.sql`]: `insert into "event" ("id", "at") values (2, '2026-01-01 12:00:00');\n`,
        [`${FIXTURES}/02-fine.assert.sql`]: STILL_NOON_UTC,
      });
      await Bun.write(
        join(repo.root, FIXTURES, "01-broken.assert.sql"),
        new Uint8Array([
          ...new TextEncoder().encode(`select 'caf`),
          0xe9,
          ...new TextEncoder().encode(`' as violation;`),
          10,
        ]),
      );
      databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).toEqual([
        containing("01-broken.assert.sql is not UTF-8"),
        containing("event 1 is no longer the instant it was written as"),
        containing("event 2 is no longer the instant it was written as"),
      ]);
    },
    TIMEOUT,
  );
});

describe("what the fixtures ride on", () => {
  // Half a pair is a caller who asked for this and would not get it. There is
  // no base replay to write rows into, so nothing would run — and being quietly
  // ignored is the failure mode every input guard in this repo exists for.
  test("fixtures asked for without the upgrade gate are refused", async () => {
    const verdict = await replayGate({
      root: ".",
      url: SERVER,
      upgrade: undefined,
      fixtures: FIXTURES,
    });

    expect(messages(verdict)).toEqual([
      containing(`semantic-fixtures names ${FIXTURES} and upgrade-gate is false`),
    ]);
  });

  // A base ref from before there were migrations has no replay to write into,
  // and a run that said only "the upgrade path is not proved" would read as one
  // where the fixtures had passed.
  // The third branch that cannot reach the fixtures, and the one that reports
  // problems rather than a note: the base replay stopped short of a lineage, so
  // nothing was written into it. Silence here would read as fixtures that ran
  // and passed.
  test(
    "a lineage this branch's migrator never applies says the fixtures did not run either",
    async () => {
      const repo = await history(
        {
          ...migratesFrom(MIGRATOR, "drizzle", "extra"),
          ...lineage("drizzle", CREATES_EVENT),
          ...lineage("extra", CREATES_NOTE),
        },
        {
          // The branch stops naming `extra`, so the base lineage it carried is
          // never applied and the upgrade path cannot be built.
          ...migratesFrom(MIGRATOR, "drizzle"),
          ...lineage("drizzle", CREATES_EVENT, READS_THEM_AS_UTC),
          ...lineage("extra", CREATES_NOTE),
          ...NOON_UTC_FIXTURE,
        },
      );
      databases.push(fixtureDatabase(repo.root), upgradeDatabase(repo.root));
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).toEqual([containing("never applied it")]);
      expect(verdict.note).toContain(`neither are the ${FIXTURES} fixtures written into it`);
    },
    TIMEOUT,
  );

  test(
    "a base ref with no lineage says the fixtures did not run either",
    async () => {
      const repo = await history(
        { ...migratesFrom(MIGRATOR, "drizzle") },
        {
          ...migratesFrom(MIGRATOR, "drizzle"),
          ...lineage("drizzle", CREATES_EVENT),
          ...NOON_UTC_FIXTURE,
        },
      );
      const verdict = await replayGate({
        root: repo.root,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: repo.revs[0] ?? "" },
        fixtures: FIXTURES,
      });

      expect(messages(verdict)).toEqual([]);
      expect(verdict.note).toContain(`neither are the ${FIXTURES} fixtures written into it`);
    },
    TIMEOUT,
  );
});
