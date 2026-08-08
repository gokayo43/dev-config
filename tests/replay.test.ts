import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import type { Event } from "../.github/actions/_lib/gate.ts";
import { beside } from "../.github/actions/db-gate/database.ts";
import { replayGate, upgradeDatabase, type Verdict } from "../.github/actions/db-gate/replay.ts";

import { containing } from "./matchers.ts";
import { git, history, IDENTITY, type Repo, type Tree, under } from "./tree.ts";

/**
 * A real Postgres, because the property under test is what a database ends up
 * holding: an upgrade that reaches a different schema from a rebuild is a fact
 * about two databases, and nothing short of two of them can report it. PGlite
 * cannot stand in — the gate builds the upgrade path in a second database on
 * the same server, and PGlite has no second database.
 *
 * Every repo in the suite is a real git repository with a real migrator, so
 * what the gate reads is a history and a lineage rather than a description of
 * one. Nothing here clears the database the gate builds between cases: the gate
 * drops it, and a suite that tidied up after it would be the reason nobody
 * noticed it had stopped.
 *
 * Every name this suite puts on the server carries the process it came from, and
 * the gate's own carries the checkout it is replaying — so a second run of this
 * suite against the same Postgres, which is what two worktrees under review
 * produce, shares nothing with the first.
 */
const SERVER =
  Bun.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/postgres";

const JOURNALLED = new URL("./journalled-migrator.ts", import.meta.url).pathname;
const REPLAYING = new URL("./replaying-migrator.ts", import.meta.url).pathname;

async function onServer(statements: readonly string[]): Promise<void> {
  const server = new SQL(SERVER);
  for (const statement of statements) await server.unsafe(statement);
  await server.close();
}

const databases: string[] = [];

afterEach(async () => {
  await onServer(
    databases.splice(0).map((name) => `drop database if exists "${name}" with (force)`),
  );
});

/**
 * How many this suite has asked for. Counted rather than read off `databases`,
 * whose length is only true until the first `await` below: two cases running at
 * once both see the same length and ask for the same name, and the second is a
 * 23505 on `pg_database` rather than a database.
 */
let asked = 0;

/**
 * An empty database of this case's own — and of this process's, so that two
 * runs of the suite against one server never name the same database. Dropped
 * before it is created for the reason the gate drops its own first: a run killed
 * mid-case leaves databases behind, and a pid the kernel has since handed out
 * again would otherwise meet them as a name it cannot use.
 */
async function emptyDatabase(): Promise<string> {
  const name = `replay_${process.pid}_${asked++}`;
  await onServer([`drop database if exists "${name}" with (force)`, `create database "${name}"`]);
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
 * A drizzle lineage under `dir`, in the shape `drizzle-kit generate` writes: the
 * journal beside the files it names. Captured from a real generate run — the
 * migrator reads `entries` and refuses a folder without the file.
 */
function lineage(dir: string, ...migrations: readonly Migration[]): Tree {
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
    [`${dir}/meta/_journal.json`]: JSON.stringify(journal, undefined, 2),
    ...Object.fromEntries(migrations.map(({ tag, sql }) => [`${dir}/${tag}.sql`, sql])),
  };
}

/** The repo's declaration of how it migrates, and of where its lineages are. */
function migratesFrom(migrator: string, ...dirs: readonly string[]): Tree {
  return scripted(`bun run ${migrator} ${dirs.map((dir) => `./${dir}`).join(" ")}`);
}

function scripted(script: string): Tree {
  return {
    "package.json": `${JSON.stringify(
      { name: "fixture", private: true, type: "module", scripts: { "db:migrate": script } },
      undefined,
      2,
    )}\n`,
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

/** A second lineage's own table, for the cases about more than one of them. */
const CREATES_NOTE: Migration = {
  tag: "0000_note",
  when: 1_500,
  sql: `CREATE TABLE "note" (\n\t"id" integer PRIMARY KEY NOT NULL\n);\n`,
};

/** What a push of this branch tells the gate: the tip it had before. */
function pushedOver(rev: string): Event {
  return { baseRef: "", before: rev };
}

async function replay(repo: Repo, upgrade: Event | undefined): Promise<Verdict> {
  return await replayIn(repo.root, upgrade);
}

/** The gate against a root that is not the repository's, which is what working-directory can be. */
async function replayIn(root: string, upgrade: Event | undefined): Promise<Verdict> {
  return await replayGate({ root, url: await emptyDatabase(), upgrade });
}

/** git with something on stdin, for the plumbing that builds a tree by hand. */
async function gitFed(cwd: string, args: readonly string[], stdin: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
  return stdout.trim();
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
    const repo = await history({
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
    });
    const verdict = await replay(repo, undefined);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.divergence).toEqual([]);
    expect(verdict.summary).toContain("a second replay leaves it identical");
  });

  // The shape the whole gate leads with: a migration that only applies to a
  // database that has already been migrated. It succeeded where it was written,
  // against a table an earlier migration has since dropped, and aborts the
  // first time the history runs onto nothing.
  test("a history that cannot rebuild from empty says which replay failed", async () => {
    const repo = await history({
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage(
        "drizzle",
        CREATES_THING,
        { ...SLUG, sql: `DROP TABLE "thing" CASCADE;\n` },
        { ...OTHER, sql: `ALTER TABLE "thing" DROP CONSTRAINT "thing_pkey";\n` },
      ),
    });

    const refused = await refusal(replay(repo, undefined));

    expect(refused).toContain("failed replaying the history from empty");
    expect(refused).toContain("aborts here and nowhere else");
  });

  // A runner with no journal applies every file on every run, and an unnamed
  // ADD CHECK is the shape that neither errors nor lands twice in the same
  // place: the second replay leaves a second constraint. An exit code says
  // nothing about it, which is the whole reason the dump is what is compared.
  test("a second replay that changes the schema is refused", async () => {
    const repo = await history({
      ...migratesFrom(REPLAYING, "drizzle"),
      ...lineage("drizzle", {
        ...THING,
        sql: `CREATE TABLE IF NOT EXISTS "thing" ("id" integer);\nALTER TABLE "thing" ADD CHECK ("id" > 0);\n`,
      }),
    });
    const verdict = await replay(repo, undefined);

    expect(messages(verdict)).toEqual([
      containing("replaying the migrations a second time changed the schema"),
    ]);
    expect(verdict.summary).toBeUndefined();
    expect(verdict.divergence.join("\n")).toContain("thing_id_check1");
  });

  // Green on a tree whose rewritten migration the upgrade path would refuse, so
  // what this asserts is that the upgrade path did not run — which no query
  // could tell afterwards, since the gate drops the database it builds.
  test("the upgrade path is not replayed unless it is asked for", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING_WITH_SLUG) },
    );
    const verdict = await replay(repo, undefined);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toBe(
      "replay: the migrations rebuild the schema from empty, and a second replay leaves it identical",
    );
  });

  test("a forward migration reaches the schema a fresh database gets", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.divergence).toEqual([]);
    expect(verdict.summary).toContain("reaches the same schema");
    expect(verdict.summary).toContain("drizzle");
  });

  // The same column, added by editing the migration that had already been
  // applied. The migrator recognises an applied migration by the journal's
  // clock alone, so a deployed database never sees the edit.
  test("rewriting an applied migration is refused", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING_WITH_SLUG) },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
    expect(messages(verdict)[0]).toContain("put the change in a new migration");
    expect(verdict.summary).toBeUndefined();
    expect(verdict.divergence.join("\n")).toContain("slug");
  });

  // A migration whose journal clock sits behind one the base ref had already
  // applied — what rebasing a branch's generated migration under another's
  // produces. Nothing errors: it is simply never applied anywhere but on a
  // fresh database.
  test("a migration inserted behind an applied one is refused", async () => {
    const repo = await history(
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, CREATES_OTHER),
      },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG, CREATES_OTHER),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
    expect(verdict.divergence.join("\n")).toContain("slug");
  });

  // The lineage the base ref names is the one that has to be replayed. Reading
  // the branch's directories instead would find `migrations`, fail to match it
  // against anything at the base ref, and pass on the strength of a lineage
  // nobody looked for — with the rewritten migration inside it.
  test("relocating a lineage is refused, rewrite and all", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "migrations"),
        ...lineage("migrations", CREATES_THING_WITH_SLUG),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("carries the migration lineage drizzle and this tree does not"),
    ]);
    expect(messages(verdict)[0]).toContain("strands every database");
  });

  test("deleting one of two lineages is refused", async () => {
    const repo = await history(
      {
        ...migratesFrom(JOURNALLED, "db/thing", "db/note"),
        ...lineage("db/thing", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
      { ...migratesFrom(JOURNALLED, "db/thing"), ...lineage("db/thing", CREATES_THING) },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("carries the migration lineage db/note and this tree does not"),
    ]);
  });

  // The other half of that rule: a lineage the base ref never had is this
  // branch's own, and replaying it from empty is exactly what a deploy does
  // with it. Nothing is swapped, and the gate still holds the pair.
  test("a lineage the base ref never had is replayed from empty", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "db/thing"), ...lineage("db/thing", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "db/thing", "db/note"),
        ...lineage("db/thing", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("reaches the same schema");
  });

  // A lineage is replayed by replacing its directory, so the project root being
  // one would mean replacing the checkout. Refused where it is read, before
  // anything is moved: the tree is still the branch's afterwards.
  test("a lineage at the project root is refused rather than replaced", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "."), ...lineage(".", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "."), ...lineage(".", CREATES_THING, ADDS_SLUG) },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("the project root is itself a migration lineage"),
    ]);
    expect(await Bun.file(join(repo.root, "package.json")).exists()).toBe(true);
    expect(await Bun.file(join(repo.root, ".git/HEAD")).exists()).toBe(true);
  });

  // The delete reaches the branch's tree, so the invariant has to be read over
  // it as well: this lineage is not in the base ref's set, and replacing `db`
  // would take it with it. Without that read the swap deletes it and the
  // migrator reports a missing journal for a file the author never touched.
  test("a lineage this branch nests inside a base one is refused", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "db"), ...lineage("db", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "db", "db/note"),
        ...lineage("db", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("the migration lineage db/note is inside the lineage db"),
    ]);
  });

  test("a lineage inside another lineage is refused", async () => {
    const repo = await history(
      {
        ...migratesFrom(JOURNALLED, "db", "db/note"),
        ...lineage("db", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
      {
        ...migratesFrom(JOURNALLED, "db", "db/note"),
        ...lineage("db", CREATES_THING, ADDS_SLUG),
        ...lineage("db/note", CREATES_NOTE),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("the migration lineage db/note is inside the lineage db"),
    ]);
  });

  test("the database the gate builds is gone whichever way it went", async () => {
    const converges = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );
    await replay(converges, pushedOver(converges.revs[0] ?? ""));
    expect(await exists(upgradeDatabase(converges.root))).toBe(false);

    const diverges = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING_WITH_SLUG) },
    );
    await replay(diverges, pushedOver(diverges.revs[0] ?? ""));
    expect(await exists(upgradeDatabase(diverges.root))).toBe(false);
  });

  // Two worktrees of one repo under review is two runs of this gate against one
  // Postgres, which is what a review pipeline produces. Driven at once rather
  // than in sequence, because the collision is one run's `drop ... with (force)`
  // landing while the other is migrating into that database: a sequential pair
  // shares the name and never notices.
  test("two checkouts replaying at once do not drop each other's database", async () => {
    const tree = [
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING, ADDS_SLUG) },
    ];
    const [one, other] = await Promise.all([history(...tree), history(...tree)]);

    const verdicts = await Promise.all(
      [one, other].map(async (repo) => await replay(repo, pushedOver(repo.revs[0] ?? ""))),
    );

    expect(verdicts.map(messages)).toEqual([[], []]);
    for (const verdict of verdicts) expect(verdict.summary).toContain("reaches the same schema");
    expect(upgradeDatabase(one.root)).not.toBe(upgradeDatabase(other.root));
  });

  // What a run killed between the create and the drop leaves behind. The next
  // run makes its own room rather than failing with a 42P04 about a database
  // whose name the author never chose — which is also what the name being
  // derived from the checkout rather than from a clock is for: this is the same
  // checkout, so this is the same name.
  test("a database left by a killed run does not fail the next one", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );
    await onServer([`create database "${upgradeDatabase(repo.root)}"`]);

    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("reaches the same schema");
  });

  test("a pull request upgrades from where the branch left the base", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );
    await git(repo.root, ["update-ref", "refs/remotes/origin/main", repo.revs[0] ?? ""]);

    const verdict = await replay(repo, { baseRef: "main", before: "" });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain((repo.revs[0] ?? "").slice(0, 7));
  });

  // No `before` and no base ref is a merge queue or a workflow_dispatch: the
  // parent commit is the same statement about what is deployed.
  test("with no event to read, the parent commit is the base", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING_WITH_SLUG) },
    );
    const verdict = await replay(repo, { baseRef: "", before: "" });

    expect(messages(verdict)).toEqual([
      containing("does not reach the schema this branch builds from empty"),
    ]);
  });

  test("a first commit has nothing to upgrade from", async () => {
    const repo = await history({
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage("drizzle", CREATES_THING),
    });
    const verdict = await replay(repo, { baseRef: "", before: "" });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("no earlier commit to upgrade from");
  });

  test("a base ref that carries no lineage has nothing to upgrade from", async () => {
    const repo = await history(migratesFrom(JOURNALLED, "drizzle"), {
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage("drizzle", CREATES_THING),
    });
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("carries no migration lineage");
  });

  // A lineage the base ref carried, still on disk, and no longer named by the
  // script that migrates. Both halves skip it, so the schemas match — while a
  // database deployed from the base ref keeps everything it built.
  test("a base lineage this branch stopped migrating is refused", async () => {
    const repo = await history(
      {
        ...migratesFrom(JOURNALLED, "db/thing", "db/note"),
        ...lineage("db/thing", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
      {
        ...migratesFrom(JOURNALLED, "db/thing"),
        ...lineage("db/thing", CREATES_THING),
        ...lineage("db/note", CREATES_NOTE),
      },
    );
    const verdict = await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([containing("db/note is in")]);
    expect(messages(verdict)[0]).toContain("never applied it");
  });

  // The project itself moved, so the directory the gate was pointed at did not
  // exist at the base ref. Its lineage is one path over, and every database
  // built from it is stranded — the same fact a moved lineage carries.
  test("a project that moved takes its lineage with it, and is refused", async () => {
    const repo = await history(
      under("apps/api", {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING),
      }),
      under("apps/backend", {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING_WITH_SLUG),
      }),
    );
    const verdict = await replayIn(join(repo.root, "apps/backend"), pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([
      containing("apps/backend/drizzle/meta/_journal.json was apps/api/drizzle/meta/_journal.json"),
    ]);
    expect(messages(verdict)[0]).toContain("strands every database");
  });

  // The other cell: the directory did not exist at the base ref because the
  // project is new here. Nothing moved into it, so nothing is stranded.
  test("a project this branch adds has nothing to upgrade from", async () => {
    const repo = await history(under("apps/web", { "index.ts": "export {};\n" }), {
      ...under("apps/web", { "index.ts": "export {};\n" }),
      ...under("apps/api", {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING),
      }),
    });
    const verdict = await replayIn(join(repo.root, "apps/api"), pushedOver(repo.revs[0] ?? ""));

    expect(messages(verdict)).toEqual([]);
    expect(verdict.summary).toContain("carries no migration lineage");
  });

  // Every git read on this path answers or refuses. A checkout that is not a
  // repository answers nothing, and reading that as "no base ref" is the same
  // hole a shallow clone would be.
  test("a root that is not a git repository is refused", async () => {
    const repo = await history({
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage("drizzle", CREATES_THING),
    });
    await rm(join(repo.root, ".git"), { recursive: true, force: true });

    const refused = await refusal(replay(repo, { baseRef: "", before: "" }));

    expect(refused).toContain("could not establish whether this checkout has history");
  });

  // A tree entry may be named anything `git mktree` will write — git only warns
  // about `..` — and these paths become files. One that escapes the lineage
  // directory is not part of a lineage, and the restore would not put it back.
  test("a base tree naming a file outside the lineage is refused", async () => {
    const repo = await history({
      ...migratesFrom(JOURNALLED, "drizzle"),
      ...lineage("drizzle", CREATES_THING),
    });
    const escaped = await gitFed(repo.root, ["hash-object", "-w", "--stdin"], "escaped\n");
    const journal = await gitFed(
      repo.root,
      ["hash-object", "-w", "--stdin"],
      '{"version":"7","dialect":"postgresql","entries":[]}',
    );
    const meta = await gitFed(repo.root, ["mktree"], `100644 blob ${journal}\t_journal.json\n`);
    const drizzle = await gitFed(
      repo.root,
      ["mktree"],
      `040000 tree ${meta}\tmeta\n100644 blob ${escaped}\t..\n`,
    );
    const top = await gitFed(repo.root, ["mktree"], `040000 tree ${drizzle}\tdrizzle\n`);
    const crafted = await git(repo.root, [...IDENTITY, "commit-tree", top, "-m", "crafted"]);

    const refused = await refusal(replay(repo, pushedOver(crafted.trim())));

    expect(refused).toContain("which is outside drizzle");
  });

  // The first replay succeeded, so blaming a migration that "only applies to an
  // already-migrated database" would be the exact inverse of what happened.
  test("the second replay's failure is not the first replay's diagnosis", async () => {
    const repo = await history({
      ...migratesFrom(REPLAYING, "drizzle"),
      ...lineage("drizzle", { ...THING, sql: `CREATE TABLE "thing" ("id" integer);\n` }),
    });

    const refused = await refusal(replay(repo, undefined));

    expect(refused).toContain("failed on its second run");
    expect(refused).toContain("having just succeeded on the first");
    expect(refused).not.toContain("aborts here and nowhere else");
  });

  // A migrator that leaves the tree unwritable is one shape of a restore that
  // cannot run. Both the failure and what it was carrying have to survive it,
  // and the copy of the branch's files has to outlive the run that could not
  // put them back — it is the only one there is.
  test("a restore that fails keeps the copy, and says where", async () => {
    const marked = "drizzle/only-at-base";
    const locking = scripted(
      `bun run ${JOURNALLED} ./drizzle; status=$?; [ -f ${marked} ] && chmod 500 .; exit $status`,
    );
    const repo = await history(
      { ...locking, ...lineage("drizzle", CREATES_THING), [marked]: "the base ref's copy\n" },
      { ...locking, ...lineage("drizzle", CREATES_THING, ADDS_SLUG) },
    );

    const refused = await refusal(replay(repo, pushedOver(repo.revs[0] ?? "")));

    expect(refused).toContain("could not be put back");
    const copy = /the only copy is (\S+?),/.exec(refused)?.[1];
    expect(copy).toBeDefined();
    expect(await Bun.file(join(copy ?? "", `drizzle/${SLUG.tag}.sql`)).text()).toBe(ADDS_SLUG.sql);

    await chmod(repo.root, 0o700);
    await rm(copy ?? "", { recursive: true, force: true });
  });

  // The base replay runs the base ref's files, so a statement that fails there
  // is that commit's. Saying "which statement did not apply" and leaving it
  // there would send the author looking through migrations they just wrote.
  test("a failure in the base replay says whose migration it was", async () => {
    const broken = { ...SLUG, sql: `ALTER TABLE "missing" ADD COLUMN "x" text;\n` };
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING, broken) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );

    const refused = await refusal(replay(repo, pushedOver(repo.revs[0] ?? "")));

    expect(refused).toContain("failed replaying");
    expect(refused).toContain("rather than this branch's");
    expect(await git(repo.root, ["status", "--porcelain"])).toBe("");
  });

  // The gate drops this database. A caller that declared it as its own would be
  // asking the check to destroy the one the app boots against.
  test("a caller that declares the gate's own database is refused", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );
    const name = upgradeDatabase(repo.root);
    await onServer([`create database "${name}"`]);
    databases.push(name);

    const verdict = await replayGate({
      root: repo.root,
      url: beside(SERVER, name),
      upgrade: pushedOver(repo.revs[0] ?? ""),
    });

    expect(messages(verdict)).toEqual([containing(`the declared database is called ${name}`)]);
  });

  // The one way this gate could pass by having been given nothing: a checkout
  // with no history reads as a repo with no base ref.
  test("a shallow checkout is refused rather than skipped", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
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
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      {
        ...migratesFrom(JOURNALLED, "drizzle"),
        ...lineage("drizzle", CREATES_THING, ADDS_SLUG),
      },
    );

    const refused = await refusal(replay(repo, { baseRef: "release", before: "" }));

    expect(refused).toContain("refs/remotes/origin/release is not in this checkout");
  });

  // The tree the later steps of the gate — the boot, the ramp — run against has
  // to be the one the branch committed, whichever way the comparison went.
  test("the working tree is the branch's own again afterwards", async () => {
    const repo = await history(
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING) },
      { ...migratesFrom(JOURNALLED, "drizzle"), ...lineage("drizzle", CREATES_THING_WITH_SLUG) },
    );

    await replay(repo, pushedOver(repo.revs[0] ?? ""));

    expect(await git(repo.root, ["status", "--porcelain"])).toBe("");
    expect(await Bun.file(join(repo.root, `drizzle/${THING.tag}.sql`)).text()).toBe(
      CREATES_THING_WITH_SLUG.sql,
    );
  });
});
