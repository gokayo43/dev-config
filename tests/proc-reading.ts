/**
 * What the suites ask `/proc` about processes they started, and the processes
 * they start to ask it about. Every question goes through `procStat`, whose
 * judgement of one stat line `file-lock.test.ts` grades over the captured texts
 * in `proc-stat/`.
 */
import { readdir } from "node:fs/promises";
import { userInfo } from "node:os";

import { procStat } from "../file-lock.ts";
import { must } from "../narrowing.ts";

/** Every process of a group that still runs. */
export async function runningIn(group: number): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await procStat(Number(name));
    if (stat?.alive === true && stat.group === group) found.push(Number(name));
  }
  return found;
}

/** Waits until a process is in `state`, which the kernel gets it to on its own time. */
export async function reaches(pid: number, state: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await procStat(pid))?.state === state) return;
    await Bun.sleep(25);
  }
  throw new Error(`process ${pid} never reached state ${state}`);
}

/**
 * Waits until every thread of a process has exited, as the kernel lists its
 * threads under `/proc/<pid>/task`. A killed process shows `Z` while its other
 * threads are still exiting, so the state letter alone comes too early.
 */
export async function exits(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await procStat(pid))?.state === "Z" && (await readdir(`/proc/${pid}/task`)).length === 1) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`process ${pid} never wholly exited`);
}

/** Reads a child's stdout until it has said `lines` whole lines, and returns them. */
export async function heard(out: ReadableStream<Uint8Array>, lines: number): Promise<string[]> {
  const reader = out.getReader();
  let said = "";
  while (said.split("\n").length <= lines) {
    const { value, done } = await reader.read();
    if (done)
      throw new Error(`the child closed its stdout having said only ${JSON.stringify(said)}`);
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return said.split("\n").slice(0, lines);
}

/** A process started under a parent that never reaps it, so it stays a zombie once it dies. */
export interface Orphan extends AsyncDisposable {
  readonly pid: number;
  /** The first lines it printed, as many as were asked for. */
  readonly said: readonly string[];
}

/**
 * Starts `argv` in the background of a `sh` that then execs `sleep`, which
 * waits for nothing, and reads its pid and then `lines` lines of what it says.
 * Disposing kills the parent, so whatever adopts the orphan next reaps it.
 */
export async function orphaned(argv: readonly string[], lines = 0): Promise<Orphan> {
  const parent = Bun.spawn(["sh", "-c", '"$@" & echo $!; exec sleep 60', "sh", ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [pid = "", ...said] = await heard(parent.stdout, 1 + lines);
  return {
    pid: Number(pid),
    said,
    async [Symbol.asyncDispose](): Promise<void> {
      parent.kill("SIGKILL");
      await parent.exited;
    },
  };
}

/** How a script run by `besideAHiddenProcess` ended. */
export interface Ended {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `script` with bun, as this user, in a pid and mount namespace of its own
 * whose `/proc` is mounted `hidepid=1`, where another user's entry is listed and
 * its read refused. `nobody` runs a `sleep` there, whose pid and start tick the
 * script finds in `OTHER` and `OTHER_TICKS`. Root mounts it, which is the sudo
 * these cases need, and reads the tick before it drops to this user. sudo
 * resets `PATH` to its own, which need not hold `bun`, so the script is handed
 * this process's: what it starts by name is found as it is outside. The script
 * is the namespace's first process, so everything in it dies when it exits.
 */
export async function besideAHiddenProcess(script: string): Promise<Ended> {
  const me = userInfo();
  const sealed = Bun.spawn(
    [
      "sudo",
      "-n",
      "unshare",
      "--pid",
      "--mount",
      "--fork",
      "--mount-proc",
      "sh",
      "-c",
      'mount -o remount,hidepid=1 /proc || exit 1; setpriv --reuid=65534 --regid=65534 --clear-groups sleep 60 & OTHER=$!; TICKS=$(cut -d " " -f 22 "/proc/$OTHER/stat"); exec setpriv --reuid="$1" --regid="$2" --init-groups env PATH="$6" HOME="$3" OTHER="$OTHER" OTHER_TICKS="$TICKS" "$4" -e "$5"',
      "sh",
      String(me.uid),
      String(me.gid),
      me.homedir,
      process.execPath,
      script,
      must(process.env["PATH"]),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(sealed.stdout).text(),
    new Response(sealed.stderr).text(),
    sealed.exited,
  ]);
  return { code, stdout, stderr };
}
