import { entry, inputs, report } from "../_lib/gate.ts";
import { composeLint } from "./compose-lint.ts";

await entry(async () => {
  const read = inputs("working-directory", "file");
  const root = read["working-directory"];
  const file = read["file"];

  report(await composeLint(root, file, await Bun.file(`${root}/${file}`).text()));
});
