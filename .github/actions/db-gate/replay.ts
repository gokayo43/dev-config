import { SQL } from "bun";

import { baseRevision, type Event, isList, isObject, type Verdict } from "../_lib/gate.ts";
import { type BaseLineage, baseLineages, JOURNAL, onTheBaseLineage } from "./base-lineage.ts";
import {
  compare,
  databaseIn,
  type Dump,
  dumpOf,
  inScratchDatabase,
  migrate,
  numberColumn,
  scratchDatabase,
  textColumn,
} from "./database.ts";
import {
  type Fixtures,
  fixturesIn,
  gradeFixtures,
  PURPOSE as FIXTURES,
} from "./semantic-fixtures.ts";

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
 *
 * A schema is the whole of what either question is about. What the base ref's
 * replay proves about the *rows* is `semantic-fixtures.ts`, which rides on the
 * second starting point above and is the only gate here that grades data. How a
 * checkout is put back onto the base ref's lineage for the length of that
 * replay is `base-lineage.ts`; this module decides what to do with the result.
 */

/**
 * The database the upgrade path is replayed into, beside the one the caller
 * declared. `database.ts` says why it is derived rather than fixed, and
 * backfill.ts names its own the same way: the purpose string belongs to the
 * gate that has one.
 */
export function upgradeDatabase(root: string): string {
  return scratchDatabase(root, UPGRADE_PATH);
}

/** What `database.ts` derives this gate's own database name from. */
const UPGRADE_PATH = "upgrade_path";

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
  /**
   * The repo's semantic-fixture directory, or empty for the repos that keep
   * none. It rides on the upgrade path rather than sitting beside it: the rows
   * are written into a database built from the base ref's migrations, which is
   * the replay `upgrade` asks for.
   */
  readonly fixtures: string;
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
  | {
      readonly dump: Dump;
      readonly replayed: string[];
      /** What the fixtures said, for the runs that asked for them. */
      readonly semantic: Verdict | undefined;
    };

/**
 * Both halves against one rollback of the lineage: the base ref's migrations
 * into the upgrade database and — where the caller asked for fixtures — into a
 * second one beside it, then this branch's migrations onto each.
 *
 * One rollback rather than two, because rolling the lineage back is the part of
 * this gate that moves files around in the author's checkout. Running it once
 * per half would double the window in which a killed process leaves the base
 * ref's migrations sitting in the working tree, and would pay for a second
 * replay of a history this run has already replayed.
 *
 * Two databases rather than one, because rows change what a migration does:
 * `ALTER TABLE ... ADD COLUMN ... NOT NULL` applies to an empty database and
 * fails on one with a row in it. That failure is worth catching and the
 * fixtures are exactly what puts rows there to catch it — but it is a different
 * question from whether the schemas converge, and answering it in the schema
 * comparison's own database would mean turning `semantic-fixtures` on had
 * changed the verdict of a gate the repo already had.
 */
async function bothHalves(
  root: string,
  rev: string,
  lineages: readonly BaseLineage[],
  upgrade: string,
  semantic: { readonly url: string; readonly fixtures: Fixtures } | undefined,
): Promise<Upgraded> {
  const from = rev.slice(0, 7);
  // The base phase runs *this branch's* `db:migrate` over the base ref's
  // files, which is the only migrator there is — so what it applied has to be
  // read back rather than assumed. A lineage the base ref carried that the
  // branch's script no longer names would otherwise be missing from both
  // halves and compare equal, while a deployed database keeps everything it
  // built from it.
  const applied = await onTheBaseLineage(root, lineages, async () => {
    const replayed = `every lineage directory was rolled back to what ${from} carried, so the statement the output above names is that commit's rather than this branch's`;
    await migrate(
      root,
      upgrade,
      `bun run db:migrate failed replaying ${from}'s migrations into ${databaseIn(upgrade)} — ${replayed}`,
    );
    if (semantic !== undefined) {
      await migrate(
        root,
        semantic.url,
        `bun run db:migrate failed replaying ${from}'s migrations into ${databaseIn(semantic.url)}, the database the semantic fixtures are written into — ${replayed}`,
      );
    }
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
    // After the dump, so that what the schema comparison reads is a database no
    // fixture has been near — and after the rollback, so the rows meet this
    // branch's migrations rather than the base ref's.
    semantic:
      semantic === undefined
        ? undefined
        : await gradeFixtures(root, semantic.url, semantic.fixtures, from),
  };
}

/**
 * The schema a deployed database reaches, and what the rows in one come to.
 * Both are built in databases of this gate's own beside the one the caller
 * declared, and both are gone again whichever way the run went — `database.ts`
 * says why that is one function rather than four lines here.
 */
async function upgradedSchema(
  root: string,
  url: string,
  rev: string,
  lineages: readonly BaseLineage[],
  fixtures: Fixtures | undefined,
): Promise<Upgraded> {
  return await inScratchDatabase(url, root, UPGRADE_PATH, async (upgrade) =>
    fixtures === undefined
      ? await bothHalves(root, rev, lineages, upgrade, undefined)
      : await inScratchDatabase(
          url,
          root,
          FIXTURES,
          async (own) => await bothHalves(root, rev, lineages, upgrade, { url: own, fixtures }),
        ),
  );
}

/**
 * Two verdicts about one base ref, as the one verdict the step publishes. The
 * upgrade path asks whether the schema converges and the semantic fixtures ask
 * what the rows now mean; they are separate questions with separate answers,
 * and a step that published only the first would have an author fixing one of
 * two faults per run.
 */
function bothOf(left: string | undefined, right: string | undefined, between: string): string {
  return [left, right].filter((value) => value !== undefined && value !== "").join(between);
}

function alongside(first: Verdict, second: Verdict): Verdict {
  // Every field a Verdict carries, the table included, so that a half which
  // grows one is published rather than silently dropped here. Written out
  // rather than looped, because a loop over the field names is a generic
  // nobody can typecheck and three lines nobody can misread.
  const note = bothOf(first.note, second.note, "; ");
  const log = bothOf(first.log, second.log, "\n");
  const table = bothOf(first.table, second.table, "\n");
  return {
    ...(note === "" ? {} : { note }),
    ...(log === "" ? {} : { log }),
    ...(table === "" ? {} : { table }),
    problems: [...first.problems, ...second.problems],
  };
}

const REPLAYED =
  "replay: the migrations rebuild the schema from empty, and a second replay leaves it identical";

export async function replayGate({ root, url, upgrade, fixtures }: Replay): Promise<Verdict> {
  // Half of a pair is a caller who asked for this and would not get it. The
  // fixtures are written into the base ref's replay, so without that replay
  // there is nowhere to write them — and being quietly ignored is how a gate
  // somebody asked for turns out never to have run.
  if (upgrade === undefined && fixtures !== "") {
    return {
      problems: [
        {
          message: `semantic-fixtures names ${fixtures} and upgrade-gate is false — the fixtures are written into a database built from the base ref's migrations, which is the replay upgrade-gate adds; ask for both or for neither`,
        },
      ],
    };
  }

  // Beside the guard above and ahead of everything below, because everything
  // below costs migrator runs and a rollback of the author's lineage. A
  // directory nobody can grade is answerable from the filesystem alone.
  const asked = fixtures === "" ? undefined : await fixturesIn(root, fixtures);
  if (asked !== undefined && "problems" in asked) return { problems: asked.problems };

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
    return {
      log: repeated.lines.join("\n"),
      problems: [
        {
          message: `replaying the migrations a second time changed the schema — ${repeated.headline} — a schema must not depend on how many times it was migrated; make the statements that ran again re-runnable, or have the runner skip what it has already applied`,
        },
      ],
    };
  }

  if (upgrade === undefined) return { note: REPLAYED, problems: [] };

  // A checkout that cannot say where it came from is refused rather than
  // reported as having nothing to upgrade from: the whole check would pass by
  // having been given nothing to read.
  const base = await baseRevision(root, upgrade, READS_THE_BASE_REF);
  if ("refused" in base) throw new Error(base.refused);

  // What a run with no base replay owes a caller who also asked for fixtures.
  // They are written into that replay, so they did not run either, and a gate
  // that said nothing about it would read as one that had.
  const norFixtures =
    fixtures === "" ? "" : `, and neither are the ${fixtures} fixtures written into it`;

  const rev = base.rev;
  if (rev === undefined) {
    return {
      note: `${REPLAYED}; there is no earlier commit to upgrade from, so the upgrade path is not proved for this run${norFixtures}`,
      problems: [],
    };
  }
  const from = rev.slice(0, 7);

  const { lineages, problems } = await baseLineages(root, rev);
  if (problems.length > 0) return { problems };
  if (lineages.length === 0) {
    return {
      note: `${REPLAYED}; ${from} carries no migration lineage, so the upgrade path is not proved for this run${norFixtures}`,
      problems: [],
    };
  }

  const built = await upgradedSchema(root, url, rev, lineages, asked);
  if ("unapplied" in built) {
    return {
      // The same debt the two branches above pay. The base replay stopped short
      // of the lineage named below, so the fixtures written into it never ran,
      // and a run that only reported the lineage would read as one where they
      // had passed.
      ...(norFixtures === ""
        ? {}
        : { note: `the upgrade path is not proved for this run${norFixtures}` }),
      problems: built.unapplied.map((dir) => ({
        message: `${dir} is in ${from}'s lineage set and this branch's db:migrate never applied it — a database deployed from ${from} keeps everything that lineage built, and a rebuild never makes it; point db:migrate at ${dir} again`,
      })),
    };
  }

  const diverged = compare(fresh, built.dump);
  const upgraded: Verdict =
    diverged === undefined
      ? {
          note: `${REPLAYED}; upgrading a database built from ${from} (${built.replayed.join(", ")}) reaches the same schema`,
          problems: [],
        }
      : {
          log: diverged.lines.join("\n"),
          problems: [
            {
              message: `upgrading a database built from ${from} does not reach the schema this branch builds from empty — ${diverged.headline} — the lineage ${from} had already applied has changed under it: a migration was rewritten, or a new one was ordered behind one already applied. An applied migration is never re-read, so no deployed database will ever reach this schema; put the change in a new migration, ordered after every one that has shipped.`,
            },
          ],
        };

  return built.semantic === undefined ? upgraded : alongside(upgraded, built.semantic);
}
