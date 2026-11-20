/**
 * What the suites ask `/proc` about processes they started, and the processes
 * they start to ask it about. Every question goes through `procStat`, whose
 * judgement of one stat line `file-lock.test.ts` grades over the captured texts
 * in `proc-stat/`.
 */
import { readdir } from "node:fs/promises";

import { procStat } from "../file-lock.ts";

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
