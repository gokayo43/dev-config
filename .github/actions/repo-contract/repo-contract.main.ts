import { entry, inputs, list, notice, report } from "../_lib/gate.ts";
import { databaseGatesOf, notDatabaseGates } from "./ci-workflow.ts";
import { repoContract } from "./repo-contract.ts";

await entry(async () => {
  const read = inputs(
    "working-directory",
    "database",
    "exemptions",
    "data-jobs-external",
    "base-ref",
    "before",
  );
  const exemptions = list(read["exemptions"]);

  for (const name of exemptions) notice(`exempt from '${name}'`);

  // In the log for the same reason an exemption is: a waiver nobody sees is one
  // nobody reviews. Trimmed where it is graded rather than here, so the rule and
  // the reading of it stay in one place.
  const dataJobsExternal = read["data-jobs-external"];
  if (dataJobsExternal.trim() !== "") {
    notice(`the data jobs run outside this repo: ${dataJobsExternal}`);
  }

  // Refused rather than read as `none`, which is what any "is it the word I
  // know" test does with a value nobody defined: `none` is the one value that
  // switches every database rule off, so a typo would shed them in silence.
  const database = databaseGatesOf(read["database"]);
  if (database === undefined) throw new Error(notDatabaseGates(read["database"]));

  report(
    await repoContract(read["working-directory"], {
      database,
      exemptions,
      dataJobsExternal,
      // The two facts about the run, read from the `github` context by
      // action.yml rather than threaded through as inputs: they are the event's
      // own, identical for every caller, and a caller that had to pass them
      // could pass them wrong.
      event: { baseRef: read["base-ref"], before: read["before"] },
    }),
  );
});
