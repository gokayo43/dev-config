import type { Problem } from "../_lib/gate.ts";

/** A `timestamp without time zone` column, as `information_schema.columns` names it. */
export interface WallClockColumn {
  readonly table_name: string;
  readonly column_name: string;
}

/**
 * `timestamp without time zone` stores the digits someone typed and forgets
 * which clock produced them, so one row means two different instants either
 * side of a DST boundary or a server move. The database is asked directly
 * rather than a schema dump parsed: an ORM's `timestamp` is a hint, and the
 * catalogue is the fact.
 */
export function timestamptzGate(
  columns: readonly WallClockColumn[],
  allowlist: readonly string[],
): Problem[] {
  const deliberate = new Set(allowlist);
  return columns
    .map(({ table_name, column_name }) => `${table_name}.${column_name}`)
    .filter((column) => !deliberate.has(column))
    .map((column) => ({
      message: `${column} is 'timestamp without time zone' — store instants as timestamptz, or list it in timestamp-allowlist if it is a deliberate wall-clock value`,
    }));
}

export const WALL_CLOCK_QUERY = `
  select table_name, column_name
  from information_schema.columns
  where table_schema = 'public' and data_type = 'timestamp without time zone'
  order by table_name, column_name
`;
