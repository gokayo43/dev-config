import { inputs, list, report } from "../_lib/gate.ts";
import { pinGate } from "./pins.ts";

const read = inputs("working-directory", "extra-paths");

report(await pinGate(read["working-directory"], list(read["extra-paths"])));
