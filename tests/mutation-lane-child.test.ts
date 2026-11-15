import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { GRACE_MS, ran } from "../.github/actions/mutation-lane/child.ts";
import { scratch } from "./tree.ts";

const DRIVER = join(import.meta.dir, "mutation-lane-child-driver.ts");

/** The pid a script wrote to `pid` in `dir`, once the whole of it is there. */
async function pidIn(dir: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const written = await readFile(join(dir, "pid"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    if (/^\d+\n$/.test(written)) return Number(written);
    // oxlint-disable-next-line anti-slop/no-real-timers -- the pid is written by a real process the lane started; there is no virtual clock a shell writes a file on
    await Bun.sleep(50);
  }
  throw new Error(`no pid was written to ${dir}/pid`);
}

/** Whether any process is left in the group `leader` led. */
function groupAlive(leader: number): boolean {
  try {
    process.kill(-leader, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/** The driver run as a lane of its own, in a group the case can signal without signalling the test run. */
function laneRunning(dir: string, script: string): Bun.Subprocess {
  return Bun.spawn(["bun", "--no-env-file", DRIVER, script], {
    cwd: dir,
    stdout: "ignore",
    stderr: "inherit",
    detached: true,
  });
}

describe("the child the lane runs", () => {
  // The child runs in a group of its own, so a signal to the lane's group
  // reaches only the lane: before the lane passed it on, Stryker and its
  // workers ran on after a Ctrl-C or a cancelled step.
  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s to the lane's group ends the child's group, and then the lane by the same signal",
    async (signal) => {
      const dir = await scratch();
      const lane = laneRunning(dir, "echo $$ > pid; exec sleep 41.7");
      const child = await pidIn(dir);

      process.kill(-lane.pid, signal);
      await lane.exited;

      expect(lane.signalCode).toBe(signal);
      expect(groupAlive(child)).toBe(false);
    },
  );

  // A child that ignores the interrupt is killed by the next one, as a second
  // Ctrl-C ends a run that would not stop.
  test("a second interrupt kills a group the first did not stop", async () => {
    const dir = await scratch();
    const lane = laneRunning(dir, "trap '' INT; echo $$ > pid; exec sleep 41.7");
    const child = await pidIn(dir);

    process.kill(-lane.pid, "SIGINT");
    // oxlint-disable-next-line anti-slop/no-real-timers -- the subject is a real SIGINT reaching a real process group; there is no virtual clock a signal is delivered on
    await Bun.sleep(500);
    expect(groupAlive(child)).toBe(true);
    process.kill(-lane.pid, "SIGINT");
    await lane.exited;

    expect(lane.signalCode).toBe("SIGINT");
    expect(groupAlive(child)).toBe(false);
  });

  // The deadline asks the group to stop; a child that ignores the request is
  // killed at the grace, which nothing else would end before its own minute.
  test("a child that ignores the request to stop is killed at the grace", async () => {
    const dir = await scratch();
    const deadline = Date.now() + 1_000;

    const run = await ran(
      ["sh", "-c", "trap '' TERM; echo $$ > pid; exec sleep 60"],
      dir,
      deadline,
    );
    const finished = Date.now();

    expect(run.status).toBe(137);
    expect(run.ended).toBe(true);
    expect(finished).toBeGreaterThanOrEqual(deadline + GRACE_MS);
    expect(finished).toBeLessThan(deadline + GRACE_MS + 1_000);
    expect(groupAlive(await pidIn(dir))).toBe(false);
  }, 15_000);
});
