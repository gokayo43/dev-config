import { entry, inputs, list, notice, report } from "../_lib/gate.ts";
import { repoContract } from "./repo-contract.ts";

await entry(async () => {
  const read = inputs("working-directory", "database", "exemptions", "base-ref", "before");
  const exemptions = list(read["exemptions"]);

  for (const name of exemptions) notice(`exempt from '${name}'`);

  report(
    await repoContract(read["working-directory"], {
      database: read["database"] === "true",
      exemptions,
      // The two facts about the run, read from the `github` context by
      // action.yml rather than threaded through as inputs: they are the event's
      // own, identical for every caller, and a caller that had to pass them
      // could pass them wrong.
      event: { baseRef: read["base-ref"], before: read["before"] },
    }),
  );
});
