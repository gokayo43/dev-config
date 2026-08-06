import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SQL } from "bun";

import { type Problem, repoFiles } from "../_lib/gate.ts";

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
 * Both are decided by the same comparison, which is why they are one module:
 * `pg_dump --schema-only`, minus the tokens that differ per invocation. Two
 * spellings of that normalisation would be two answers to "is this the same
 * schema", and the day they disagreed nobody would know which was right.
 */

/** The database the upgrade path is replayed into, beside the one the caller declared. */
const UPGRADE_DATABASE = "upgrade_path";

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
  /** One line for the log, so a step that passed still says what it replayed. */
  readonly summary: string;
  /** Every line the two schemas do not share, when they do not — a diagnostic that says "they differ" is not one. */
  readonly divergence: string[];
  readonly problems: Problem[];
}

/** A schema dump, named the way the diagnostic has to name it. */
interface Schema {
  readonly of: string;
  readonly text: string;
}

interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * git, for the questions whose "no" is an answer rather than a failure: a
 * lineage that did not exist at the base ref, a branch that has no parent.
 */
async function git(cwd: string, args: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, stdout };
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

function beside(url: string, database: string): string {
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

/** The lines `schema` carries that `other` does not, in the order the dump had them. */
function only(schema: string, other: string): string[] {
  const theirs = tally(other);
  const lines: string[] = [];
  for (const [line, count] of tally(schema)) {
    for (let extra = count - (theirs.get(line) ?? 0); extra > 0; extra--) lines.push(line);
  }
  return lines;
}

/** Everything the two dumps disagree about, addressed to whichever one has it. */
function divergence(left: Schema, right: Schema): string[] {
  return [
    ...only(left.text, right.text).map((line) => `only in ${left.of}: ${line}`),
    ...only(right.text, left.text).map((line) => `only in ${right.of}: ${line}`),
  ];
}

/** The shortest true sentence about the difference, for an annotation that cannot carry the listing. */
function headline(left: Schema, right: Schema): string {
  const sides = [
    { schema: left, lines: only(left.text, right.text) },
    { schema: right, lines: only(right.text, left.text) },
  ];
  return sides
    .filter(({ lines }) => lines.length > 0)
    .map(
      ({ schema, lines }) =>
        `${schema.of} alone has ${lines.length} line(s), first \`${lines[0]}\``,
    )
    .join(", ");
}

/**
 * Every drizzle migration lineage in the tree, as the directory the migrator is
 * pointed at. A lineage is identified by the journal rather than by a
 * configured path: the journal is the file the migrator refuses to run without,
 * so a directory holding one is a lineage and a directory without one is not —
 * and a repo that moved its migrations does not also have to remember to tell
 * this gate. Listed through git, so a lineage a scaffolder has just generated
 * and not yet committed counts.
 */
async function lineagesIn(root: string): Promise<string[]> {
  const journals = await repoFiles(root, ["meta/_journal.json", "*/meta/_journal.json"]);
  return journals.map((journal) => dirname(dirname(journal)));
}

/** A migration lineage as the base ref had it, or nothing where the base ref had none. */
interface BaseLineage {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

async function baseLineage(
  root: string,
  rev: string,
  dir: string,
): Promise<BaseLineage | undefined> {
  const listed = await git(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    `${rev}:./${dir}`,
  ]);
  // The lineage did not exist at the base ref: whatever it holds now is what a
  // database at that ref had of it, which is nothing, and replaying this
  // branch's copy of it from empty is exactly that.
  if (!listed.ok) return undefined;

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
 * deploy runs.
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
  await server.close();

  await onTheBaseLineage(root, lineages, () => migrate(root, upgrade));
  await migrate(root, upgrade);
  return await schemaOf(upgrade);
}

/** A verdict with nothing to report, which is every passing one. */
function passed(summary: string): Verdict {
  return { summary, divergence: [], problems: [] };
}

function refused(summary: string, message: string, divergence: string[]): Verdict {
  return { summary, divergence, problems: [{ message }] };
}

const REPLAYED =
  "replay: the migrations rebuild the schema from empty, and a second replay leaves it identical";

export async function replayGate({ root, url, upgrade }: Replay): Promise<Verdict> {
  await migrate(root, url);
  const fresh: Schema = { of: "the schema built from empty", text: await schemaOf(url) };
  await migrate(root, url);
  const again: Schema = { of: "the schema after a second replay", text: await schemaOf(url) };

  if (fresh.text !== again.text) {
    return refused(
      "replay: the history does not replay onto itself",
      `replaying the migrations a second time changed the schema — ${headline(fresh, again)} — a schema must not depend on how many times it was migrated; make the statements that ran again re-runnable, or have the runner skip what it has already applied`,
      divergence(fresh, again),
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

  const lineages = (
    await Promise.all((await lineagesIn(root)).map((dir) => baseLineage(root, rev, dir)))
  ).filter((lineage): lineage is BaseLineage => lineage !== undefined);
  if (lineages.length === 0) {
    return passed(
      `${REPLAYED}; ${from} carries no migration lineage, so the upgrade path is not proved for this run`,
    );
  }

  const upgraded: Schema = {
    of: `the schema upgraded from ${from}`,
    text: await upgradedSchema(root, url, lineages),
  };
  if (upgraded.text === fresh.text) {
    return passed(`${REPLAYED}; upgrading a database built from ${from} reaches the same schema`);
  }

  return refused(
    `replay: the upgrade path from ${from} does not reach the schema a fresh database gets`,
    `upgrading a database built from ${from} does not reach the schema this branch builds from empty — ${headline(fresh, upgraded)} — the lineage ${from} had already applied has changed under it: a migration was rewritten, or a new one was ordered behind one already applied. An applied migration is never re-read, so no deployed database will ever reach this schema; put the change in a new migration, ordered after every one that has shipped.`,
    divergence(fresh, upgraded),
  );
}
