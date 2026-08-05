import { appendFile } from "node:fs/promises";

import { inputs, report } from "../_lib/gate.ts";
import { capacityTable, parseSummary } from "./capacity.ts";

const read = inputs("summary-file", "step-summary");

const table = capacityTable(parseSummary(await Bun.file(read["summary-file"]).text()));
if (table !== undefined) await appendFile(read["step-summary"], table);

report(
  table === undefined
    ? [
        {
          message:
            "the capacity ramp produced no requests — k6 ran but measured nothing, so there is no number to record",
        },
      ]
    : [],
);
