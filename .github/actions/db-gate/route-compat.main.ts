import { allowlistFrom, entry, inputs, publish } from "../_lib/gate.ts";
import { routeCompat } from "./route-compat.ts";
import { parseRouteLog } from "./route-table.ts";

await entry(async () => {
  const read = inputs("route-log", "route-retire", "snapshot-evidence", "base-ref", "before");

  const log = parseRouteLog(await Bun.file(read["route-log"]).text(), "the route log");

  await publish(
    await routeCompat({
      // The action ran this from the project it was pointed at, which is where
      // the snapshot and the manifest are.
      root: process.cwd(),
      event: { baseRef: read["base-ref"], before: read["before"] },
      served: log.routeTable,
      retire: allowlistFrom(read["route-retire"], "route-retire"),
      evidence: read["snapshot-evidence"],
    }),
  );
});
