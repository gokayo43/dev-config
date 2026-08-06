import { appendFile } from "node:fs/promises";

import { entry, inputs, report } from "../_lib/gate.ts";
import { capacity, parseSummary, ranOnFrom } from "./capacity.ts";

await entry(async () => {
  const read = inputs("summary-file", "step-summary", "ran-on");

  const { table, problems } = capacity(
    parseSummary(await Bun.file(read["summary-file"]).text()),
    ranOnFrom(read["ran-on"]),
  );
  // Published even for a run this step is about to fail: the table is what says
  // which way the ramp went wrong.
  if (table !== undefined) await appendFile(read["step-summary"], table);

  report(problems);
});
