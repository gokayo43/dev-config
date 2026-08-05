import { entry, inputs, report } from "../_lib/gate.ts";
import { composeLint } from "./compose-lint.ts";

await entry(async () => {
  const read = inputs("working-directory", "file");
  const file = read["file"];

  report(composeLint(file, await Bun.file(`${read["working-directory"]}/${file}`).text()));
});
