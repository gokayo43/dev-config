#!/usr/bin/env bun
// oxlint-disable no-console -- stdout is this CLI's answer and stderr its progress and diagnostic
/**
 * The capacity ramp, as a command a repo runs against a target it names.
 *
 * ```sh
 * bun run capacity-ramp --health http://127.0.0.1:5190/api/health --path /api/things
 * bun run capacity-ramp --health http://127.0.0.1:3001/api/v1/health --script tests/capacity/ramp.js --max-users 40
 * ```
 *
 * Exits 0 when a measurement was made, whatever it found; 1 when none could be
 * made, writing no result; 2 on arguments it cannot read. The ramp itself is
 * `capacity-ramp-ladder.ts`, which `tests/capacity-ramp.test.ts` drives; this
 * file is the argv, the signals, the output and the status.
 */
import { relative, resolve } from "node:path";

import {
  k6Home,
  MEASURED,
  NO_MEASUREMENT,
  pinnedK6,
  planFrom,
  ramp,
  recorded,
  USAGE,
  WRONG_ARGUMENTS,
  WrongArguments,
} from "./capacity-ramp-ladder.ts";

const args = Bun.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(MEASURED);
}

const stopped = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped.abort();
  });
}

const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "pipe" });
if (git.exitCode !== 0) {
  console.error("capacity-ramp: run it inside the git repository the result belongs to");
  process.exit(WRONG_ARGUMENTS);
}
const root = git.stdout.toString().trim();

try {
  const asked = planFrom(args);
  const plan =
    asked.script === null ? asked : { ...asked, script: relative(root, resolve(asked.script)) };
  const { k6, version } = await pinnedK6(k6Home(process.env));
  const outcome = await ramp(
    plan,
    {
      k6,
      k6Version: version,
      log: (line) => {
        console.error(line);
      },
      signal: stopped.signal,
    },
    root,
  );
  if ("unmeasured" in outcome) {
    console.error(`capacity-ramp: no measurement, so no result was written. ${outcome.unmeasured}`);
    process.exit(NO_MEASUREMENT);
  }
  const { json, md } = await recorded(root, outcome.result);
  console.log((await Bun.file(md).text()).trimEnd());
  console.log(`\nWritten: ${json}\n         ${md}`);
  process.exit(MEASURED);
} catch (error) {
  if (!(error instanceof WrongArguments)) throw error;
  console.error(`capacity-ramp: ${error.message}\n\n${USAGE}`);
  process.exit(WRONG_ARGUMENTS);
}
