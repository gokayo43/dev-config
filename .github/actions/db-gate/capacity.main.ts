import { appendFile } from "node:fs/promises";

import { inputs, report } from "../_lib/gate.ts";
import { capacityReport, type Summary } from "./capacity.ts";

const read = inputs("summary-file", "step-summary");

const { problems, markdown } = capacityReport(
  (await Bun.file(read["summary-file"]).json()) as Summary,
);

if (markdown !== "") await appendFile(read["step-summary"], markdown);

report(problems);
