import { inputs, list, report } from "../_lib/gate.ts";
import { suppressionHygiene } from "./suppression-hygiene.ts";

const read = inputs("working-directory", "fixtures");

report(
  await suppressionHygiene({
    root: read["working-directory"],
    fixtures: list(read["fixtures"]),
  }),
);
