import { entry, inputs, publish } from "../_lib/gate.ts";
import { duplicateCode } from "./duplicate-code.ts";

await entry(async () => {
  const read = inputs("working-directory", "base-ref", "before");

  await publish(
    await duplicateCode({
      root: read["working-directory"],
      event: { baseRef: read["base-ref"], before: read["before"] },
    }),
  );
});
