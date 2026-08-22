import type { SQL } from "bun";
import { resolve } from "node:path";

import { type ConfigObject, isObject, kindOf, notice } from "../_lib/gate.ts";

/**
 * Not a gate. What the gates in this directory that build a database of their
 * own share: where they put it, how they run the repo's own commands against
 * it, how they read one back as text, and the single derivation of "these two
 * came out the same".
 *
 * Two of them do this — the upgrade path, which builds the schema a deployed
 * database reaches, and the backfill check, which builds the state a backfill
 * is written for. Two derivations of "the same" would be two answers to the
 * question both of them exist to ask, and the day they disagreed nobody would
 * know which was right.
 */

/**
 * Whether there is a list here at all. Its own function because `Array.isArray`
 * narrows an `unknown` to `any[]` — every element then reads as `any`, which is
 * the thing the caller below is trying to stop having.
 */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The rows a query answered, as objects a reader can say something true about.
 *
 * `Bun.SQL` answers `any`: a driver cannot know what a string of SQL returns.
 * So a call site that goes straight to a field is asserting the shape, and the
 * assertion is the only thing standing between a renamed column and a
 * `TypeError` three frames from the query. The answer is refused here instead,
 * where the SQL that produced it is still in hand to name.
 */
export async function rows(db: SQL, query: string): Promise<readonly ConfigObject[]> {
  const answered = (await db.unsafe(query)) as unknown;
  if (!isList(answered)) {
    throw new Error(`the query answered ${kindOf(answered)} rather than rows — ${query}`);
  }
  return answered.map((row, at) => {
    if (!isObject(row)) {
      throw new Error(`row ${at} is ${kindOf(row)} rather than a row — ${query}`);
    }
    return row;
  });
}

/**
 * One named column out of every row, as the text it has to be. The column is
 * named twice on purpose — once in the SQL and once here — because that is what
 * makes a query and a reader that have drifted apart say so.
 */
export async function textColumn(db: SQL, query: string, column: string): Promise<string[]> {
  return (await rows(db, query)).map((row, at) => {
    const value = row[column];
    if (typeof value !== "string") {
      throw new Error(`row ${at} has ${column} as ${kindOf(value)} rather than text — ${query}`);
    }
    return value;
  });
}

/** The same server, pointing at a different database. */
export function beside(url: string, database: string): string {
  const swapped = new URL(url);
  swapped.pathname = `/${database}`;
  return swapped.href;
}

/** The database a URL names, for the diagnostics: the URL itself carries a password. */
export function databaseIn(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/**
 * A database of this run's own, beside the one the caller declared — named for
 * what it is for and for the checkout it is doing it to, rather than fixed.
 *
 * One Postgres can be answering more than one run of this gate at a time: two
 * worktrees of the same repo under review, this repo's own suite beside a
 * neighbour's. Under a fixed name each of them drops and recreates the database
 * the other is migrating, and both fail over a fault neither tree has — so the
 * name carries what actually distinguishes the runs, which is where each is
 * reading its migrations from.
 *
 * The path rather than a clock or a pid, because the name has to be the same on
 * every run of one checkout: a run killed between the create and the drop
 * leaves a database behind, and reclaiming it is `drop database if exists`
 * finding the name the next run derives. A name nothing derives twice would
 * leave one database per killed run on the server forever.
 */
export function scratchDatabase(root: string, purpose: string): string {
  // Resolved, so that the same project reached as `.` and as an absolute path
  // is one database rather than two.
  const digest = new Bun.CryptoHasher("sha256").update(resolve(root)).digest("hex");
  return `${purpose}_${digest.slice(0, 16)}`;
}

/**
 * The end of a gate that built a database of its own: the database goes, the
 * connection goes, and neither of them takes the reason the gate is ending.
 *
 * This is what a `finally` is for and where a throw is pure loss. The error on
 * its way out is the one the author has to read; an error raised here would
 * replace it, and the replacement is always about cleanup — so the run that
 * failed because the server went away reports `terminating connection due to
 * administrator command` and never mentions the migration that would not
 * apply. Worse, the throw skips the close under it, which is how a gate that
 * already lost its server also leaks the client.
 *
 * So the drop's failure is a notice and the close always runs. Leaving the
 * database behind is the cheap half of that trade: `scratchDatabase` derives
 * the name from the checkout, so the next run of this gate drops it before it
 * creates it, which is the same reclaiming that covers a run killed outright.
 */
export async function discard(server: SQL, database: string): Promise<void> {
  try {
    await server.unsafe(`drop database if exists "${database}" with (force)`);
  } catch (failure) {
    notice(
      `could not drop ${database}, the database this gate built for itself — ${failure instanceof Error ? failure.message : String(failure)}. The next run from this checkout drops it by the same derived name before it creates one, so it is reclaimed rather than leaked.`,
    );
  }
  await server.close();
}

/**
 * A command of the repo's own, against the database named. Its output is the
 * developer's — the SQL that would not apply, and the line it was on — so it
 * goes to the log rather than into a diagnostic that would quote a fragment.
 *
 * `failed` is the whole diagnostic rather than a database name, because these
 * run repeatedly over more than one database and a tree that is not always at
 * HEAD: "it failed against the second database" names something the author has
 * never heard of and leaves out the half that would tell them what broke.
 */
async function against(
  root: string,
  url: string,
  argv: readonly string[],
  failed: string,
): Promise<void> {
  const proc = Bun.spawn([...argv], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error(failed);
}

/** The repo's own migrator, which is the only one there is: nothing here writes SQL. */
export async function migrate(root: string, url: string, failed: string): Promise<void> {
  await against(root, url, ["bun", "run", "db:migrate"], failed);
}

/**
 * A command the repo wrote as shell, which is how a caller names one it has not
 * put in a package script. Through bash for the reason the boot step runs
 * `start-command` that way: a pipe, a `&&` or a quoted argument is shell, and a
 * split on whitespace would run something the caller did not write.
 */
export async function shell(
  root: string,
  url: string,
  command: string,
  failed: string,
): Promise<void> {
  await against(root, url, ["bash", "-c", command], failed);
}

/**
 * The database as pg_dump wrote it, whole. What counts as noise in it, and what
 * a unit of it even is, are the caller's to decide — see `Dump` below, which is
 * where that decision is recorded.
 */
export async function dumpOf(url: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["pg_dump", ...args, url], { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`pg_dump could not read ${databaseIn(url)} — its own error is above`);
  }
  return stdout;
}

/**
 * A dump, named the way a diagnostic has to name it, and already cut into the
 * units it is compared in.
 *
 * The cutting belongs to whoever produced it, because the two halves of a
 * database do not agree on what a unit is. A schema dump compares as lines: it
 * is deterministic, so two schemas holding the same statements in a different
 * order really are two schemas. Data does not — heap order is a fact about when
 * autovacuum last woke — so it compares as an unordered multiset, and a *line*
 * is then the wrong unit at exactly the wrong moment: `--inserts` puts raw
 * newlines inside string literals, so two databases holding `(1, 'A⏎B')` and
 * `(1, 'A⏎D')` share the fragment `INSERT INTO t VALUES (1, 'A` and differ only
 * in fragments that the sort is free to rearrange into each other. Whole
 * statements have no such fragments to trade.
 */
export interface Dump {
  readonly of: string;
  /** What one of `units` is, for a diagnostic that has to count them. */
  readonly each: string;
  /** Every unit, in the order the comparison should read them. */
  readonly units: readonly string[];
}

/**
 * The text two dumps are equal by, which is their units and their order.
 *
 * Joining on a separator a unit may itself contain looks like it could equate
 * two different partitions, and cannot. Both sides are cut by one scanner from
 * one grammar, so the boundaries are a function of the text: two unit lists
 * that join to the same string were cut from the same string, and are the same
 * list. Reading the units back out of the join — a length prefix, a separator
 * no unit can hold — would be machinery against an ambiguity that needs two
 * different cutters to exist.
 */
function joined({ units }: Dump): string {
  return units.join("\n");
}

/** How many times each unit occurs, since a dump repeats `SET`s and blank lines. */
function tally(units: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of units) {
    if (unit.trim() !== "") counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  return counts;
}

/**
 * The units `dump` carries that `other` does not, grouped and ordered by where
 * each first appeared. A unit carried twice on one side and once on the other
 * is listed once, for the copy that has no partner.
 */
function only(dump: readonly string[], other: readonly string[]): string[] {
  const theirs = tally(other);
  const units: string[] = [];
  for (const [unit, count] of tally(dump)) {
    for (let extra = count - (theirs.get(unit) ?? 0); extra > 0; extra--) units.push(unit);
  }
  return units;
}

/** How two dumps differ. There is no such thing as an empty one. */
export interface Difference {
  /** What the log gets: every line the two do not share, addressed to whichever has it. */
  readonly lines: string[];
  /** What the annotation gets: the shortest true sentence about it. */
  readonly headline: string;
}

/**
 * The single derivation of "these two came out the same". `undefined` is the
 * only way two dumps are equal, and every other answer carries both a headline
 * and something to print — so a refusal with nothing to say for itself cannot
 * be built. Two dumps holding the same statements in a different order are not
 * equal, and that difference names itself rather than coming out blank.
 *
 * Order matters here because a schema dump's does: pg_dump is deterministic, so
 * two schemas that differ only in arrangement differ. A caller for which order
 * is not a fact about the database — rows in a table have none — sorts its
 * units before handing them over, and then this branch cannot be reached from
 * it at all.
 */
export function compare(left: Dump, right: Dump): Difference | undefined {
  if (joined(left) === joined(right)) return undefined;

  const sides = [
    { dump: left, lines: only(left.units, right.units) },
    { dump: right, lines: only(right.units, left.units) },
  ].filter(({ lines }) => lines.length > 0);

  // Every line one holds, the other holds as often — so what differs is the
  // arrangement: the order of the statements, or the blank lines between them.
  // Which of the two it is, this does not know, and saying would be a guess.
  if (sides.length === 0) {
    const arranged = `${left.of} and ${right.of} differ, but not in which statements they hold — the same lines are arranged differently`;
    return { lines: [arranged], headline: arranged };
  }

  return {
    lines: sides.flatMap(({ dump, lines }) => lines.map((line) => `only in ${dump.of}: ${line}`)),
    headline: sides
      .map(
        ({ dump, lines }) =>
          `${dump.of} alone has ${lines.length} ${dump.each}${lines.length === 1 ? "" : "s"}, first \`${lines[0]}\``,
      )
      .join(", "),
  };
}
