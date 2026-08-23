import { SQL } from "bun";

import type { Verdict } from "../_lib/gate.ts";
import {
  beside,
  compare,
  discard,
  type Dump,
  dumpOf,
  migrate,
  scratchDatabase,
  shell,
} from "./database.ts";

/**
 * What a backfill is asked to prove: **running it a second time leaves what the
 * first run left.**
 *
 * A backfill is not a thing that runs once. A phased rollout runs it, finds a
 * range it missed, and runs it again; a deploy dies halfway and is retried; the
 * expand step ships on Tuesday and somebody re-runs the backfill on Friday for
 * the rows written in between. principles.md says backfills are idempotent
 * because every one of those is ordinary, and the shape that is not — an
 * `insert` with no conflict clause, an `update` guarded on nothing, a counter
 * incremented rather than set — costs a restore to undo and looks exactly like
 * a backfill that worked until somebody counts the rows.
 *
 * So: the repo's own migrations into a database of this run's own, the repo's
 * own seed command to put the state the backfill was written for into it, then
 * the backfill twice, with `pg_dump --data-only` either side of the second run.
 * Identical, or the step fails naming every line the two do not share.
 *
 * What it cannot see is in docs/gates/db-gate.md, under the section of that
 * name, and it is worth reading before trusting this for more than it says.
 */

/**
 * The database the backfill is graded in, beside the one the caller declared.
 * `database.ts` says why it is derived rather than fixed, and replay.ts names
 * its own the same way: the purpose string belongs to the gate that has one.
 */
export function backfillDatabase(root: string): string {
  return scratchDatabase(root, "backfill");
}

export interface Evidence {
  /** The state the seed wrote — what the backfill was graded against. */
  readonly seeded: string;
  readonly first: string;
  readonly second: string;
}

export interface Backfill {
  /** Where the repo's own commands run — the project the caller declared. */
  readonly root: string;
  /** The database that job declared: the server this builds its own beside. */
  readonly url: string;
  /** How the repo puts a database into the state its backfill was written for. */
  readonly seed: string;
  /** The backfill itself, which is what gets run twice. */
  readonly command: string;
  /** Where the three dumps are written, so that a step which failed leaves them behind. */
  readonly evidence: Evidence;
}

/** A row, as `pg_dump --inserts` writes one. */
const ROW = /^INSERT INTO /;

/**
 * The migrator's own bookkeeping, which every migrated database has and no seed
 * wrote. It is left in the comparison — a backfill that writes to the journal
 * has done something worth a diagnostic — and taken out of the question "did the
 * seed leave anything behind", which would otherwise answer yes on a database
 * whose only rows are the journal's: the empty one this refuses to grade. The
 * name is drizzle's default, the same one the replay reads the applied
 * migrations out of.
 */
const JOURNAL_ROW = /^INSERT INTO \S*__drizzle_migrations\b/;

/**
 * A chunk of the dump as the statement it is, once the comment lines above it
 * are dropped. Only the head of a chunk can be one: a `--` further in has
 * already been read as a comment, or sits inside a string literal or a quoted
 * identifier, and in none of those cases is it this statement's beginning.
 */
function statementIn(chunk: string): string {
  const lines = chunk.split("\n");
  let first = 0;
  while (first < lines.length) {
    const line = (lines[first] ?? "").trim();
    if (line !== "" && !line.startsWith("--")) break;
    first++;
  }
  return lines.slice(first).join("\n").trim();
}

/**
 * The dump cut into statements — the unit the data half is compared in, and the
 * whole reason this reads the text rather than splitting it.
 *
 * A statement ends at the first `;` that is outside all three things a `;` can
 * hide inside of: a `'` string literal, a `"` quoted identifier, and a `--`
 * comment. Each is load-bearing against real output. A value may contain `;`.
 * pg_dump's own `-- Data for Name: t; Type: TABLE DATA; Schema: public` header
 * would otherwise cut the statement under it into four. And a table whose name
 * needs quoting is written back quoted — `INSERT INTO public."it's"` and
 * `public."da--sh"` are both real dumps of real tables, and a scanner that
 * reads that `'` as a literal or that `--` as a comment runs on past the `;`
 * and swallows the rows after it.
 *
 * Neither doubled form needs a case of its own: `''` and `""` each close and
 * reopen, which leaves the scanner exactly where it was.
 *
 * Nothing else in this dialect hides a `;`. Dollar quoting reaches data-only
 * output only inside a function body, which `--data-only` does not write, and
 * the `E'…'` escape string — where a backslash would escape the closing quote —
 * is not emitted under the `standard_conforming_strings = on` that the dump
 * sets in its own header two lines above the first row.
 *
 * Everything after the last `;` is not a statement: the `\unrestrict` line
 * pg_dump signs off with, and nothing else.
 */
function statementsIn(dump: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inLiteral = false;
  let inIdentifier = false;
  let inComment = false;
  for (let at = 0; at < dump.length; at++) {
    if (inComment) {
      if (dump[at] === "\n") inComment = false;
      continue;
    }
    if (inLiteral) {
      if (dump[at] === "'") inLiteral = false;
      continue;
    }
    if (inIdentifier) {
      if (dump[at] === '"') inIdentifier = false;
      continue;
    }
    if (dump[at] === "'") inLiteral = true;
    else if (dump[at] === '"') inIdentifier = true;
    else if (dump[at] === "-" && dump[at + 1] === "-") inComment = true;
    else if (dump[at] === ";") {
      statements.push(statementIn(dump.slice(start, at + 1)));
      start = at + 1;
    }
  }
  return statements;
}

/**
 * The rows, as whole statements, sorted — because the order rows come back in
 * is not a fact about them. pg_dump reads a table in heap order, and an UPDATE
 * writes a new tuple wherever there is room for one, so a run that rewrote rows
 * can hand back the same rows in another order once the space its own dead
 * tuples freed becomes reusable. That is a fact about when autovacuum last woke
 * up, and a gate whose verdict turned on it would be one nobody could
 * reproduce.
 *
 * Sorting is also why the unit has to be the statement. Cut into lines, two
 * databases holding `(1, 'A⏎B'), (2, 'C⏎D')` and `(1, 'A⏎D'), (2, 'C⏎B')` are
 * one multiset of fragments and compare equal — a false pass over rows that
 * differ. A statement carries its own newlines and has no fragments to trade.
 *
 * Keeping only the `INSERT`s is what makes that safe to say. Everything else
 * pg_dump writes — the `SET`s, its comments, the `\restrict` token it
 * randomises per invocation, and the `setval` that moves a sequence whether or
 * not a row landed — is not a row, and dropping it by what a whole statement
 * starts with can never reach inside a value the way a line filter can.
 *
 * `--inserts` rather than the default COPY for the same reason the sort needs:
 * once order is gone each unit has to name its own table, and a bare
 * tab-separated row in a diagnostic belongs to no table its reader can find.
 */
async function dataOf(url: string, of: string, where: string): Promise<Dump> {
  const dumped = await dumpOf(url, ["--data-only", "--inserts"]);
  const rows = statementsIn(dumped).filter((statement) => ROW.test(statement));
  const dump = { of, each: "row", units: rows.toSorted() };
  // Written where it was read rather than by the caller, so that every read
  // this gate makes is one the run can publish: a dump the step compared and
  // did not leave behind is a verdict nobody can check. What lands is what was
  // compared — sorted, and the rows alone — which is why the file is `.rows`
  // and not a `.sql` anyone could feed back to a database.
  await Bun.write(where, `${dump.units.join("\n")}\n`);
  return dump;
}

export async function backfillGate({
  root,
  url,
  seed,
  command,
  evidence,
}: Backfill): Promise<Verdict> {
  // Half of the pair is a caller who asked for this and will not get it. The
  // step runs when either input is set precisely so that this can be said out
  // loud: an input silently ignored is how a gate somebody asked for turns out
  // never to have run.
  if (command === "") {
    return {
      problems: [
        {
          message:
            "backfill-seed is set and backfill-command is empty — the seed writes the state a backfill is graded against, and there is no backfill here to grade",
        },
      ],
    };
  }
  if (seed === "") {
    return {
      problems: [
        {
          message:
            "backfill-command is set and backfill-seed is empty — this runs against a database the migrations have just built, where a backfill has nothing to backfill and running it twice proves nothing; name the command that writes the state the backfill was written for",
        },
      ],
    };
  }

  const database = backfillDatabase(root);
  const own = beside(url, database);
  const server = new SQL(url);
  try {
    // A database of this run's own on the caller's service, rather than the one
    // it declared: the seed writes rows, and the app the later steps boot has
    // to meet the database its migrations built and nothing else. Dropped first
    // as well as last, because a run killed between the two ends otherwise
    // leaves the next one failing over a name its author never chose.
    await server.unsafe(`drop database if exists "${database}" with (force)`);
    await server.unsafe(`create database "${database}"`);
    await migrate(
      root,
      own,
      `bun run db:migrate failed building ${database}, the database the backfill check runs in — the output above names the statement; the replay step has already applied this history to the database the job declared, so a failure here is about this database rather than about the migrations`,
    );

    await shell(
      root,
      own,
      seed,
      `backfill-seed (\`${seed}\`) failed against ${database} — its own output is above; it writes the state the backfill was written for, and nothing here can be graded without it`,
    );
    const seeded = await dataOf(own, "the state the seed wrote", evidence.seeded);
    const wrote = seeded.units.some((row) => !JOURNAL_ROW.test(row));
    if (!wrote) {
      return {
        problems: [
          {
            message: `backfill-seed (\`${seed}\`) left no rows behind, so running the backfill twice would compare two empty databases and pass whatever the backfill does — write the state the backfill was written for, the rows it is meant to find`,
          },
        ],
      };
    }

    await shell(
      root,
      own,
      command,
      `backfill-command (\`${command}\`) failed against ${database} — its own output is above; it ran against the state backfill-seed had just written`,
    );
    const first = await dataOf(own, "the data after one backfill", evidence.first);

    await shell(
      root,
      own,
      command,
      `backfill-command (\`${command}\`) failed on its second run, having just succeeded on the first — its own output is above; it is running against a database that already has its effects, which is what a retried or resumed deploy does to it`,
    );
    const second = await dataOf(own, "the data after a second backfill", evidence.second);

    const changed = compare(first, second);
    if (changed !== undefined) {
      return {
        log: changed.lines.join("\n"),
        problems: [
          {
            message: `running the backfill a second time changed the data — ${changed.headline} — a backfill is re-run whenever a deploy is retried or resumed, or when a range it already covered is covered again, so a second run has to leave what the first one left; guard each statement on the state it produces, rather than on nothing`,
          },
        ],
      };
    }

    return {
      note: `backfill: \`${command}\` leaves the same data when it runs a second time over the state \`${seed}\` writes`,
      problems: [],
    };
  } finally {
    await discard(server, database);
  }
}
