import { entry, inputs, list, notice, report } from "../_lib/gate.ts";
import { repoContract } from "./repo-contract.ts";

await entry(async () => {
  const read = inputs("working-directory", "database", "exemptions");
  const exemptions = list(read["exemptions"]);

  for (const name of exemptions) notice(`exempt from '${name}'`);

  report(
    await repoContract(read["working-directory"], {
      database: read["database"] === "true",
      exemptions,
    }),
  );
});
