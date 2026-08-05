import { SQL } from "bun";

import { allowlistFrom, entry, inputs, report } from "../_lib/gate.ts";
import { timestamptzGate, WALL_CLOCK_QUERY, type WallClockColumn } from "./timestamptz.ts";

await entry(async () => {
  const read = inputs("timestamp-allowlist");

  // The same DATABASE_URL the migrate step ran against — one value, from the
  // environment the calling job owns. Taking it as an action input too would be
  // two sources that can disagree about which database was just migrated.
  //
  // The migrate step asserts this first, and says what the caller has to do; this
  // one says which step is left holding nothing, for the case where the steps are
  // ever reordered or run alone.
  const url = Bun.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is unset — the timestamp check reads the database migrate just used",
    );
  }

  // Read through Bun's own client: the runner needs no psql, and the rows arrive
  // typed rather than as text to split on a separator an identifier could contain.
  const sql = new SQL(url);
  const columns = (await sql.unsafe(WALL_CLOCK_QUERY)) as WallClockColumn[];
  await sql.close();

  const allowlist = allowlistFrom(read["timestamp-allowlist"], "timestamp-allowlist");
  report([...allowlist.problems, ...timestamptzGate(columns, allowlist.entries)]);
});
