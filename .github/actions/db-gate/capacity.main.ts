import { entry, inputs, publish } from "../_lib/gate.ts";
import { capacity, parseSummary, ranOnFrom } from "./capacity.ts";

await entry(async () => {
  const read = inputs("summary-file", "step-summary", "ran-on");

  await publish(
    capacity(parseSummary(await Bun.file(read["summary-file"]).text()), ranOnFrom(read["ran-on"])),
    read["step-summary"],
  );
});
