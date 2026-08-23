import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { SQL } from "bun";

import { type ConfigObject, type Problem, record, type Verdict } from "../_lib/gate.ts";
import { databaseIn, migrate, rows, scratchDatabase } from "./database.ts";

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
 * **The rows go in as SQL, never through the app.** That is the property the
 * whole gate rests on and the one shortcut that would void it: application code
 * at HEAD writes rows the way HEAD understands them, so a fixture that went
 * through it would be testing the new semantics against themselves and would
 * agree with any migration at all. The fixture is written against the base
 * ref's schema and nothing else — a column this branch adds is not one a
 * fixture can name, and a fixture that names one is refused by the database
 * rather than accommodated here.
 *
 * The base replay is not here. `replay.ts` owns the databases and the one
 * rollback of the lineage that fills them, because it is already doing that for
 * the schema half — and the rollback is the part of this gate that moves files
 * around in the checkout, so doing it twice would run the risky half twice. Two
 * questions here, and they are the two only this can answer: what a fixture
 * directory *is*, and what its rows say once the branch's migrations have run
 * over them.
 *
 * What it cannot see is in docs/gates/upgrade-path.md, under "What a semantic
 * fixture cannot see".
 */

/** What `database.ts` derives this gate's own database name from. */
export const PURPOSE = "semantic_fixtures";

/** The name that derivation produces, so a suite can say the gate left none behind. */
export function fixtureDatabase(root: string): string {
  return scratchDatabase(root, PURPOSE);
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

/**
 * A fixture directory that has been read and found gradeable, carried from the
 * refusal that reads it to the replay that runs it.
 *
 * Both spellings of the directory travel together because the diagnostics need
 * both: the path on disk to open, and the path as `semantic-fixtures` names it,
 * which is what an author goes back to.
 */
export interface Fixtures {
  /** The directory on disk. */
  readonly at: string;
  /** The same directory as `semantic-fixtures` names it. */
  readonly dir: string;
  readonly pairs: readonly Pair[];
}

/** A fixture's name without the suffix that says which half of the pair it is. */
function stem(name: string, suffix: string): string {
  return name.slice(0, Math.max(0, name.length - suffix.length));
}

/**
 * The pairs the directory holds, or everything wrong with it.
 *
 * Read before the gate builds anything — `replayGate` calls this beside its own
 * input guard, ahead of the first migrator run. A directory nobody can grade is
 * a mistake at the call site, and paying for two databases and a rollback of
 * the lineage to say so would put the slowest possible answer on the cheapest
 * possible mistake.
 *
 * Graded whole rather than a file at a time: a directory with three unpaired
 * fixtures is one edit to make, and three runs to be told about it is the
 * round-trip every diagnostic in this repo is written to avoid.
 *
 * Sorted by name, and the `NN-` prefix is what that buys: a fixture may write
 * over the rows an earlier one left, the way a history of real rows
 * accumulates, and the order they are applied in has to be the order a reader
 * sees. Directory order is a fact about the filesystem, not an order.
 */
export async function fixturesIn(
  root: string,
  dir: string,
): Promise<Fixtures | { readonly problems: Problem[] }> {
  const at = join(root, dir);
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
    at,
    dir,
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
 * A fixture file as text, refusing the bytes rather than repairing them.
 *
 * The default decoder substitutes U+FFFD for anything that is not UTF-8, which
 * is the worst of the three possible answers: a stray latin-1 byte inside a
 * string literal becomes a replacement character, the row is written with it,
 * and the assertion reports a violation about data the *decoder* mangled. The
 * author is then sent to read a migration that is fine. Inside a comment the
 * same byte changes nothing at all and the run goes green over a file nobody
 * can round-trip.
 */
async function textOf(
  path: string,
  named: string,
): Promise<{ readonly text: string } | { readonly problem: Problem }> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return {
      problem: {
        file: named,
        message: `${named} is not UTF-8 — the bytes are decoded strictly here rather than repaired, because a byte replaced with U+FFFD reaches the database as data and comes back as a violation about a row the migration never touched; save the file as UTF-8`,
      },
    };
  }
}

/** The command tags that mean a statement wrote something. Everything else read. */
const WRITING = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"]);

/**
 * How many rows a fixture wrote, by what Postgres reported for each statement
 * in it. `Bun.SQL` answers a single statement with the result carrying its own
 * `count` and `command`, and a file of several with one such result per
 * statement — so both shapes are the same fold.
 *
 * The command tag, not the count alone: a `select` reports a count too, and a
 * fixture that only reads has written nothing whatever that number says.
 */
function rowsWritten(answered: unknown): number {
  const own = writtenBy(answered);
  if (own > 0) return own;
  const held = record(answered);
  return Object.values(held).reduce<number>((total, one) => total + writtenBy(one), 0);
}

function writtenBy(result: unknown): number {
  const held = record(result);
  const command = held["command"];
  const count = held["count"];
  return typeof command === "string" && WRITING.has(command) && typeof count === "number"
    ? count
    : 0;
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
async function write(db: SQL, { at, dir, pairs }: Fixtures, from: string): Promise<Problem[]> {
  for (const { fixture } of pairs) {
    const named = `${dir}/${fixture}`;
    const read = await textOf(join(at, fixture), named);
    if ("problem" in read) return [read.problem];
    let answered: unknown;
    try {
      answered = await db.unsafe(read.text);
    } catch (failure) {
      return [
        {
          file: named,
          message: `${named} did not apply to a database built from ${from}'s migrations — ${reasonIn(failure)}. A semantic fixture writes rows a deployed database already holds, so it may name only what ${from}'s schema had; a column this branch adds is what the assertion beside it is for.`,
        },
      ];
    }
    // A fixture that wrote nothing is the same silence as no fixture at all: the
    // assertion beside it then asks the current contract about no rows, comes
    // back empty, and the run is green over a migration nobody tested. An empty
    // file, a file of comments, and an `insert ... select` that matched nothing
    // are one fault with one answer.
    if (rowsWritten(answered) === 0) {
      return [
        {
          file: named,
          message: `${named} wrote no rows — a semantic fixture is the rows a deployed database already holds, and an assertion over a table nothing was written to comes back empty whatever this branch's migrations did to it; write the rows the assertion beside it is about`,
        },
      ];
    }
  }
  return [];
}

/**
 * An assertion as this runs it: the repo's own text, made structurally into the
 * one thing an assertion is allowed to be.
 *
 * The wrapper is not decoration — it is what makes the invalid state
 * unrepresentable. An `.assert.sql` that is an `insert`, a `delete` or a
 * `create table` answers `[]` through the driver in exactly the way an empty
 * select does, so an author who wrote the wrong half of the pair got "every
 * assertion coming back empty" over data that was wrong, and a `delete` took
 * the next fixture's rows with it. Inside a CTE none of those parse; one that
 * does parse — a data-modifying CTE — has no `RETURNING` clause and is refused
 * by name; and the outer `select "violation"` refuses a select that has no such
 * column instead of reading whatever came first.
 *
 * The trailing semicolon goes because a statement terminator inside the
 * parentheses is a syntax error, and the body keeps its own newlines so that a
 * trailing `--` comment ends where its author ended it.
 */
function asked(text: string): string {
  return `with __assertion as (\n${text.trim().replace(/;\s*$/u, "")}\n) select "violation" from __assertion`;
}

/** What Postgres says about a table that is not there, and the name it names. */
const NO_SUCH_RELATION = /relation "([^"]+)" does not exist/u;

/**
 * What the repo's own assertions say about those rows once this branch's
 * migrations have run over them. Every assertion runs, rather than stopping at
 * the first that finds something: they are independent questions about one
 * database, and an author fixing a migration wants every row it got wrong.
 */
async function graded(db: SQL, { at, dir, pairs }: Fixtures, from: string): Promise<Problem[]> {
  const found: Problem[] = [];
  for (const { fixture, assertion } of pairs) {
    const file = `${dir}/${assertion}`;
    const read = await textOf(join(at, assertion), file);
    if ("problem" in read) {
      found.push(read.problem);
      continue;
    }
    let answered: readonly ConfigObject[];
    try {
      answered = await rows(db, asked(read.text));
    } catch (failure) {
      found.push(unreadable(file, `${dir}/${fixture}`, from, reasonIn(failure)));
      continue;
    }
    // Collected rather than mapped, because a row whose `violation` is NULL is
    // a fault in the assertion and the rows around it are still findings about
    // the data. Throwing on the null one — which is what reading each row as
    // text does — threw the real violations away with it.
    const nulls: number[] = [];
    for (const [index, row] of answered.entries()) {
      const said = row[VIOLATION];
      if (typeof said === "string") {
        found.push({
          file,
          message: `${said} — ${file} says so about a row ${dir}/${fixture} wrote into a database built from ${from}, after this branch's migrations ran over it. Fix the migration that produced it: a deployed database is full of rows like these, and the schema converging says nothing about what they now mean.`,
        });
      } else {
        nulls.push(index);
      }
    }
    if (nulls.length > 0) {
      found.push({
        file,
        message: `${file} answered ${nulls.length} row${nulls.length === 1 ? "" : "s"} (${nulls.join(", ")} of ${answered.length}) whose \`${VIOLATION}\` is not text — every row an assertion answers is a violation, and one that cannot say what is wrong with it is a row the assertion should not have selected; guard it, or make the column say something`,
      });
    }
  }
  return found;
}

/**
 * An assertion the database would not run, said as the fault it actually is.
 *
 * A table that is not there is the one shape worth separating: the fixture
 * wrote rows into it a moment ago, so this branch's migrations dropped or
 * renamed it — which is a fact about the migration, not about the assertion,
 * and telling the author their SQL is unreadable sends them to the wrong file.
 * An assertion asking after a table the fixtures never wrote to is not this
 * case and reads as what it is.
 */
function unreadable(file: string, fixture: string, from: string, reason: string): Problem {
  const missing = NO_SUCH_RELATION.exec(reason);
  if (missing !== null) {
    return {
      file,
      message: `${file} asks about ${missing[1]}, which this branch's migrations left the database without — ${fixture} wrote rows into a database built from ${from} and they are gone. A table a deployed database holds is not something a migration may drop without saying where the rows went; if it was renamed, the assertion follows it, and if the rows were meant to move, assert that they arrived.`,
    };
  }
  return {
    file,
    message: `${file} is not an assertion this can read — ${reason}. An assertion is one \`select\` over the migrated schema: no rows when the contract holds, and one row per violation otherwise, each with a text \`${VIOLATION}\` column saying what is wrong.`,
  };
}

/**
 * The fixtures against a database `replay.ts` has already replayed the base
 * ref's migrations into: the rows go in, this branch's migrations run over
 * them, and the repo's own assertions grade what is left.
 *
 * Everything that can go wrong here comes back as a `Verdict`, including the
 * branch's migrator refusing the rows. That refusal is a *finding of this gate*
 * — a migration that applies to a database the migrations have just built and
 * not to one carrying data is the class only these fixtures put rows there to
 * catch — and a throw would carry it out past the upgrade path's own verdict,
 * losing whatever that had already found about the schema. Two faults in one
 * branch have to reach their author in one run.
 */
export async function gradeFixtures(
  root: string,
  url: string,
  fixtures: Fixtures,
  from: string,
): Promise<Verdict> {
  const db = new SQL(url);
  try {
    const refused = await write(db, fixtures, from);
    if (refused.length > 0) return { problems: refused };

    try {
      await migrate(
        root,
        url,
        `bun run db:migrate failed applying this branch's migrations onto ${databaseIn(url)}, a database built from ${from} and holding the rows ${fixtures.dir} wrote — the output above names the statement; it applies to a database the migrations have just built and not to one that already has rows in it, which every deployed database does`,
      );
    } catch (failure) {
      return { problems: [{ message: reasonIn(failure) }] };
    }

    // Nothing an assertion does may reach the data, and this is the half of that
    // the CTE wrapper cannot cover: Postgres lets a data-modifying CTE inside a
    // `with`, so `with __a as (delete from event returning 'x' as violation)`
    // would parse, select, and take the next fixture's rows. Read-only from
    // here on, and the database refuses it by name — the fixtures are all
    // written by now, so nothing legitimate is left to write.
    await db.unsafe(`set session characteristics as transaction read only`);
    const violations = await graded(db, fixtures, from);
    const each = fixtures.pairs.length === 1 ? "fixture" : "fixtures";
    return violations.length > 0
      ? { problems: violations }
      : {
          note: `semantic fixtures: ${fixtures.pairs.length} ${each} written into a database built from ${from} and migrated by this branch, with every assertion coming back empty`,
          problems: [],
        };
  } finally {
    await db.close();
  }
}
