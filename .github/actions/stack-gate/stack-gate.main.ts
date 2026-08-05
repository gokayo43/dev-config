import { inputs, report } from "../_lib/gate.ts";
import { stackGate } from "./stack-gate.ts";

const { "working-directory": root } = inputs("working-directory");

report(await stackGate(root, new URL("./stack-denylist.json", import.meta.url)));
