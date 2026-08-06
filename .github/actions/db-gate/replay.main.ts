import { detail, entry, inputs, notice, report, required } from "../_lib/gate.ts";
import { replayGate } from "./replay.ts";

await entry(async () => {
  const read = inputs("upgrade-gate", "base-ref", "before");

  // The database the calling job declared, from the environment it owns. Taking
  // it as an action input as well would be two sources that can disagree about
  // which database was replayed into — and this is the step that asserts it
  // first, so it is the one that says what the caller has to do.
  const url = required("DATABASE_URL", "the calling job must set it for the database it declared");

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
  // A run that failed says so through its annotations. A summary beside them
  // would be the step paraphrasing its own error back at the reader.
  if (summary !== undefined) notice(summary);
  report(problems);
});
