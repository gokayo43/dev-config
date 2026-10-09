import { entry, inputs, list, report } from "../_lib/gate.ts";
import { workflowGate } from "./pins.ts";
import { dockerVolumes } from "./services.ts";

await entry(async () => {
  const read = inputs("extra-paths");

  // The checkout the calling job made, which is where every other step in this
  // action already looks.
  report(await workflowGate(".", list(read["extra-paths"]), dockerVolumes));
});
