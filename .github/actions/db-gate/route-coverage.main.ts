import { allowlistFrom, entry, inputs, notice, report } from "../_lib/gate.ts";
import { routeCoverage } from "./route-coverage.ts";

await entry(async () => {
  const read = inputs("server-log", "route-allowlist");

  // The log the boot step redirected the app into, which is where it printed
  // its route table and every route the ramp then reached.
  const { summary, problems } = routeCoverage(
    await Bun.file(read["server-log"]).text(),
    allowlistFrom(read["route-allowlist"]),
  );

  notice(summary);
  report(problems);
});
