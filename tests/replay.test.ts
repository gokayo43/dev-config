import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import { type Event, replayGate, type Verdict } from "../.github/actions/db-gate/replay.ts";

import { containing } from "./matchers.ts";
import { git, materialise, type Tree } from "./tree.ts";

/**
 * A real Postgres, because the property under test is what a database ends up
 * holding: an upgrade that reaches a different schema from a rebuild is a fact
 * about two databases, and nothing short of two of them can report it. PGlite
 * cannot stand in — the gate builds the upgrade path in a second database on
 * the same server, and PGlite has no second database.
 *
 * Every repo in the suite is a real git repository with a real migrator, so
 * what the gate reads is a history and a lineage rather than a description of
 * one.
 */
const SERVER =
  Bun.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/postgres";

/** The name the gate builds the upgrade path in, which the suite has to clear between cases. */
const UPGRADE = "upgrade_path";

const JOURNALLED = new URL("./journalled-migrator.ts", import.meta.url).pathname;
const REPLAYING = new URL("./replaying-migrator.ts", import.meta.url).pathname;

function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

async function onServer(statements: readonly string[]): Promise<void> {
  const server = new SQL(SERVER);
  for (const statement of statements) await server.unsafe(statement);
  await server.close();
}

const databases: string[] = [];

afterEach(async () => {
  await onServer(
    [...databases.splice(0), UPGRADE].map(
      (name) => `drop database if exists "${name}" with (force)`,
    ),
  );
});

/** An empty database of this case's own, plus the room the gate makes its second one in. */
async function emptyDatabase(): Promise<string> {
  const name = `replay_${databases.length}_${Date.now()}`;
  await onServer([
    `drop database if exists "${UPGRADE}" with (force)`,
    `create database "${name}"`,
  ]);
  databases.push(name);
  return beside(SERVER, name);
}

async function exists(database: string): Promise<boolean> {
  const server = new SQL(SERVER);
  const rows = (await server.unsafe(
    `select 1 from pg_database where datname = '${database}'`,
  )) as unknown[];
  await server.close();
  return rows.length > 0;
}

/** One migration as a lineage holds it: a file, and the journal row that orders it. */
interface Migration {
  readonly tag: string;
  /** The journal's own clock. An applied migration is recognised by this and nothing else. */
  readonly when: number;
  readonly sql: string;
}

/**
 * A drizzle lineage, in the shape `drizzle-kit generate` writes: the journal
 * beside the files it names. Captured from a real generate run — the migrator
 * reads `entries` and refuses a folder without the file.
 */
function lineage(...migrations: readonly Migration[]): Tree {
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: migrations.map(({ when, tag }, idx) => ({
      idx,
      version: "7",
      when,
      tag,
      breakpoints: true,
    })),
  };
  return {
    "drizzle/meta/_journal.json": JSON.stringify(journal, undefined, 2),
    ...Object.fromEntries(migrations.map(({ tag, sql }) => [`drizzle/${tag}.sql`, sql])),
  };
}

const THING = { tag: "0000_thing", when: 1_000 } as const;
const SLUG = { tag: "0001_slug", when: 2_000 } as const;
const OTHER = { tag: "0002_other", when: 3_000 } as const;

const CREATES_THING: Migration = {
  ...THING,
  sql: `CREATE TABLE "thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n`,
};

/** The same change as ADDS_SLUG, made by editing the migration that already created the table. */
const CREATES_THING_WITH_SLUG: Migration = {
  ...THING,
  sql: `CREATE TABLE "thing" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL,\n\t"slug" text\n);\n`,
};

const ADDS_SLUG: Migration = { ...SLUG, sql: `ALTER TABLE "thing" ADD COLUMN "slug" text;\n` };

const CREATES_OTHER: Migration = {
  ...OTHER,
  sql: `CREATE TABLE "other" (\n\t"id" integer PRIMARY KEY NOT NULL\n);\n`,
};

function packaged(migrator: string): Tree {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "fixture",
        private: true,
        type: "module",
        scripts: { "db:migrate": `bun run ${migrator}` },
      },
      undefined,
      2,
    )}\n`,
  };
}

interface Repo {
  readonly root: string;
  /** Every commit in order, so a case can name the one it expects to be upgraded from. */
  readonly revs: string[];
}

const IDENTITY = ["-c", "user.email=gate@example.com", "-c", "user.name=gate"];

/**
 * A repository whose history is the trees given, one commit each. A tree
 * replaces the one before it, so a commit that drops a lineage is written the
 * way it reads: by not mentioning it.
 */
async function fixture(migrator: string, ...trees: readonly Tree[]): Promise<Repo> {
  const [first = {}, ...rest] = trees;
  const root = await materialise({ ...packaged(migrator), ...first });
  const revs: string[] = [];
  let previous: Tree = first;
  for (const tree of [first, ...rest]) {
    if (tree !== first) {
      for (const path of Object.keys(previous)) {
        if (!(path in tree)) await rm(join(root, path), { force: true });
      }
      for (const [path, contents] of Object.entries(tree))
        await Bun.write(join(root, path), contents);
      previous = tree;
    }
    await git(root, ["add", "--all"]);
    await git(root, [...IDENTITY, "commit", "--quiet", "--message", `commit ${revs.length}`]);
    revs.push((await git(root, ["rev-parse", "HEAD"])).trim());
  }
  return { root, revs };
}

/** What a push of this branch tells the gate: the tip it had before. */
function pushedOver(rev: string): Event {
  return { baseRef: "", before: rev };
}

async function replay(repo: Repo, upgrade: Event | undefined): Promise<Verdict> {
  return await replayGate({ root: repo.root, url: await emptyDatabase(), upgrade });
}

/** What the gate threw, as the text a case can read. A rejection is the diagnostic here. */
async function refusal(replaying: Promise<Verdict>): Promise<string> {
  return await replaying.then(
    () => "the gate returned a verdict instead of refusing",
    (error: unknown) => String(error),
  );
}

function messages({ problems }: Verdict): string[] {
  return problems.map(({ message }) => message);
}

describe("replay gate", () => {
  test("a history that rebuilds the schema from empty, twice, passes", async () => {
    const repo = await fixture(JOURNALLED, lineage(CREATES_THING, ADDS_SLUG));
    const verdict = await replay(repo, undefined);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.divergence).toEqual([]);
    expect(verdict.summary).toContain("a second replay leaves it identical");
  });

  // A runner with no journal applies every file on every run, and an unnamed
  // ADD CHECK is the shape that neither errors nor lands twice in the same
  // place: the second replay leaves a second constraint. An exit code says
  // nothing about it, which is the whole reason the dump is what is compared.
  test("a second replay that changes the schema is refused", async () => {
    const repo = await fixture(
      REPLAYING,
      lineage({
        ...THING,
        sql: `CREATE TABLE IF NOT EXISTS "thing" ("id" integer);\nALTER TABLE "thing" ADD CHECK ("id" > 0);\n`,
      }),
    );
    const verdict = await replay(repo, undefined);

    expect(messages(verdict)).toEqual([
      containing("replaying the migrations a second time changed the schema"),
    ]);
    expect(verdict.divergence.join("\n")).toContain("thing_id_check1");
  });

  test("the upgrade path is not built unless it is asked for", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING, ADDS_SLUG),
    );

    await replay(repo, undefined);

    expect(await exists(UPGRADE)).toBe(false);
  });

  test("a forward migration reaches the schema a fresh database gets", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING, ADDS_SLUG),
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.divergence).toEqual([]);
    expect(verdict.summary).toContain("reaches the same schema");
  });

  // The same column, added by editing the migration that had already been
  // applied. The migrator recognises an applied migration by the journal's
  // clock alone, so a deployed database never sees the edit.
  test("rewriting an applied migration is refused", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING_WITH_SLUG),
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
    expect(messages(verdict)[0]).toContain("put the change in a new migration");
    expect(verdict.divergence.join("\n")).toContain("slug");
  });

  // A migration whose journal clock sits behind one the base ref had already
  // applied — what rebasing a branch's generated migration under another's
  // produces. Nothing errors: it is simply never applied anywhere but on a
  // fresh database.
  test("a migration inserted behind an applied one is refused", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING, CREATES_OTHER),
      lineage(CREATES_THING, ADDS_SLUG, CREATES_OTHER),
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
    expect(verdict.divergence.join("\n")).toContain("slug");
  });

  test("a pull request upgrades from where the branch left the base", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING, ADDS_SLUG),
    );
    await git(repo.root, ["update-ref", "refs/remotes/origin/main", repo.revs[0] ?? ""]);

    const verdict = await replay(repo, { baseRef: "main", before: "" });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain((repo.revs[0] ?? "").slice(0, 7));
  });

  // No `before` and no base ref is a merge queue or a workflow_dispatch: the
  // parent commit is the same statement about what is deployed.
  test("with no event to read, the parent commit is the base", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING_WITH_SLUG),
    );
    const verdict = await replay(repo, { baseRef: "", before: "" });

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
  });

  test("a first commit has nothing to upgrade from", async () => {
    const repo = await fixture(JOURNALLED, lineage(CREATES_THING));
    const verdict = await replay(repo, { baseRef: "", before: "" });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("no earlier commit to upgrade from");
    expect(await exists(UPGRADE)).toBe(false);
  });

  test("a base ref that carries no lineage has nothing to upgrade from", async () => {
    const repo = await fixture(JOURNALLED, {}, lineage(CREATES_THING));
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("carries no migration lineage");
    expect(await exists(UPGRADE)).toBe(false);
  });

  // The one way this gate could pass by having been given nothing: a checkout
  // with no history reads as a repo with no base ref.
  test("a shallow checkout is refused rather than skipped", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING, ADDS_SLUG),
    );
    const shallow = join(repo.root, "shallow");
    await git(repo.root, ["clone", "--quiet", "--depth", "1", `file://${repo.root}`, shallow]);

    const refused = await refusal(
      replayGate({
        root: shallow,
        url: await emptyDatabase(),
        upgrade: { baseRef: "", before: "" },
      }),
    );

    expect(refused).toContain("the checkout is shallow");
  });

  test("a base ref that is not in the checkout is refused", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING, ADDS_SLUG),
    );

    const refused = await refusal(replay(repo, { baseRef: "release", before: "" }));

    expect(refused).toContain("refs/remotes/origin/release is not in this checkout");
  });

  // The tree the later steps of the gate — the boot, the ramp — run against has
  // to be the one the branch committed, whichever way the comparison went.
  test("the working tree is the branch's own again afterwards", async () => {
    const repo = await fixture(
      JOURNALLED,
      lineage(CREATES_THING),
      lineage(CREATES_THING_WITH_SLUG),
    );

    await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(await git(repo.root, ["status", "--porcelain"])).toBe("");
    expect(await Bun.file(join(repo.root, `drizzle/${THING.tag}.sql`)).text()).toBe(
      CREATES_THING_WITH_SLUG.sql,
    );
  });
});
