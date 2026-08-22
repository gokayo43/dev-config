import { appendFile } from "node:fs/promises";

import { entry, inputs, log, notice, report } from "../_lib/gate.ts";
import { mutationLane } from "./mutation-lane.ts";

await entry(async () => {
  const read = inputs("working-directory", "mutation-floor", "step-summary", "base-ref", "before");

  const lane = await mutationLane({
    root: read["working-directory"],
    floor: read["mutation-floor"],
    // The two facts about the run, read from the `github` context by action.yml
    // rather than threaded through as inputs: they are the event's own,
    // identical for every caller, and a caller that had to pass them could pass
    // them wrong.
    event: { baseRef: read["base-ref"], before: read["before"] },
  });

  // What the run wrote goes out before the annotations, for the reason db-gate
  // publishes its divergence first: a reader who scrolls to the error finds
  // what it was about above it rather than somewhere below.
  if (lane.log !== undefined) log(lane.log);
  notice(lane.note);
  // Published even for a run this step is about to fail: the score and the
  // mutants behind it are what the annotations are about.
  if (lane.table !== undefined) await appendFile(read["step-summary"], lane.table);

  report(lane.problems);
});
