import { allowlistFrom, entry, inputs, publish, required } from "../_lib/gate.ts";
import { allowlisted, budgetFor, fuzz, fuzzVerdict, RESPONSE_BOUND_MS, seedFrom } from "./fuzz.ts";
import { parseRouteLog } from "./route-table.ts";

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

  // The same file the compatibility floor read, rather than a fetch of the
  // app's own endpoint: one read of the route table, so the routes this fuzzes
  // cannot be a different set from the routes that floor held.
  const log = parseRouteLog(await Bun.file(read["route-log"]).text(), "the route log");
  const allowlist = allowlisted(
    log.routeTable,
    allowlistFrom(read["route-allowlist"], "route-allowlist"),
  );
  if ("refused" in allowlist) {
    await publish(
      {
        note: "fuzz: no request was sent, since route-allowlist is refused below and the route an entry was written for would have been fuzzed",
        problems: [...allowlist.refused],
      },
      read["step-summary"],
    );
    return;
  }

  const fuzzed = await fuzz({
    // The app as the boot step named it, less whatever path the health route
    // sits at: every request here is a route of its own.
    origin: new URL(read["health-url"]).origin,
    routes: log.routeTable,
    waived: allowlist.waived,
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
