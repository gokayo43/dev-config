import { inputs, list, report } from "../_lib/gate.ts";
import { pinGate } from "./pins.ts";

const read = inputs("extra-paths");

// The checkout the calling job made, which is where every other step in this
// action already looks.
report(await pinGate(".", list(read["extra-paths"])));
