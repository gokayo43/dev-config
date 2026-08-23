import { entry, inputs, publish, required } from "../_lib/gate.ts";
import { replayGate } from "./replay.ts";

await entry(async () => {
  const read = inputs("upgrade-gate", "base-ref", "before", "step-summary");

  // The database the calling job declared, from the environment it owns. Taking
  // it as an action input as well would be two sources that can disagree about
  // which database was replayed into — and this is the step that asserts it
  // first, so it is the one that says what the caller has to do.
  const url = required("DATABASE_URL", "the calling job must set it for the database it declared");

  // A spelling this does not know would otherwise read as "not true" and leave
  // the check off without saying so — the failure mode check.yml's own input
  // guards exist to prevent, one layer down.
  const asked = read["upgrade-gate"];
  if (asked !== "true" && asked !== "false") {
    throw new Error(
      `upgrade-gate is "${asked}" — it takes true or false, and nothing else can be read as either`,
    );
  }

  await publish(
    await replayGate({
      // The action ran this from the project it was pointed at, and the
      // migrator and the lineage are both read relative to it.
      root: process.cwd(),
      url,
      upgrade: asked === "true" ? { baseRef: read["base-ref"], before: read["before"] } : undefined,
    }),
    read["step-summary"],
  );
});
