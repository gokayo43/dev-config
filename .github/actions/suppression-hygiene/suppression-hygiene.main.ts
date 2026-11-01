import { entry, inputs, report } from "../_lib/gate.ts";
import { suppressionHygiene } from "./suppression-hygiene.ts";

await entry(async () => {
  const read = inputs("working-directory");

  report(await suppressionHygiene(read["working-directory"]));
});
