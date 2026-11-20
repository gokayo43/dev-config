/**
 * A child process the lane runs and reads: what it wrote, how it exited, and
 * whether the lane's deadline ended it. The two the lane starts, the named
 * tests' unmutated run and Stryker, end at one deadline, the run's, so no run
 * of the lane is left for GitHub's step limit to kill without a word.
 *
 * Each runs in a process group of its own, and the group is what is signalled:
 * Stryker's workers and the `bun test` each one runs, and anything a test
 * starts, are in it, and a test's grandchild that inherits the pipes would
 * otherwise hold the lane until it chose to exit. A group of its own is also
 * out of reach of a signal to the lane's group, so the lane passes its
 * interrupts on itself.
 */
import { plainly } from "../_lib/gate.ts";

/** How long a group the deadline asked to stop has before it is killed outright, and how long its pipes are read after. */
export const GRACE_MS = 5_000;

/** What ends the lane from outside: a terminal's Ctrl-C, a runner cancelling the step, a closed terminal. */
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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
 * be; at `GRACE_MS` after it, whatever is left of the group is killed and its
 * pipes are read no further, so the lane returns within the deadline and the
 * grace. Once the child has exited, whatever it left in its group is killed
 * too, so nothing in the child's group outlives the call; a process that left
 * the group, by a session of its own, is outside the lane's reach.
 *
 * An interrupt of the lane while the child runs is passed on to the child's
 * group, and a second one kills the group. Once the child has exited the lane
 * stops listening and raises the first interrupt on itself, so it ends by
 * that signal as it would had it never listened.
 */
export async function ran(
  argv: readonly string[],
  cwd: string,
  deadline: number,
  environment: Record<string, string> = {},
): Promise<Ran> {
  const heard: NodeJS.Signals[] = [];
  // A listener runs on the event loop, never inside a call, so it runs only
  // once the spawn below has returned and `proc` is there.
  const hear = (signal: NodeJS.Signals): void => {
    heard.push(signal);
    signalGroup(proc.pid, heard.length === 1 ? signal : "SIGKILL");
  };
  const deaf = (): void => {
    for (const signal of INTERRUPTS) process.off(signal, hear);
  };
  // Listening before the spawn, since an interrupt that met no listener would
  // end the lane and leave the child it had just started.
  for (const signal of INTERRUPTS) process.on(signal, hear);
  const proc = spawned(argv, cwd, environment, deaf);
  const out = reading(proc.stdout);
  const err = reading(proc.stderr);
  const atGrace = (): void => {
    signalGroup(proc.pid, "SIGKILL");
    out.stop();
    err.stop();
  };

  // Set from the deadline's timer, so held where the compiler sees it change.
  const run = { ended: false };
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = setTimeout(
    () => {
      run.ended = true;
      signalGroup(proc.pid, "SIGTERM");
      grace = setTimeout(atGrace, GRACE_MS);
    },
    Math.max(0, deadline - Date.now()),
  );

  const status = await proc.exited;
  deaf();
  clearTimeout(stop);
  signalGroup(proc.pid, "SIGKILL");
  const [interrupt] = heard;
  if (interrupt !== undefined) process.kill(process.pid, interrupt);
  // A process that left the group still holds the pipes it inherited; its
  // output is read until the grace, counted from the deadline where the
  // deadline ended the run and from the exit where it did not.
  grace ??= setTimeout(atGrace, GRACE_MS);
  const [stdout, stderr] = await Promise.all([out.text, err.text]);
  clearTimeout(grace);
  return { out: stdout, err: stderr, status, ended: run.ended };
}

/** The child, in a group of its own; a spawn that fails stops the listening `ran` began. */
function spawned(
  argv: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  deaf: () => void,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  try {
    return Bun.spawn([...argv], {
      cwd,
      env: { ...plainly(process.env), ...environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    deaf();
    throw error;
  }
}

/**
 * The binary `ran` would start for `command`, looked up on the PATH its child
 * inherits, or `null` where that PATH holds none.
 */
export function onPath(command: string): string | null {
  return Bun.which(command, { PATH: process.env["PATH"] ?? "" });
}
