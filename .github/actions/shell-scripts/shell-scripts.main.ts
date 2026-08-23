import { entry, inputs, report } from "../_lib/gate.ts";
import { shellScripts } from "./shell-scripts.ts";

await entry(async () => {
  const read = inputs("working-directory", "shellcheck");

  report(await shellScripts(read["working-directory"], read["shellcheck"]));
});
