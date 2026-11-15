/**
 * A child process the lane runs and reads: what it wrote, how it exited, and
 * whether the lane's deadline ended it. The two the lane starts, the named
 * tests' unmutated run and Stryker, end at one deadline, the run's, so no run
 * of the lane is left for GitHub's step limit to kill without a word.
 *
 * Each runs in a process group of its own, and the group is what is signalled:
 * Stryker's workers and the `bun test` each one runs, and anything a test
 * starts, are in it, and a test's grandchild that inherits the pipes would
 * otherwise hold the lane until it chose to exit.
 */
import { plainly } from "../_lib/gate.ts";

/** How long a group the deadline asked to stop has before it is killed outright, and how long its pipes are read after. */
export const GRACE_MS = 5_000;

export interface Ran {
  /** What it wrote to stdout and stderr, one after the other. */
  readonly out: string;
  readonly err: string;
  readonly status: number;
  /** Whether it was still running at the deadline, so that the lane ended it. */
  readonly ended: boolean;
}

/** Signals every process left in a group; a group with none left is not an error. */
function signalGroup(leader: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-leader, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** A stream read to its end, or to `stop()`, whichever comes first. */
function reading(stream: ReadableStream<Uint8Array>): {
  readonly text: Promise<string>;
  stop(): void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  })();
  return {
    text: done,
    stop: () => {
      void reader.cancel();
    },
  };
}

/**
 * Runs `argv` in `cwd` until it exits or `deadline` (an epoch in milliseconds)
 * passes. At the deadline its group is asked to stop, as Stryker expects to
 * be; whatever is left of it after `GRACE_MS` is killed and its pipes are read
 * no further, so the lane returns within the deadline and the grace. Once the
 * child has exited, whatever it left in its group is killed too, so nothing the
 * lane started outlives the call.
 */
export async function ran(
  argv: readonly string[],
  cwd: string,
  deadline: number,
  environment: Record<string, string> = {},
): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...plainly(process.env), ...environment },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const out = reading(proc.stdout);
  const err = reading(proc.stderr);
  const stopReading = (): void => {
    out.stop();
    err.stop();
  };

  // Set from the deadline's timer, so held where the compiler sees it change.
  const run = { ended: false };
  let kill: ReturnType<typeof setTimeout> | undefined;
  const stop = setTimeout(
    () => {
      run.ended = true;
      signalGroup(proc.pid, "SIGTERM");
      kill = setTimeout(() => {
        signalGroup(proc.pid, "SIGKILL");
        stopReading();
      }, GRACE_MS);
    },
    Math.max(0, deadline - Date.now()),
  );

  const status = await proc.exited;
  clearTimeout(stop);
  signalGroup(proc.pid, "SIGKILL");
  // A process that left the group still holds the pipes it inherited; its
  // output is read for no longer than the grace, counted from the deadline
  // where the deadline ended the run.
  const readFor = run.ended ? Math.max(0, deadline + GRACE_MS - Date.now()) : GRACE_MS;
  const cutOff = setTimeout(stopReading, readFor);
  const [stdout, stderr] = await Promise.all([out.text, err.text]);
  clearTimeout(cutOff);
  clearTimeout(kill);
  return { out: stdout, err: stderr, status, ended: run.ended };
}
