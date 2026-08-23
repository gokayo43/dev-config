import { entry, inputs, publish } from "../_lib/gate.ts";
import { mutationLane } from "./mutation-lane.ts";

await entry(async () => {
  const read = inputs("working-directory", "mutation-floor", "step-summary", "base-ref", "before");

  await publish(
    await mutationLane({
      root: read["working-directory"],
      floor: read["mutation-floor"],
      // The two facts about the run, read from the `github` context by action.yml
      // rather than threaded through as inputs: they are the event's own,
      // identical for every caller, and a caller that had to pass them could pass
      // them wrong.
      event: { baseRef: read["base-ref"], before: read["before"] },
    }),
    read["step-summary"],
  );
});
