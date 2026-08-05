import { SQL } from "bun";

import { inputs, list, report } from "../_lib/gate.ts";
import { timestamptzGate, WALL_CLOCK_QUERY, type WallClockColumn } from "./timestamptz.ts";

const read = inputs("timestamp-allowlist", "database-url");

// The database the migrations just ran against, read through Bun's own client:
// the runner needs no psql, and the rows arrive typed rather than as text to
// split on a separator a column name could itself contain.
const sql = new SQL(read["database-url"]);
const columns = (await sql.unsafe(WALL_CLOCK_QUERY)) as WallClockColumn[];
await sql.close();

report(timestamptzGate(columns, list(read["timestamp-allowlist"])));
