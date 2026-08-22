import { appendFile } from "node:fs/promises";

import { entry, inputs, notice, report } from "../_lib/gate.ts";
import { mutationLane } from "./mutation-lane.ts";

await entry(async () => {
  const read = inputs("working-directory", "mutation-floor", "step-summary", "base-ref", "before");

  const { note, table, problems } = await mutationLane({
    root: read["working-directory"],
    floor: read["mutation-floor"],
    // The two facts about the run, read from the `github` context by action.yml
    // rather than threaded through as inputs: they are the event's own,
    // identical for every caller, and a caller that had to pass them could pass
    // them wrong.
    event: { baseRef: read["base-ref"], before: read["before"] },
  });

  notice(note);
  // Published even for a run this step is about to fail: the score and the
  // mutants behind it are what the annotations are about.
  if (table !== undefined) await appendFile(read["step-summary"], table);

  report(problems);
});
