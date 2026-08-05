import { SQL } from "bun";

import { inputs, report } from "../_lib/gate.ts";
import {
  allowlistFrom,
  timestamptzGate,
  WALL_CLOCK_QUERY,
  type WallClockColumn,
} from "./timestamptz.ts";

const read = inputs("timestamp-allowlist", "database-url");
if (read["database-url"] === "") {
  throw new Error("database-url is empty — the calling job owns the database it declared");
}

// Read through Bun's own client: the runner needs no psql, and the rows arrive
// typed rather than as text to split on a separator an identifier could contain.
const sql = new SQL(read["database-url"]);
const columns = (await sql.unsafe(WALL_CLOCK_QUERY)) as WallClockColumn[];
await sql.close();

report(timestamptzGate(columns, allowlistFrom(read["timestamp-allowlist"])));
