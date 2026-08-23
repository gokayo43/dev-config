import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import { beside, rows } from "../.github/actions/db-gate/database.ts";
import { replayGate, upgradeDatabase } from "../.github/actions/db-gate/replay.ts";
import { fixtureDatabase, semanticFixtures } from "../.github/actions/db-gate/semantic-fixtures.ts";

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

/** What the gate threw, as the text a case can read. A rejection is the diagnostic here. */
async function refusal(running: Promise<Verdict>): Promise<string> {
  return await running.then(
    () => "the gate returned a verdict instead of refusing",
    (error: unknown) => String(error),
  );
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
      const said = await refusal(ran([DEMANDS_A_KIND]));

      expect(said).toContain("failed applying this branch's migrations onto");
      expect(said).toContain(`holding the rows ${FIXTURES} wrote`);
      expect(said).toContain("not to one that already has rows in it");
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
 * The directory read, which happens before anything is built — so these cases
 * need no database at all, and the swap they are handed refuses to run. A gate
 * that paid for a replay before noticing its fixtures were unpaired would put
 * the slowest possible answer on the cheapest possible mistake, and this stub
 * is what says it does not.
 */
function neverReplays(): Promise<void> {
  throw new Error("the base lineage was replayed before the fixture directory was read");
}

async function reading(fixtures: Tree, dir: string = FIXTURES): Promise<Verdict> {
  const repo = await history({ ...migratesFrom(MIGRATOR, "drizzle"), ...fixtures });
  return await semanticFixtures({
    root: repo.root,
    url: SERVER,
    dir,
    from: "abc1234",
    atBase: neverReplays,
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
    const verdict = await semanticFixtures({
      root: repo.root,
      url: SERVER,
      dir: FIXTURES,
      from: "abc1234",
      atBase: neverReplays,
    });

    expect(messages(verdict)).toEqual([containing("which holds no fixture")]);
    expect(messages(verdict)[0]).toContain("NN-<name>.assert.sql");
  });
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
