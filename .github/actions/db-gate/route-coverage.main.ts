import { allowlistFrom, entry, inputs, notice, report } from "../_lib/gate.ts";
import { routeCoverage } from "./route-coverage.ts";

await entry(async () => {
  const read = inputs("server-log", "ramp-began-at", "route-allowlist");

  // The log the boot step redirected the app into: the route table it printed
  // at boot, and — from the byte the ramp began at — the routes the ramp itself
  // reached. The health poll that got the app this far wrote to the same file,
  // and it is this action's own traffic rather than the scenario's.
  const log = Bun.file(read["server-log"]);
  const began = Number.parseInt(read["ramp-began-at"], 10);
  if (!Number.isInteger(began) || began < 0) {
    throw new Error(`ramp-began-at is '${read["ramp-began-at"]}', which is not a byte offset`);
  }

  const allowlist = allowlistFrom(read["route-allowlist"], "route-allowlist");
  const { summary, problems } = routeCoverage(
    { all: await log.text(), underRamp: await log.slice(began).text() },
    allowlist.entries,
  );

  notice(summary);
  report([...allowlist.problems, ...problems]);
});
