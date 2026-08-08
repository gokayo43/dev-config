import { resolve } from "node:path";

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
 * pg_dump wraps its output in `\restrict`/`\unrestrict` tokens that are random
 * per invocation, so two dumps of one database never compare equal as-is.
 */
const PER_INVOCATION = /^\\(un)?restrict /;

/**
 * The database as pg_dump reports it, minus what differs between two runs of
 * pg_dump. What else counts as noise is the caller's — which half of the
 * database it asked for is what decides.
 */
export async function dumpOf(url: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["pg_dump", ...args, url], { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`pg_dump could not read ${databaseIn(url)} — its own error is above`);
  }
  return stdout
    .split("\n")
    .filter((line) => !PER_INVOCATION.test(line))
    .join("\n");
}

/** A dump, named the way the diagnostic has to name it. */
export interface Dump {
  readonly of: string;
  readonly text: string;
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
 * The lines `dump` carries that `other` does not, grouped by line and ordered
 * by where each first appeared. A line carried twice on one side and once on
 * the other is listed once, for the copy that has no partner.
 */
function only(dump: string, other: string): string[] {
  const theirs = tally(other);
  const lines: string[] = [];
  for (const [line, count] of tally(dump)) {
    for (let extra = count - (theirs.get(line) ?? 0); extra > 0; extra--) lines.push(line);
  }
  return lines;
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
 * lines before handing them over, and then this branch cannot be reached from
 * it at all.
 */
export function compare(left: Dump, right: Dump): Difference | undefined {
  if (left.text === right.text) return undefined;

  const sides = [
    { dump: left, lines: only(left.text, right.text) },
    { dump: right, lines: only(right.text, left.text) },
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
          `${dump.of} alone has ${lines.length} line${lines.length === 1 ? "" : "s"}, first \`${lines[0]}\``,
      )
      .join(", "),
  };
}
