/**
 * A process that takes the lock at `argv[2]` and stops for good before the
 * step `argv[3]`, or once it holds the lock where that is `held`, saying `at`
 * when it has: `file-lock.test.ts` kills it there, which is a worker killed at
 * that point of taking the lock.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { lock, type Step } from "../file-lock.ts";

/** Longer than any case waits to kill it; a timer, because a bare pending promise lets the process exit. */
const FOREVER = 3_600_000;

const [path = "", stop = ""] = process.argv.slice(2);

await using held = await lock(path, 10_000, async (next: Step) => {
  if (next === stop) {
    process.stdout.write("at\n");
    await sleep(FOREVER);
  }
  if (next === "wait") await sleep(25);
});
void held;
if (stop === "held") process.stdout.write("at\n");
await sleep(FOREVER);
