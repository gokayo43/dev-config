#!/usr/bin/env bun
// oxlint-disable no-console -- stdout is this CLI's answer and stderr its diagnostic
/**
 * The request-timing reader: reads a log on stdin, keeps the records among its
 * lines, and prints per operation where the time went.
 *
 * ```sh
 * journalctl -o cat -u my-app --since -7d | bun run request-timing-report
 * journalctl -o cat -u my-app --since -7d | bun run request-timing-report --json
 * ```
 *
 * Exits 0 with a summary, 1 on a record it cannot read or a schema version it
 * does not know, and 2 when the input held no record. The summary itself is
 * `request-timing-summary.ts`, which `tests/request-timing-summary.test.ts`
 * drives; this file is the stdin, the stdout and the status.
 */
import {
  NO_RECORD,
  printed,
  Reader,
  SUMMARISED,
  UNREADABLE,
  UnreadableRecord,
} from "./request-timing-summary.ts";

const args = Bun.argv.slice(2);
if (args.some((arg) => arg !== "--json")) {
  console.error(`request-timing-report takes --json alone, and was given ${args.join(" ")}`);
  process.exit(UNREADABLE);
}

const reader = new Reader();
try {
  for await (const line of console) reader.add(line);
} catch (error) {
  if (!(error instanceof UnreadableRecord)) throw error;
  console.error(`request-timing-report: ${error.message}`);
  process.exit(UNREADABLE);
}
const summary = reader.summary();
if (summary.records === 0) {
  console.error(
    `request-timing-report: no record in ${summary.lines} lines. A record is a whole line holding one JSON object with "requestTiming"; strip any prefix the log adds (journalctl -o cat).`,
  );
  process.exit(NO_RECORD);
}
console.log(args.includes("--json") ? JSON.stringify(summary) : printed(summary).trimEnd());
process.exit(SUMMARISED);
