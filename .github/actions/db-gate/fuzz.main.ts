import { allowlistFrom, entry, inputs, publish, required } from "../_lib/gate.ts";
import { budgetFor, fuzz, fuzzVerdict, RESPONSE_BOUND_MS, seedFrom } from "./fuzz.ts";
import { parseRouteLog } from "./route-coverage.ts";
import { routesIn } from "./route-table.ts";

await entry(async () => {
  const read = inputs(
    "health-url",
    "route-log",
    "route-allowlist",
    "fuzz-seed",
    "nightly",
    "report-file",
    "step-summary",
  );

  // The same file the coverage floor was graded on, rather than a fetch of the
  // app's own endpoint: one read of the route table, so the routes this fuzzes
  // cannot be a different set from the routes that were held to the floor — and
  // a snapshot cannot be changed by the requests below, which is what keeps
  // this step's traffic out of the floor whatever order anybody puts the steps
  // in.
  const log = parseRouteLog(
    await Bun.file(read["route-log"]).text(),
    "the route log read after the ramp",
  );

  const fuzzed = await fuzz({
    // The app as the boot step and the ramp both named it, less whatever path
    // the health route sits at: every request here is a route of its own.
    origin: new URL(read["health-url"]).origin,
    routes: log.routeTable,
    // The ramp's own exemption, read from the ramp's own input. The reason a
    // repo wrote there is about the route rather than about the ramp — it is
    // destructive, or it needs a credential, or it reaches something off this
    // box — and every one of those is a reason not to send generated requests
    // at it either. The entries are graded by the coverage floor, which has
    // already run; this reads them.
    waived: routesIn(allowlistFrom(read["route-allowlist"], "route-allowlist")),
    seed: seedFrom(
      read["fuzz-seed"],
      required("GITHUB_RUN_ID", "the run's own id is what an unseeded run is seeded from"),
    ),
    budgetMs: budgetFor(read["nightly"]),
    boundMs: RESPONSE_BOUND_MS,
  });

  // Written before the verdict is published, so that a run whose annotations
  // are capped still leaves every failure it found somewhere a reader can get
  // at — the artifact is the whole of what this run saw, and the log above it
  // is the first few.
  await Bun.write(read["report-file"], `${JSON.stringify(fuzzed, undefined, 2)}\n`);

  await publish(fuzzVerdict(fuzzed), read["step-summary"]);
});
