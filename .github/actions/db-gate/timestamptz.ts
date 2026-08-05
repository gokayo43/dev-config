import { type Problem, report } from "../_lib/gate.ts";

const TABLE = /^CREATE TABLE (?:[^\s.]+\.)?(?:"([^"]+)"|([^\s"(]+)) \($/;
const COLUMN = /^\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s+(.+?),?$/;
const WALL_CLOCK = /\btimestamp(?:\(\d+\))? without time zone\b/;

export interface Column {
  readonly table: string;
  readonly column: string;
}

/**
 * `timestamp without time zone` stores the digits someone typed and forgets
 * which clock produced them, so the same row means two different instants
 * either side of a DST boundary or a server move. Reading the schema dump is
 * what catches it: an ORM column type is a hint, and the database is the fact.
 */
export function wallClockColumns(dump: string): Column[] {
  const found: Column[] = [];
  let table: string | undefined;

  for (const line of dump.split("\n")) {
    const start = TABLE.exec(line);
    if (start !== null) {
      table = start[1] ?? start[2];
      continue;
    }
    if (table === undefined) continue;
    if (line.startsWith(")")) {
      table = undefined;
      continue;
    }
    const column = COLUMN.exec(line);
    if (column === null) continue;
    if (WALL_CLOCK.test(column[3] ?? "")) found.push({ table, column: column[1] ?? column[2] ?? "" });
  }

  return found;
}

export function timestamptzGate(dump: string, allowlist: readonly string[]): Problem[] {
  const allowed = new Set(allowlist);
  return wallClockColumns(dump)
    .filter(({ table, column }) => !allowed.has(`${table}.${column}`))
    .map(({ table, column }) => ({
      message: `${table}.${column} is 'timestamp without time zone' — store instants as timestamptz, or list it in timestamp-allowlist if it is a deliberate wall-clock value`,
    }));
}

if (import.meta.main) {
  const dump = Bun.argv[2] ?? "";
  const allowlist = (Bun.env["INPUT_TIMESTAMP_ALLOWLIST"] ?? "").split(/\s+/).filter((entry) => entry !== "");
  report(timestamptzGate(await Bun.file(dump).text(), allowlist));
}
