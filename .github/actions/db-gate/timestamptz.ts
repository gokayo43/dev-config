import { type Allowlist, deadEntries, isObject, kindOf, type Problem } from "../_lib/gate.ts";

/** A column, as `information_schema.columns` names it. */
export interface Column {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  /** The type as the catalogue spells it: `timestamp`, `timestamptz`, `_timestamp`, `int4`. */
  readonly udt_name: string;
}

/** The four names this gate reads, so a catalogue row missing one says which. */
const COLUMN_FIELDS = ["table_schema", "table_name", "column_name", "udt_name"] as const;

/**
 * Every column a catalogue answer holds, refused unless each row carries the
 * four names below as text.
 *
 * One decoder for two readers: the gate reads the rows a live Postgres
 * answered, and the suite reads the ones captured from one into
 * `columns.json`. Two decodings of "a column" would let the fixture keep a
 * shape the database no longer produces, which is the one thing a captured
 * fixture must not be able to do.
 */
export function columnsFrom(value: unknown, source: string): Column[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} is ${kindOf(value)} rather than a list of columns`);
  }
  return value.map((row: unknown, at) => {
    if (!isObject(row)) throw new Error(`${source} row ${at} is ${kindOf(row)} rather than a row`);
    const [table_schema, table_name, column_name, udt_name] = COLUMN_FIELDS.map((field) => {
      const held = row[field];
      if (typeof held !== "string") {
        throw new Error(`${source} row ${at} has ${field} as ${kindOf(held)} rather than text`);
      }
      return held;
    });
    return {
      table_schema: table_schema ?? "",
      table_name: table_name ?? "",
      column_name: column_name ?? "",
      udt_name: udt_name ?? "",
    };
  });
}

/**
 * The wall-clock types, each keyed to the type it should have been. The array
 * element type is the fix, not the column type: an array of wall-clock
 * timestamps becomes timestamptz[], not timestamptz.
 *
 * `udt_name` rather than `data_type`, because an array of wall-clock timestamps
 * reports its data_type as ARRAY and hides the element type in `_timestamp`.
 * Being in here is also the whole of what "wall-clock" means below, so the
 * answer to "is it one" and the answer to "what should it be" are one read.
 *
 * A Map rather than an object, because the key is a Postgres identifier and a
 * repo may call an enum whatever it likes. An object answers `constructor` and
 * `toString` out of its prototype, and truthily — so a schema with a type of
 * that name would go red and its author be told to store instants as
 * `function Object() { [native code] }`. A Map holds what was put in it and
 * nothing else, which makes that unrepresentable rather than guarded against.
 */
const WALL_CLOCK = new Map([
  ["timestamp", "timestamptz"],
  ["_timestamp", "timestamptz[]"],
]);

/**
 * Keyed by schema as well as table, because `app.events.occurred_at` and
 * `public.events.occurred_at` are two different columns and an allowlist that
 * could not tell them apart would exempt both.
 */
function named({ table_schema, table_name, column_name }: Column): string {
  return [table_schema, table_name, column_name].join(".");
}

/**
 * `timestamp without time zone` stores the digits someone typed and forgets
 * which clock produced them, so one row means two different instants either
 * side of a DST boundary or a server move. The catalogue is asked directly
 * rather than a schema dump parsed: an ORM's `timestamp` is a hint, and the
 * database is the fact.
 *
 * Every column under grade arrives, not only the wall-clock ones, because the
 * allowlist is graded against the same catalogue: a waiver naming a column the
 * schema no longer has stands for nobody, and which of the two ways that
 * happened — the column is gone, or it is here and is no longer wall-clock — is
 * the difference between a name to fix and an entry to drop, so the diagnostic
 * says which. An exemption nobody has to justify again is indistinguishable, a
 * year later, from a bug someone silenced, and a dead one leaves this gate
 * covering one column fewer than the allowlist claims.
 *
 * There is no suppression rule beside that check, and the siblings that have
 * one are why it is worth saying so: stack-gate goes quiet about dead entries
 * while a manifest will not parse, and route-coverage while the app reported no
 * route table, because a universe that came up short reports as dead every
 * waiver written for the part it could not read. This one is a single query —
 * it answered in full, or it threw in the entry point and nothing here ran at
 * all — so there is no half-read catalogue for a dead entry to be an artefact
 * of.
 *
 * The allowlist arrives whole rather than as its entries, so that enforcing the
 * reason on each of them is not something a caller can typecheck without.
 */
export function timestamptzGate(columns: readonly Column[], allowlist: Allowlist): Problem[] {
  const wallClock = new Map<string, string>();
  const present = new Set<string>();
  for (const column of columns) {
    const name = named(column);
    present.add(name);
    const fix = WALL_CLOCK.get(column.udt_name);
    if (fix !== undefined) wallClock.set(name, fix);
  }

  const deliberate = new Set(allowlist.entries);
  const refusals = [...wallClock]
    .filter(([column]) => !deliberate.has(column))
    .map(([column, fix]) => ({
      message: `${column} is a wall-clock timestamp — store instants as ${fix}, or list it in timestamp-allowlist if it is a deliberate wall-clock value`,
    }));

  const fossils = deadEntries(allowlist, new Set(wallClock.keys()), present, (column, here) =>
    here
      ? `timestamp-allowlist waives ${column}, which is not a wall-clock column — the migration this entry was written against has been made, so drop the entry`
      : `timestamp-allowlist waives ${column}, which this schema has no column called — drop the entry, or fix the name to match the column it was written for`,
  );

  return [...allowlist.problems, ...refusals, ...fossils];
}

// Every schema except the catalogue's own, not just `public`: a drizzle
// `pgSchema()` table lives elsewhere and is no less wrong for it. That does
// include a schema an extension installed — a false positive is a line in the
// allowlist, and the alternative is a pg_depend join for a case no repo here
// has yet.
//
// Every column rather than only the wall-clock ones, because the allowlist is
// graded against this too: which types are wall-clock is a fact about this
// gate, and pushing it into the `where` clause would leave the gate unable to
// tell a waiver for a converted column from one for a column that is gone.
export const COLUMN_QUERY = `
  select table_schema, table_name, column_name, udt_name
  from information_schema.columns
  where table_schema <> 'information_schema'
    and table_schema not like 'pg\\_%'
  order by table_schema, table_name, column_name
`;
