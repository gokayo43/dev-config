import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import type { Problem, Verdict } from "../_lib/gate.ts";
import { beside, databaseIn, discard, migrate, rows, scratchDatabase, textIn } from "./database.ts";

/**
 * What the upgrade path cannot see, asked directly: **the rows a deployed
 * database already holds still mean what this branch says they mean.**
 *
 * The upgrade gate compares two schemas, and two schemas converging is the
 * whole of what it proves. A migration that rewrites what a *value* stands for
 * converges perfectly and is wrong everywhere: the classic is a `timestamp`
 * column read as UTC by a backfill written on a UTC machine, which is right for
 * every row it was tested against and off by a day for every row written at
 * UTC+13. Nothing errors, the schemas match, and the gate that exists to catch
 * a divergent upgrade passes it.
 *
 * So this replays the base ref's migrations, writes rows the way a deployed
 * database already holds them, applies this branch's migrations on top, and
 * asks the repo's own assertions what those rows now say.
 *
 * **The rows go in as SQL, never through the app.** That is the property the
 * whole gate rests on and the one shortcut that would void it: application code
 * at HEAD writes rows the way HEAD understands them, so a fixture that went
 * through it would be testing the new semantics against themselves and would
 * agree with any migration at all. The fixture is written against the base
 * ref's schema and nothing else — a column this branch adds is not one a
 * fixture can name, and a fixture that names one is refused by the database
 * rather than accommodated here.
 *
 * What it cannot see is in docs/gates/upgrade-path.md, under "What a semantic
 * fixture cannot see".
 */

/**
 * The database the fixtures are replayed in, beside the one the caller
 * declared. `database.ts` says why it is derived rather than fixed, and
 * replay.ts and backfill.ts name their own the same way: the purpose string
 * belongs to the gate that has one.
 */
export function fixtureDatabase(root: string): string {
  return scratchDatabase(root, "semantic_fixtures");
}

/**
 * The column an assertion answers with. Named rather than positional, so that
 * a `select *` written by somebody in a hurry is refused instead of having its
 * first column read as a sentence about the data.
 */
const VIOLATION = "violation";

/** How an assertion is spelled beside the fixture it grades. */
const ASSERTION = ".assert.sql";

const FIXTURE = ".sql";

/** One fixture and the assertion written for it, as the directory holds them. */
interface Pair {
  readonly fixture: string;
  readonly assertion: string;
}

export interface SemanticFixtures {
  /** Where the repo's own migrator runs — the project the caller declared. */
  readonly root: string;
  /** The database that job declared: the server this builds its own beside. */
  readonly url: string;
  /** The fixture directory, relative to `root`, as the input names it. */
  readonly dir: string;
  /** The base ref, abbreviated the way every diagnostic about it names it. */
  readonly from: string;
  /**
   * Runs `body` with every migration lineage rolled back to what the base ref
   * carried. Injected rather than imported, because the one thing that knows
   * how to do that also has to call this — and a gate importing the gate that
   * calls it is a cycle whichever way the arrow is drawn.
   */
  readonly atBase: (body: () => Promise<void>) => Promise<void>;
}

/**
 * Where the fixtures are, and the two words every diagnostic about one needs:
 * the directory as the *input* spells it, which is what an author goes back to,
 * and the commit the rows are supposed to have come from. One value rather than
 * three arguments, because two of the three are paths that differ only in which
 * one a reader would go looking for.
 */
interface Where {
  /** The directory on disk. */
  readonly at: string;
  /** The same directory as `semantic-fixtures` names it. */
  readonly dir: string;
  /** The base ref, abbreviated the way every diagnostic here abbreviates it. */
  readonly from: string;
}

/** A fixture's name without the suffix that says which half of the pair it is. */
function stem(name: string, suffix: string): string {
  return name.slice(0, Math.max(0, name.length - suffix.length));
}

/**
 * The pairs the directory holds, or everything wrong with it. Read whole and
 * graded whole, rather than a file at a time: a directory with three unpaired
 * fixtures is one edit to make, and three runs to be told about it is the
 * round-trip every diagnostic in this repo is written to avoid.
 *
 * Sorted by name, and the `NN-` prefix is what that buys: a fixture may write
 * the row an earlier one left, the way a history of real rows accumulates, and
 * the order the files are applied in has to be the order a reader sees.
 * Directory order is not an order — it is a fact about the filesystem.
 */
async function pairsIn(
  at: string,
  dir: string,
): Promise<{ readonly pairs: Pair[] } | { readonly problems: Problem[] }> {
  let names: string[];
  try {
    names = (await readdir(at)).toSorted();
  } catch {
    return {
      problems: [
        {
          message: `semantic-fixtures names ${dir}, which this project does not have — the fixtures are SQL files in a directory of the repo's own, and a gate pointed at nothing passes without having looked`,
        },
      ],
    };
  }

  const problems: Problem[] = names
    .filter((name) => !name.endsWith(FIXTURE))
    .map((name) => ({
      file: `${dir}/${name}`,
      message: `${dir} holds ${name}, which is not a fixture — every file in a semantic-fixture directory is either \`NN-<name>${FIXTURE}\` or the \`NN-<name>${ASSERTION}\` written for it, so that a file nobody spelled correctly cannot sit there looking like a fixture that runs`,
    }));

  const asserted = new Set(
    names.filter((name) => name.endsWith(ASSERTION)).map((name) => stem(name, ASSERTION)),
  );
  const written = names.filter((name) => name.endsWith(FIXTURE) && !name.endsWith(ASSERTION));
  const named = new Set(written.map((name) => stem(name, FIXTURE)));

  for (const name of written) {
    if (!asserted.has(stem(name, FIXTURE))) {
      problems.push({
        file: `${dir}/${name}`,
        // Rows nothing asks a question about are rows the gate cannot fail on,
        // which is the same silence as not having written them.
        message: `${dir}/${name} has no ${stem(name, FIXTURE)}${ASSERTION} beside it — a fixture writes the rows and the assertion is what the current contract says about them, so a fixture on its own asserts nothing`,
      });
    }
  }
  for (const name of asserted) {
    if (!named.has(name)) {
      problems.push({
        file: `${dir}/${name}${ASSERTION}`,
        message: `${dir}/${name}${ASSERTION} has no ${name}${FIXTURE} beside it — an assertion grades the rows its fixture wrote, and against a database nothing wrote to it is asking about no rows at all`,
      });
    }
  }

  if (problems.length === 0 && written.length === 0) {
    return {
      problems: [
        {
          message: `semantic-fixtures names ${dir}, which holds no fixture — write the rows a database deployed from the base ref already has, as \`NN-<name>${FIXTURE}\`, with the current contract's assertion beside each in \`NN-<name>${ASSERTION}\``,
        },
      ],
    };
  }
  if (problems.length > 0) return { problems };

  return {
    pairs: written.map((name) => ({
      fixture: name,
      assertion: `${stem(name, FIXTURE)}${ASSERTION}`,
    })),
  };
}

function reasonIn(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The rows a deployed database holds, written into one built from the base
 * ref's migrations. Stops at the first fixture that will not apply, because a
 * numbered fixture may be written against the rows an earlier one left: running
 * the rest would grade them against a state nobody wrote, and every diagnostic
 * after the first would be about that instead of about the mistake.
 *
 * A whole file goes to Postgres as one query string, however many statements
 * are in it, and the simple query protocol wraps such a string in an implicit
 * transaction — so a fixture applies whole or not at all, and a half-written
 * one is not a state anything downstream can be run against.
 */
async function write(
  db: SQL,
  { at, dir, from }: Where,
  pairs: readonly Pair[],
): Promise<Problem | undefined> {
  for (const { fixture } of pairs) {
    try {
      await db.unsafe(await Bun.file(join(at, fixture)).text());
    } catch (failure) {
      return {
        file: `${dir}/${fixture}`,
        message: `${dir}/${fixture} did not apply to a database built from ${from}'s migrations — ${reasonIn(failure)}. A semantic fixture writes rows a deployed database already holds, so it may name only what ${from}'s schema had; a column this branch adds is what the assertion beside it is for.`,
      };
    }
  }
  return undefined;
}

/**
 * What the repo's own assertions say about those rows once this branch's
 * migrations have run over them. Every assertion runs, rather than stopping at
 * the first that finds something: they are independent questions about one
 * database, and an author fixing a migration wants every row it got wrong.
 */
async function graded(
  db: SQL,
  { at, dir, from }: Where,
  pairs: readonly Pair[],
): Promise<Problem[]> {
  const found: Problem[] = [];
  for (const { fixture, assertion } of pairs) {
    const file = `${dir}/${assertion}`;
    try {
      const answered = await rows(db, await Bun.file(join(at, assertion)).text());
      found.push(
        ...answered.map((row, index) => ({
          file,
          message: `${textIn(row, VIOLATION, `${file} row ${index}`)} — ${file} says so about a row ${dir}/${fixture} wrote into a database built from ${from}, after this branch's migrations ran over it. Fix the migration that produced it: a deployed database is full of rows like these, and the schema converging says nothing about what they now mean.`,
        })),
      );
    } catch (failure) {
      // Three shapes arrive here as one, and the answer to all three is the
      // same sentence: SQL the database refused, a script of several statements
      // whose answer is a list of answers rather than rows, and a select whose
      // rows carry no `violation` to read. Each is a file to go back to, and
      // one mistake earns one diagnostic.
      found.push({
        file,
        message: `${file} is not an assertion this can read — ${reasonIn(failure)}. An assertion is one \`select\` over the migrated schema: no rows when the contract holds, and one row per violation otherwise, each with a text \`${VIOLATION}\` column saying what is wrong.`,
      });
    }
  }
  return found;
}

export async function semanticFixtures({
  root,
  url,
  dir,
  from,
  atBase,
}: SemanticFixtures): Promise<Verdict> {
  const where: Where = { at: join(root, dir), dir, from };
  const read = await pairsIn(where.at, dir);
  // Read before anything is built. A directory nobody can grade is a fault in
  // the call site, and paying for a database and a replay to say so would put
  // the slowest possible answer on the cheapest possible mistake.
  if ("problems" in read) return { problems: read.problems };

  const database = fixtureDatabase(root);
  const own = beside(url, database);
  const server = new SQL(url);
  try {
    // A database of this run's own on the caller's service, for the reason the
    // upgrade path and the backfill check each make one: the app boots against
    // the declared database a few steps later, and legacy rows have no business
    // being in it. Dropped first as well as last, because a run killed between
    // the two ends otherwise leaves the next one failing over a name its author
    // never chose.
    await server.unsafe(`drop database if exists "${database}" with (force)`);
    await server.unsafe(`create database "${database}"`);
    await atBase(async () => {
      await migrate(
        root,
        own,
        `bun run db:migrate failed replaying ${from}'s migrations into ${databaseIn(own)}, the database the semantic fixtures are written into — every lineage directory was rolled back to what ${from} carried, so the statement the output above names is that commit's rather than this branch's`,
      );
    });

    const db = new SQL(own);
    try {
      const refused = await write(db, where, read.pairs);
      if (refused !== undefined) return { problems: [refused] };

      await migrate(
        root,
        own,
        `bun run db:migrate failed applying this branch's migrations onto ${databaseIn(own)}, a database built from ${from} and holding the rows ${dir} wrote — the output above names the statement; it applies to a database the migrations have just built and not to one that already has rows in it, which every deployed database does`,
      );

      const violations = await graded(db, where, read.pairs);
      const each = read.pairs.length === 1 ? "fixture" : "fixtures";
      return violations.length > 0
        ? { problems: violations }
        : {
            note: `semantic fixtures: ${read.pairs.length} ${each} written into a database built from ${from} and migrated by this branch, with every assertion coming back empty`,
            problems: [],
          };
    } finally {
      // Before the drop below, which terminates it: a connection closed by the
      // server on its way out reports that instead of whatever the gate was
      // ending on.
      await db.close();
    }
  } finally {
    await discard(server, database);
  }
}
