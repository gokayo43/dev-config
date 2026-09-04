import { allowlistFrom, entry, inputs, publish } from "../_lib/gate.ts";
import { routeCompat } from "./route-compat.ts";
import { parseRouteLog } from "./route-coverage.ts";

await entry(async () => {
  const read = inputs(
    "route-log-before",
    "route-retire",
    "snapshot-evidence",
    "base-ref",
    "before",
  );

  // The route table out of the fetch the ramp step made *before* k6 ran — the
  // app as it booted, before any of the ramp's traffic reached it. The coverage
  // floor reads both fetches because what it grades is their difference; this
  // floor grades the table itself, and the earlier read is the one nothing this
  // action did can have changed.
  const log = parseRouteLog(
    await Bun.file(read["route-log-before"]).text(),
    "the route log read before the ramp",
  );

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
