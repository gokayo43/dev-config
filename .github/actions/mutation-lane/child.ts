/**
 * A child process the lane runs and reads: what it wrote, how it exited, and
 * whether the lane's deadline ended it. The two the lane starts, the named
 * tests' unmutated run and Stryker, end at one deadline, the run's, so no run
 * of the lane is left for GitHub's step limit to kill without a word.
 */
import { plainly } from "../_lib/gate.ts";

/** How long a child the deadline asked to stop has before it is killed outright. */
const GRACE_MS = 5_000;

export interface Ran {
  /** What it wrote to stdout and stderr, one after the other. */
  readonly out: string;
  readonly err: string;
  readonly status: number;
  /** Whether it was still running at the deadline, so that the lane ended it. */
  readonly ended: boolean;
}

/**
 * Runs `argv` in `cwd` until it exits or `deadline` (an epoch in milliseconds)
 * passes. At the deadline it is asked to stop, as Stryker expects to be, so it
 * takes its workers down with it; one still there after the grace is killed.
 */
export async function ran(argv: readonly string[], cwd: string, deadline: number): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
    cwd,
    env: plainly(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  let ended = false;
  const stop = setTimeout(
    () => {
      ended = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), GRACE_MS).unref();
    },
    Math.max(0, deadline - Date.now()),
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  clearTimeout(stop);
  return { out, err, status, ended };
}
