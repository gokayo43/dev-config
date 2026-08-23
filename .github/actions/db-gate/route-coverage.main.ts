import { allowlistFrom, entry, inputs, publish } from "../_lib/gate.ts";
import type { RouteLog } from "../../../route-log.ts";
import { parseRouteLog, routeCoverage } from "./route-coverage.ts";

async function routeLog(file: string, source: string): Promise<RouteLog> {
  return parseRouteLog(await Bun.file(file).text(), source);
}

await entry(async () => {
  const read = inputs("route-log-before", "route-log-after", "route-allowlist");

  // The two fetches of the app's counter endpoint the ramp step made, either
  // side of the k6 run. Whatever the boot step's health poll reached is already
  // inside the first of them, which is what keeps this action's own traffic out
  // of the floor.
  const [before, after] = await Promise.all([
    routeLog(read["route-log-before"], "the route log read before the ramp"),
    routeLog(read["route-log-after"], "the route log read after the ramp"),
  ]);

  await publish(
    routeCoverage(before, after, allowlistFrom(read["route-allowlist"], "route-allowlist")),
  );
});
