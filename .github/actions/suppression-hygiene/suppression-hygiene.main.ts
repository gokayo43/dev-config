import { entry, inputs, list, report } from "../_lib/gate.ts";
import { suppressionHygiene } from "./suppression-hygiene.ts";

await entry(async () => {
  const read = inputs("working-directory", "fixtures");

  report(
    await suppressionHygiene({
      root: read["working-directory"],
      fixtures: list(read["fixtures"]),
    }),
  );
});
