import { inputs, report } from "../_lib/gate.ts";
import { composeLint } from "./compose-lint.ts";

const read = inputs("working-directory", "file");
const file = read["file"];

report(composeLint(file, await Bun.file(`${read["working-directory"]}/${file}`).text()));
