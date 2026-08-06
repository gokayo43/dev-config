import { detail, entry, inputs, notice, report } from "../_lib/gate.ts";
import { replayGate } from "./replay.ts";

await entry(async () => {
  const read = inputs("upgrade-gate", "base-ref", "before");

  // The database the calling job declared, from the environment it owns. Taking
  // it as an action input as well would be two sources that can disagree about
  // which database was replayed into — and this is the step that asserts it
  // first, so it is the one that says what the caller has to do.
  const url = Bun.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("the calling job must set DATABASE_URL for the database it declared");
  }

  const { summary, divergence, problems } = await replayGate({
    // The action ran this from the project it was pointed at, and the migrator
    // and the lineage are both read relative to it.
    root: process.cwd(),
    url,
    upgrade:
      read["upgrade-gate"] === "true"
        ? { baseRef: read["base-ref"], before: read["before"] }
        : undefined,
  });

  detail(divergence);
  notice(summary);
  report(problems);
});
