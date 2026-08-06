import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { git, type Problem } from "../_lib/gate.ts";

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
 * Both are decided by one function, `compare`, over `pg_dump --schema-only`
 * minus the tokens that differ per invocation. Two derivations of "the same
 * schema" would be two answers to the question this whole module exists to
 * answer, and the day they disagreed nobody would know which was right.
 */

/** The database the upgrade path is replayed into, beside the one the caller declared. */
export const UPGRADE_DATABASE = "upgrade_path";

/**
 * The file a drizzle migrator refuses to run without, and therefore the only
 * honest way to ask where a lineage is: a directory holding one is a lineage,
 * and one without is not.
 */
const JOURNAL = "meta/_journal.json";

/**
 * pg_dump wraps its output in `\restrict`/`\unrestrict` tokens that are random
 * per invocation, so two dumps of one schema never compare equal as-is.
 */
const PER_INVOCATION = /^\\(un)?restrict /;

/** What the run knows about where it came from, which is all a base ref can be derived from. */
export interface Event {
  /** `github.base_ref`: the branch a pull request targets, empty off one. */
  readonly baseRef: string;
  /** `github.event.before`: the tip the branch had before this push, empty or all-zero otherwise. */
  readonly before: string;
}

export interface Replay {
  /** Where `bun run db:migrate` runs — the project the caller declared. */
  readonly root: string;
  /** The database that job declared: what is replayed into, and what the app then boots against. */
  readonly url: string;
  /** The run's own history, when the upgrade path is being proved as well. */
  readonly upgrade: Event | undefined;
}

export interface Verdict {
  /** What a replay that held proved, for the log. Absent when it did not hold: the problems are the report then. */
  readonly summary: string | undefined;
  /** What the two schemas do not share — a diagnostic that only says "they differ" is not one. */
  readonly divergence: string[];
  readonly problems: Problem[];
}

/** A schema dump, named the way the diagnostic has to name it. */
export interface Schema {
  readonly of: string;
  readonly text: string;
}

/**
 * The repo's own migrator, against the database named. Its output is the
 * developer's — the SQL that would not apply, and the line it was on — so it
 * goes to the log rather than into a diagnostic that would quote a fragment.
 */
async function migrate(root: string, url: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "db:migrate"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(
      `bun run db:migrate failed against ${databaseIn(url)} — the output above says which statement did not apply`,
    );
  }
}

/** The database a URL names, for the diagnostics: the URL itself carries a password. */
function databaseIn(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** The same server, pointing at a different database. */
export function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

/** The schema as pg_dump reports it, minus what differs between two runs of pg_dump. */
async function schemaOf(url: string): Promise<string> {
  const proc = Bun.spawn(["pg_dump", "--schema-only", url], { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`pg_dump could not read ${databaseIn(url)} — its own error is above`);
  }
  return stdout
    .split("\n")
    .filter((line) => !PER_INVOCATION.test(line))
    .join("\n");
}

/** How many times each line occurs, since a dump repeats `SET`s and blank lines. */
function tally(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() !== "") counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * The lines `schema` carries that `other` does not, grouped by line and ordered
 * by where each first appeared in the dump. A line carried twice on one side
 * and once on the other is listed once, for the copy that has no partner.
 */
function only(schema: string, other: string): string[] {
  const theirs = tally(other);
  const lines: string[] = [];
  for (const [line, count] of tally(schema)) {
    for (let extra = count - (theirs.get(line) ?? 0); extra > 0; extra--) lines.push(line);
  }
  return lines;
}

/** How two schema dumps differ. There is no such thing as an empty one. */
export interface Difference {
  /** What the log gets: every line the two do not share, addressed to whichever has it. */
  readonly lines: string[];
  /** What the annotation gets: the shortest true sentence about it. */
  readonly headline: string;
}

/**
 * The single derivation of "the same schema". `undefined` is the only way two
 * dumps are equal, and every other answer carries both a headline and something
 * to print — so a refusal with nothing to say for itself cannot be built. Two
 * dumps holding the same statements in a different order are not equal, and
 * that difference names itself rather than coming out blank.
 */
export function compare(left: Schema, right: Schema): Difference | undefined {
  if (left.text === right.text) return undefined;

  const sides = [
    { schema: left, lines: only(left.text, right.text) },
    { schema: right, lines: only(right.text, left.text) },
  ].filter(({ lines }) => lines.length > 0);

  if (sides.length === 0) {
    const ordered = `${left.of} and ${right.of} hold the same statements in a different order`;
    return { lines: [ordered], headline: ordered };
  }

  return {
    lines: sides.flatMap(({ schema, lines }) =>
      lines.map((line) => `only in ${schema.of}: ${line}`),
    ),
    headline: sides
      .map(
        ({ schema, lines }) =>
          `${schema.of} alone has ${lines.length} line${lines.length === 1 ? "" : "s"}, first \`${lines[0]}\``,
      )
      .join(", "),
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
 * The shapes this gate will not replay, refused rather than worked around. Both
 * would otherwise be handled by a `rm -rf` deciding what a directory means: a
 * lineage at the root of the project is the project, and a lineage inside
 * another is two swaps of one tree. Refusing keeps "a lineage directory" a
 * thing that can be moved aside on its own.
 */
function unreplayable(dirs: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  for (const dir of dirs) {
    if (dir === "") {
      problems.push({
        file: JOURNAL,
        message: `the project root is itself a migration lineage — put the migrations in a directory of their own, since the upgrade path replays a lineage by replacing that directory`,
      });
      continue;
    }
    const inside = dirs.find((other) => other !== dir && dir.startsWith(`${other}/`));
    if (inside !== undefined) {
      problems.push({
        file: `${dir}/${JOURNAL}`,
        message: `the migration lineage ${dir} is inside the lineage ${inside} — give each one a directory the other does not contain, since the upgrade path replays a lineage by replacing its directory`,
      });
    }
  }
  return problems;
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
  const listing = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./`,
  ]);
  // Nothing of this project existed at the base ref — a directory this branch
  // added, or a repository whose first commit is the one being gated.
  if (!listing.ok) return { lineages: [], problems: [] };

  const dirs = lineageDirs(listing.stdout.split("\0").filter((path) => path !== ""));
  const problems = unreplayable(dirs);
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
  const files = await Promise.all(
    names.map(async (path) => {
      const blob = await git(root, ["show", `${rev}:./${dir}/${path}`]);
      if (!blob.ok) throw new Error(`could not read ${dir}/${path} at ${rev}`);
      return { path, text: blob.stdout };
    }),
  );
  return { dir, files };
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
  try {
    await Promise.all(
      lineages.map(async ({ dir, files }) => {
        await cp(join(root, dir), join(saved, dir), { recursive: true });
        await rm(join(root, dir), { recursive: true, force: true });
        for (const file of files) await Bun.write(join(root, dir, file.path), file.text);
      }),
    );
    return await body();
  } finally {
    await Promise.all(
      lineages.map(async ({ dir }) => {
        await rm(join(root, dir), { recursive: true, force: true });
        await cp(join(saved, dir), join(root, dir), { recursive: true });
      }),
    );
    await rm(saved, { recursive: true, force: true });
  }
}

/**
 * The commit a deployed database's schema would have been built from.
 *
 * On a pull request that is where this branch left the base branch, which is
 * the merge base — the base branch's own migrations are already in it, so a
 * change that only adds to them has nothing to answer for. On a push it is the
 * tip the branch had before, which is the commit whose schema is actually
 * running somewhere; where the event names none — a branch's first push, a
 * merge queue — the parent commit is the same statement.
 *
 * A shallow checkout is refused rather than treated as "no history": the whole
 * check would pass by having been given nothing to read.
 */
async function baseRevision(root: string, event: Event): Promise<string | undefined> {
  if ((await git(root, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true") {
    throw new Error(
      "the checkout is shallow, so the base ref's migrations are not in it — check out with fetch-depth: 0 when the upgrade gate is on",
    );
  }

  if (event.baseRef !== "") {
    const base = `refs/remotes/origin/${event.baseRef}`;
    const merged = await git(root, ["merge-base", base, "HEAD"]);
    if (!merged.ok) {
      throw new Error(
        `${base} is not in this checkout, so there is nothing to take the merge base with — check out with fetch-depth: 0 when the upgrade gate is on`,
      );
    }
    return merged.stdout.trim();
  }

  if (event.before !== "" && (await git(root, ["cat-file", "-e", `${event.before}^{commit}`])).ok) {
    return event.before;
  }
  const parent = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
  return parent.ok ? parent.stdout.trim() : undefined;
}

/**
 * The schema a deployed database reaches: the base ref's lineage first, then
 * this branch's onto the result — the same two commands, in the same order, a
 * deploy runs. The database it is built in is this gate's own, made beside the
 * one the caller declared and dropped again whichever way the comparison goes.
 */
async function upgradedSchema(
  root: string,
  url: string,
  lineages: readonly BaseLineage[],
): Promise<string> {
  const upgrade = beside(url, UPGRADE_DATABASE);
  const server = new SQL(url);
  // A second database on the caller's own service, rather than a second
  // service: the schema the app boots against has to survive this untouched.
  await server.unsafe(`create database "${UPGRADE_DATABASE}"`);
  try {
    await onTheBaseLineage(root, lineages, () => migrate(root, upgrade));
    await migrate(root, upgrade);
    return await schemaOf(upgrade);
  } finally {
    await server.unsafe(`drop database if exists "${UPGRADE_DATABASE}" with (force)`);
    await server.close();
  }
}

/** A verdict with nothing to report, which is every passing one. */
function passed(summary: string): Verdict {
  return { summary, divergence: [], problems: [] };
}

/** A verdict that fails the step. There is no summary: what happened is the problem. */
function refused(problems: Problem[], divergence: string[] = []): Verdict {
  return { summary: undefined, divergence, problems };
}

const REPLAYED =
  "replay: the migrations rebuild the schema from empty, and a second replay leaves it identical";

export async function replayGate({ root, url, upgrade }: Replay): Promise<Verdict> {
  await migrate(root, url);
  const fresh: Schema = { of: "the schema built from empty", text: await schemaOf(url) };
  await migrate(root, url);
  const again: Schema = { of: "the schema after a second replay", text: await schemaOf(url) };

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

  const rev = await baseRevision(root, upgrade);
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

  const upgraded: Schema = {
    of: `the schema upgraded from ${from}`,
    text: await upgradedSchema(root, url, lineages),
  };
  const diverged = compare(fresh, upgraded);
  if (diverged === undefined) {
    return passed(
      `${REPLAYED}; upgrading a database built from ${from} (${lineages.map(({ dir }) => dir).join(", ")}) reaches the same schema`,
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
