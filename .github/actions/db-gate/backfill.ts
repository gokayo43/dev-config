import { SQL } from "bun";

import {
  beside,
  compare,
  type Dump,
  dumpOf,
  migrate,
  passed,
  refused,
  scratchDatabase,
  shell,
  type Verdict,
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
 * seed leave anything behind", which would otherwise answer yes on
 * a database whose only rows are the journal's: the empty one this refuses to
 * grade. The name is drizzle's default, the same one the replay reads the
 * applied migrations out of.
 */
const JOURNAL_ROW = /^INSERT INTO \S*__drizzle_migrations\b/;

/**
 * A sequence's position, which is not data. An `insert ... on conflict do
 * nothing` consumes a value on every run whether or not the row lands, so two
 * runs of a correctly guarded backfill leave the same rows behind a different
 * high-water mark — and refusing that would be refusing the guard rather than
 * the backfill. The rows are what this compares; docs/gates/db-gate.md names it
 * among the things this cannot see.
 */
const SEQUENCE = /^SELECT pg_catalog\.setval\(/;

/**
 * The data as a set of statements rather than as a file: sorted, because the
 * order rows come back in is not a fact about them. pg_dump reads a table in
 * heap order, and an UPDATE writes a new tuple wherever there is room for one —
 * so a run that rewrote rows can hand back the same rows in another order once
 * the space its own dead tuples freed becomes reusable. That is a fact about
 * when autovacuum last woke up, and a gate whose verdict turns on it would be
 * one nobody could reproduce. No fixture in the suite demonstrates it, which is
 * the point: the comparison is of rows, and this is what makes that true rather
 * than usually true.
 *
 * `--inserts` rather than the default COPY, because each line has to name its
 * own table once the order is gone: a bare tab-separated row in a diagnostic
 * belongs to no table its reader can find.
 */
async function dataOf(url: string, of: string): Promise<Dump> {
  const dumped = await dumpOf(url, ["--data-only", "--inserts"]);
  const lines = dumped.split("\n").filter((line) => line.trim() !== "" && !SEQUENCE.test(line));
  return { of, text: lines.toSorted().join("\n") };
}

async function kept(dump: Dump, where: string): Promise<Dump> {
  await Bun.write(where, `${dump.text}\n`);
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
    return refused([
      {
        message:
          "backfill-seed is set and backfill-command is empty — the seed writes the state a backfill is graded against, and there is no backfill here to grade",
      },
    ]);
  }
  if (seed === "") {
    return refused([
      {
        message:
          "backfill-command is set and backfill-seed is empty — this runs against a database the migrations have just built, where a backfill has nothing to backfill and running it twice proves nothing; name the command that writes the state the backfill was written for",
      },
    ]);
  }

  const database = scratchDatabase(root, "backfill");
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
    const seeded = await kept(await dataOf(own, "the state the seed wrote"), evidence.seeded);
    const wrote = seeded.text.split("\n").some((line) => ROW.test(line) && !JOURNAL_ROW.test(line));
    if (!wrote) {
      return refused([
        {
          message: `backfill-seed (\`${seed}\`) left no rows behind, so running the backfill twice would compare two empty databases and pass whatever the backfill does — write the state the backfill was written for, the rows it is meant to find`,
        },
      ]);
    }

    await shell(
      root,
      own,
      command,
      `backfill-command (\`${command}\`) failed against ${database} — its own output is above; it ran against the state backfill-seed had just written`,
    );
    const first = await kept(await dataOf(own, "the data after one backfill"), evidence.first);

    await shell(
      root,
      own,
      command,
      `backfill-command (\`${command}\`) failed on its second run, having just succeeded on the first — its own output is above; it is running against a database that already has its effects, which is what a retried or resumed deploy does to it`,
    );
    const second = await kept(
      await dataOf(own, "the data after a second backfill"),
      evidence.second,
    );

    const changed = compare(first, second);
    if (changed !== undefined) {
      return refused(
        [
          {
            message: `running the backfill a second time changed the data — ${changed.headline} — a backfill is re-run whenever a deploy is retried or resumed, or when a range it already covered is covered again, so a second run has to leave what the first one left; guard each statement on the state it produces, rather than on nothing`,
          },
        ],
        changed.lines,
      );
    }

    return passed(
      `backfill: \`${command}\` leaves the same data when it runs a second time over the state \`${seed}\` writes`,
    );
  } finally {
    await server.unsafe(`drop database if exists "${database}" with (force)`);
    await server.close();
  }
}
