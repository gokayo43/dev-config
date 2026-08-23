import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import {
  baseRevision,
  type Event,
  git,
  isList,
  isObject,
  type Problem,
  repoFiles,
  type Verdict,
} from "../_lib/gate.ts";
import {
  beside,
  compare,
  databaseIn,
  discard,
  type Dump,
  dumpOf,
  migrate,
  numberColumn,
  scratchDatabase,
  textColumn,
} from "./database.ts";
import { passed, refused } from "./verdict.ts";

/**
 * What a repo's migration history is asked to prove, and the two questions are
 * the same question asked from two starting points:
 *
 *  - **From empty.** A migration that only applies to an already-migrated
 *    database — a `DROP CONSTRAINT` for one an earlier `DROP TABLE ... CASCADE`
 *    has already taken — succeeds where it was written and aborts the first
 *    time the history runs onto nothing. Replaying from empty on every push is
 *    what turns a database that cannot be rebuilt into a red build, and
 *    replaying a *second* time is what proves the runner is honest about what
 *    it has already applied: an exit code only says the second pass did not
 *    error, and a `push`-style sync exits 0 without leaving the schema alone.
 *
 *  - **From the base ref.** A deployed database is not empty: it holds whatever
 *    the base ref's migrations put there, and the journal rows to match. A
 *    migration that has already been applied is never re-read — see
 *    docs/gates/upgrade-path.md for what drizzle's migrator actually does — so
 *    editing one changes what a fresh database gets and nothing else. The two
 *    schemas part company, silently, and stay parted forever.
 *
 * Both are decided by `compare` in database.ts, over `pg_dump --schema-only`
 * minus the tokens that differ per invocation. Two derivations of "the same
 * schema" would be two answers to the question this whole module exists to
 * answer, and the day they disagreed nobody would know which was right.
 */

/**
 * The database the upgrade path is replayed into, beside the one the caller
 * declared. `database.ts` says why it is derived rather than fixed, and
 * backfill.ts names its own the same way: the purpose string belongs to the
 * gate that has one.
 */
export function upgradeDatabase(root: string): string {
  return scratchDatabase(root, "upgrade_path");
}

/**
 * The file a drizzle migrator refuses to run without, and therefore the only
 * honest way to ask where a lineage is: a directory holding one is a lineage,
 * and one without is not.
 */
const JOURNAL = "meta/_journal.json";

/** What this gate wanted the history for, on every refusal that says it could not have it. */
const READS_THE_BASE_REF =
  "the upgrade gate replays the base ref's migrations to prove a deployed database reaches this schema";

export interface Replay {
  /** Where `bun run db:migrate` runs — the project the caller declared. */
  readonly root: string;
  /** The database that job declared: what is replayed into, and what the app then boots against. */
  readonly url: string;
  /** The run's own history, when the upgrade path is being proved as well. */
  readonly upgrade: Event | undefined;
}

/**
 * A git read whose failure is not an answer. Most of what this gate asks git
 * has a meaningful "no" — a path that is not tracked, a branch with no parent —
 * but a read that fails because the checkout is not a repository at all, or
 * because git could not run, answers nothing: taking the empty output as "no"
 * is how a gate passes by having been handed nothing to look at.
 */
async function mustRead(
  root: string,
  args: readonly string[],
  establishing: string,
): Promise<string> {
  const ran = await git(root, args);
  if (!ran.ok) {
    throw new Error(
      `could not establish ${establishing}: \`git ${args.join(" ")}\` failed in ${root} — the upgrade gate reads the base ref out of git history, and a checkout it cannot read is refused rather than reported as having nothing to upgrade from`,
    );
  }
  return ran.stdout;
}

/**
 * pg_dump wraps its output in `\restrict`/`\unrestrict` tokens that are random
 * per invocation, so two dumps of one schema never compare equal as-is.
 */
const PER_INVOCATION = /^\\(un)?restrict /;

/**
 * The schema as pg_dump reports it, in lines, named the way a diagnostic about
 * it has to name it. Order is left alone — pg_dump is deterministic, so two
 * schemas holding the same statements in a different order really are two
 * schemas, which is where this parts company with the data half's `dataOf`.
 * Lines are the unit for the same reason: nothing here is reordered, so a
 * statement that spans several of them cannot have its fragments traded with
 * another statement's.
 */
async function schemaOf(url: string, of: string): Promise<Dump> {
  const dumped = await dumpOf(url, ["--schema-only"]);
  return {
    of,
    each: "line",
    units: dumped.split("\n").filter((line) => !PER_INVOCATION.test(line)),
  };
}

/** A migration lineage as the base ref had it: the directory, and every file in it. */
interface BaseLineage {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/** The lineage directories a listing names, as the journals in it place them. */
function lineageDirs(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path === JOURNAL || path.endsWith(`/${JOURNAL}`))
    .map((path) => path.slice(0, Math.max(0, path.length - JOURNAL.length - 1)));
}

/**
 * The shapes this gate will not replay, refused rather than worked around. A
 * lineage is replayed by replacing its directory, which is only a local act
 * when the directory holds that lineage and nothing else: a lineage at the root
 * of the project is the project, and one lineage inside another is a `rm -rf`
 * taking a lineage nobody asked it to touch.
 *
 * `swapped` is what will be replaced — the base ref's. `all` adds this tree's,
 * which is not a source of truth about what to replay (reading it as one is how
 * a relocated lineage went unnoticed) but is the only way to know what the
 * delete would reach: a lineage this branch nests inside one the base ref
 * carried is deleted by a swap that never enumerated it.
 */
function unreplayable(swapped: readonly string[], all: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  if (all.includes("")) {
    problems.push({
      file: JOURNAL,
      message: `the project root is itself a migration lineage — put the migrations in a directory of their own, since the upgrade path replays a lineage by replacing that directory`,
    });
  }

  const nested = new Map<string, { readonly inner: string; readonly outer: string }>();
  for (const dir of swapped) {
    if (dir === "") continue;
    for (const other of all) {
      if (other === "" || other === dir) continue;
      if (other.startsWith(`${dir}/`)) nested.set(`${other}|${dir}`, { inner: other, outer: dir });
      else if (dir.startsWith(`${other}/`))
        nested.set(`${dir}|${other}`, { inner: dir, outer: other });
    }
  }

  return [
    ...problems,
    ...[...nested.values()].map(({ inner, outer }) => ({
      file: `${inner}/${JOURNAL}`,
      message: `the migration lineage ${inner} is inside the lineage ${outer} — give each one a directory the other does not contain, since the upgrade path replays a lineage by replacing its directory`,
    })),
  ];
}

/**
 * Every lineage the base ref carried, read out of the base ref rather than out
 * of this branch's tree. A deployed database's journal is keyed to the lineage
 * that built it, so the branch's own directories cannot say what has to be
 * replayed: moving or deleting one would then be a lineage this gate never
 * looked for, and the run would pass by not having asked.
 *
 * A lineage the base ref did not carry is left where it is: there was none of
 * it on a database at that ref, so replaying this branch's copy from empty is
 * exactly what a deploy does with it.
 */
async function baseLineages(
  root: string,
  rev: string,
): Promise<{ lineages: BaseLineage[]; problems: Problem[] }> {
  // The rev is one git already resolved and the repository is one it has
  // already read, so the only thing left that this can fail on is the path:
  // the project was not here at the base ref.
  const listing = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./`,
  ]);
  if (!listing.ok) return { lineages: [], problems: await absentAt(root, rev) };

  const dirs = lineageDirs(listing.stdout.split("\0").filter((path) => path !== ""));
  if (dirs.length === 0) return { lineages: [], problems: [] };

  // The root pathspec is here and not in what gets replayed: a journal at the
  // project root is a shape this gate refuses, and refusing it means seeing it.
  const inTree = lineageDirs(await repoFiles(root, [JOURNAL, `*/${JOURNAL}`]));
  const problems = unreplayable(dirs, [...new Set([...dirs, ...inTree])]);
  if (problems.length > 0) return { lineages: [], problems };

  const stranded = await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      there: await Bun.file(join(root, dir, JOURNAL)).exists(),
    })),
  );
  const moved = stranded
    .filter(({ there }) => !there)
    .map(({ dir }) => ({
      message: `${rev.slice(0, 7)} carries the migration lineage ${dir} and this tree does not — a deployed database's journal names the migrations that built it, so moving or deleting a lineage strands every database that has one; leave it where it is and add to it`,
    }));
  if (moved.length > 0) return { lineages: [], problems: moved };

  const lineages = await Promise.all(dirs.map((dir) => filesAt(root, rev, dir)));
  return { lineages, problems: [] };
}

/**
 * What it means that this project's directory was not at the base ref, which is
 * two different things and only one of them is safe.
 *
 * A project this branch adds has no base lineage, and no database anywhere was
 * built from one: the honest pass. A project that was somewhere else at the
 * base ref has exactly the lineage the gate exists to protect, one path over —
 * and every database built from it is stranded the moment the directory moves,
 * for the same reason a moved lineage strands one.
 *
 * git already knows which it is, so it is asked rather than guessed at: a
 * rename whose destination is inside this project carries a lineage into it.
 */
async function absentAt(root: string, rev: string): Promise<Problem[]> {
  const prefix = (
    await mustRead(
      root,
      ["rev-parse", "--show-prefix"],
      "where this project sits in the repository",
    )
  ).trim();
  const renames = await mustRead(
    root,
    ["diff", "--find-renames", "--name-status", "--diff-filter=R", rev, "HEAD"],
    `what moved between ${rev.slice(0, 7)} and this branch`,
  );

  return renames
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, from, to]) =>
        from !== undefined &&
        to !== undefined &&
        to.startsWith(prefix) &&
        (from === JOURNAL || from.endsWith(`/${JOURNAL}`)),
    )
    .map(([, from, to]) => ({
      message: `${to} was ${from} at ${rev.slice(0, 7)}, so this project's migration lineage moved with it — a deployed database's journal names the migrations that built it, and moving them strands every database that has one; leave the lineage where it was and add to it`,
    }));
}

async function filesAt(root: string, rev: string, dir: string): Promise<BaseLineage> {
  const listed = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./${dir}`,
  ]);
  if (!listed.ok) throw new Error(`could not read ${dir} at ${rev}`);

  const names = listed.stdout.split("\0").filter((name) => name !== "");
  const inside = join(root, dir);
  const files = await inBatches(names, async (path) => {
    // A tree entry may be named anything a `git mktree` was willing to write,
    // `..` included — git only warns about one — and these paths are turned
    // into files. A write that lands outside the directory being replaced is
    // one the restore below would not put back, so it is refused instead.
    const target = join(inside, path);
    if (!target.startsWith(`${inside}/`)) {
      throw new Error(
        `${rev.slice(0, 7)} holds a migration file at ${dir}/${path}, which is outside ${dir} — the upgrade path replays a lineage by replacing its directory, and a file that escapes it is not part of one`,
      );
    }
    const blob = await git(root, ["show", `${rev}:./${dir}/${path}`]);
    if (!blob.ok) throw new Error(`could not read ${dir}/${path} at ${rev}`);
    return { path, text: blob.stdout };
  });
  return { dir, files };
}

/** How many git reads run at once: a long lineage would otherwise be a process per file. */
const AT_ONCE = 16;

async function inBatches<T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let start = 0; start < items.length; start += AT_ONCE) {
    done.push(...(await Promise.all(items.slice(start, start + AT_ONCE).map(each))));
  }
  return done;
}

/**
 * Runs `body` with every lineage rolled back to what the base ref had, and the
 * tree exactly as it found it afterwards — including when `body` throws. The
 * migrator is the repo's own and reads the one path it was written to read, so
 * the files are what moves; the alternative is a second checkout, and the
 * commands a repo wraps its migrator in (a worktree's own database, a compose
 * stack) would all be answering about that other tree instead of this one.
 *
 * Every directory here is a lineage directory that contains no other — see
 * `unreplayable`, which is what makes replacing one a local act.
 */
async function onTheBaseLineage<T>(
  root: string,
  lineages: readonly BaseLineage[],
  body: () => Promise<T>,
): Promise<T> {
  const saved = await mkdtemp(join(tmpdir(), "head-lineage-"));
  let keep = false;
  try {
    // Every lineage is saved before any is touched, so that the restore below
    // has what it needs for all of them by the time anything needs restoring.
    // Interleaved, a save that failed could follow a delete that succeeded, and
    // the restore would then throw over a lineage it never held — losing the
    // directory and the error that started it in the same breath.
    await Promise.all(
      lineages.map(({ dir }) => cp(join(root, dir), join(saved, dir), { recursive: true })),
    );

    let outcome: { readonly value: T } | { readonly failed: unknown };
    try {
      await Promise.all(
        lineages.map(async ({ dir, files }) => {
          await rm(join(root, dir), { recursive: true, force: true });
          for (const file of files) await Bun.write(join(root, dir, file.path), file.text);
        }),
      );
      outcome = { value: await body() };
    } catch (failed) {
      outcome = { failed };
    }

    // Settled rather than raced, and reported rather than thrown from a
    // `finally`: a restore that fails while the replay has already failed would
    // otherwise replace the diagnostic the author needs with an ENOENT, and the
    // directory it could not put back would be deleted with the copy below.
    const unrestored = (
      await Promise.allSettled(
        lineages.map(async ({ dir }) => {
          await rm(join(root, dir), { recursive: true, force: true });
          await cp(join(saved, dir), join(root, dir), { recursive: true });
        }),
      )
    ).flatMap((settled) => (settled.status === "rejected" ? [String(settled.reason)] : []));

    if (unrestored.length > 0) {
      keep = true;
      const first =
        "failed" in outcome ? ` The replay had already failed: ${String(outcome.failed)}` : "";
      throw new Error(
        `this branch's own migration files could not be put back: ${unrestored.join("; ")} — the only copy is ${saved}, which has been left in place; restore it before doing anything else with this checkout.${first}`,
      );
    }
    if ("failed" in outcome) throw outcome.failed;
    return outcome.value;
  } finally {
    if (!keep) await rm(saved, { recursive: true, force: true });
  }
}

/**
 * The migrations a database records as applied, by the clock drizzle keys them
 * on. Read from every `__drizzle_migrations` in the database, whichever schema
 * holds it, because a repo with more than one lineage has to give each its own
 * journal table or they would share one high-water mark.
 */
async function appliedIn(url: string): Promise<Set<number>> {
  const db = new SQL(url);
  try {
    const schemas = await textColumn(
      db,
      `select table_schema from information_schema.tables where table_name = '__drizzle_migrations'`,
      "table_schema",
    );
    const applied = new Set<number>();
    for (const table_schema of schemas) {
      const journal = await numberColumn(
        db,
        `select created_at from "${table_schema.replaceAll('"', '""')}"."__drizzle_migrations"`,
        "created_at",
      );
      for (const created of journal) applied.add(created);
    }
    return applied;
  } finally {
    await db.close();
  }
}

/** The clocks a lineage's journal names — what the migrator records when it applies one. */
function clocksIn({ files }: BaseLineage): number[] {
  const journal = files.find(({ path }) => path === JOURNAL);
  if (journal === undefined) return [];
  const parsed: unknown = JSON.parse(journal.text);
  const entries = isObject(parsed) ? parsed["entries"] : undefined;
  if (!isList(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    const when = isObject(entry) ? entry["when"] : undefined;
    return typeof when === "number" ? [when] : [];
  });
}

/** What the upgrade path came to, or the lineages that never got there. */
type Upgraded =
  | { readonly unapplied: string[] }
  | { readonly dump: Dump; readonly replayed: string[] };

/**
 * The schema a deployed database reaches: the base ref's lineage first, then
 * this branch's onto the result — the same two commands, in the same order, a
 * deploy runs. The database it is built in is this gate's own, made beside the
 * one the caller declared and dropped again whichever way the comparison goes.
 */
async function upgradedSchema(
  root: string,
  url: string,
  rev: string,
  lineages: readonly BaseLineage[],
): Promise<Upgraded> {
  const database = upgradeDatabase(root);
  const upgrade = beside(url, database);
  const from = rev.slice(0, 7);
  const server = new SQL(url);
  try {
    // A second database on the caller's own service, rather than a second
    // service: the schema the app boots against has to survive this untouched.
    // Dropped first as well as last, because a run killed between the two ends
    // otherwise leaves a database whose only effect is to fail the next run
    // with an error about a name its author never chose.
    await server.unsafe(`drop database if exists "${database}" with (force)`);
    await server.unsafe(`create database "${database}"`);
    // The base phase runs *this branch's* `db:migrate` over the base ref's
    // files, which is the only migrator there is — so what it applied has to be
    // read back rather than assumed. A lineage the base ref carried that the
    // branch's script no longer names would otherwise be missing from both
    // halves and compare equal, while a deployed database keeps everything it
    // built from it.
    const applied = await onTheBaseLineage(root, lineages, async () => {
      await migrate(
        root,
        upgrade,
        `bun run db:migrate failed replaying ${from}'s migrations into ${databaseIn(upgrade)} — every lineage directory was rolled back to what ${from} carried, so the statement the output above names is that commit's rather than this branch's`,
      );
      return await appliedIn(upgrade);
    });

    const asked = lineages.map((lineage) => ({ dir: lineage.dir, clocks: clocksIn(lineage) }));
    const unapplied = asked
      .filter(({ clocks }) => clocks.length > 0 && !clocks.some((clock) => applied.has(clock)))
      .map(({ dir }) => dir);
    if (unapplied.length > 0) return { unapplied };

    await migrate(
      root,
      upgrade,
      `bun run db:migrate failed applying this branch's migrations onto ${databaseIn(upgrade)}, a database built from ${from} — the output above names the statement; it applies to a database built from empty and not to one ${from} had already migrated`,
    );
    return {
      dump: await schemaOf(upgrade, `the schema upgraded from ${from}`),
      replayed: asked.filter(({ clocks }) => clocks.length > 0).map(({ dir }) => dir),
    };
  } finally {
    await discard(server, database);
  }
}

const REPLAYED =
  "replay: the migrations rebuild the schema from empty, and a second replay leaves it identical";

export async function replayGate({ root, url, upgrade }: Replay): Promise<Verdict> {
  await migrate(
    root,
    url,
    `bun run db:migrate failed replaying the history from empty into ${databaseIn(url)} — the output above names the statement; a migration that only applies to an already-migrated database aborts here and nowhere else`,
  );
  const fresh = await schemaOf(url, "the schema built from empty");
  await migrate(
    root,
    url,
    `bun run db:migrate failed on its second run over ${databaseIn(url)}, having just succeeded on the first — the output above names the statement; it is being executed against a database that already has its effects, so either the runner is not skipping what it has applied or that statement is not re-runnable`,
  );
  const again = await schemaOf(url, "the schema after a second replay");

  const repeated = compare(fresh, again);
  if (repeated !== undefined) {
    return refused(
      [
        {
          message: `replaying the migrations a second time changed the schema — ${repeated.headline} — a schema must not depend on how many times it was migrated; make the statements that ran again re-runnable, or have the runner skip what it has already applied`,
        },
      ],
      repeated.lines,
    );
  }

  if (upgrade === undefined) return passed(REPLAYED);

  // A checkout that cannot say where it came from is refused rather than
  // reported as having nothing to upgrade from: the whole check would pass by
  // having been given nothing to read.
  const base = await baseRevision(root, upgrade, READS_THE_BASE_REF);
  if ("refused" in base) throw new Error(base.refused);

  const rev = base.rev;
  if (rev === undefined) {
    return passed(
      `${REPLAYED}; there is no earlier commit to upgrade from, so the upgrade path is not proved for this run`,
    );
  }
  const from = rev.slice(0, 7);

  const { lineages, problems } = await baseLineages(root, rev);
  if (problems.length > 0) return refused(problems);
  if (lineages.length === 0) {
    return passed(
      `${REPLAYED}; ${from} carries no migration lineage, so the upgrade path is not proved for this run`,
    );
  }

  const built = await upgradedSchema(root, url, rev, lineages);
  if ("unapplied" in built) {
    return refused(
      built.unapplied.map((dir) => ({
        message: `${dir} is in ${from}'s lineage set and this branch's db:migrate never applied it — a database deployed from ${from} keeps everything that lineage built, and a rebuild never makes it; point db:migrate at ${dir} again`,
      })),
    );
  }

  const diverged = compare(fresh, built.dump);
  if (diverged === undefined) {
    return passed(
      `${REPLAYED}; upgrading a database built from ${from} (${built.replayed.join(", ")}) reaches the same schema`,
    );
  }

  return refused(
    [
      {
        message: `upgrading a database built from ${from} does not reach the schema this branch builds from empty — ${diverged.headline} — the lineage ${from} had already applied has changed under it: a migration was rewritten, or a new one was ordered behind one already applied. An applied migration is never re-read, so no deployed database will ever reach this schema; put the change in a new migration, ordered after every one that has shipped.`,
      },
    ],
    diverged.lines,
  );
}
