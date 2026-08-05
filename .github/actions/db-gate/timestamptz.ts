import type { Problem } from "../_lib/gate.ts";

/** A wall-clock column, as `information_schema.columns` names it. */
export interface WallClockColumn {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
  /** `timestamp` or `_timestamp`, which is the difference between timestamptz and timestamptz[]. */
  readonly udt_name: string;
}

/**
 * `timestamp without time zone` stores the digits someone typed and forgets
 * which clock produced them, so one row means two different instants either
 * side of a DST boundary or a server move. The catalogue is asked directly
 * rather than a schema dump parsed: an ORM's `timestamp` is a hint, and the
 * database is the fact.
 *
 * Keyed by schema as well as table, because `app.events.occurred_at` and
 * `public.events.occurred_at` are two different columns and an allowlist that
 * could not tell them apart would exempt both.
 */
export function timestamptzGate(
  columns: readonly WallClockColumn[],
  allowlist: readonly string[],
): Problem[] {
  const deliberate = new Set(allowlist);
  return columns
    .map(({ table_schema, table_name, column_name, udt_name }) => ({
      column: [table_schema, table_name, column_name].join("."),
      // The array element type is the fix, not the column type: an array of
      // wall-clock timestamps becomes timestamptz[], not timestamptz.
      fix: udt_name === "_timestamp" ? "timestamptz[]" : "timestamptz",
    }))
    .filter(({ column }) => !deliberate.has(column))
    .map(({ column, fix }) => ({
      message: `${column} is a wall-clock timestamp — store instants as ${fix}, or list it in timestamp-allowlist if it is a deliberate wall-clock value`,
    }));
}

// Every schema except the catalogue's own, not just `public`: a drizzle
// `pgSchema()` table lives elsewhere and is no less wrong for it. That does
// include a schema an extension installed — a false positive is a line in the
// allowlist, and the alternative is a pg_depend join for a case no repo here
// has yet.
//
// `udt_name` rather than `data_type`, because an array of wall-clock timestamps
// reports its data_type as ARRAY and hides the element type in `_timestamp`.
export const WALL_CLOCK_QUERY = `
  select table_schema, table_name, column_name, udt_name
  from information_schema.columns
  where table_schema <> 'information_schema'
    and table_schema not like 'pg\\_%'
    and udt_name in ('timestamp', '_timestamp')
  order by table_schema, table_name, column_name
`;
