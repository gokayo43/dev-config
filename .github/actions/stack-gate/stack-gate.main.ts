import { allowlistFrom, entry, inputs, report } from "../_lib/gate.ts";
import { stackGate } from "./stack-gate.ts";

await entry(async () => {
  const read = inputs("working-directory", "stack-allowlist");

  report(
    await stackGate(
      read["working-directory"],
      new URL("./stack-denylist.json", import.meta.url),
      allowlistFrom(read["stack-allowlist"], "stack-allowlist"),
    ),
  );
});
