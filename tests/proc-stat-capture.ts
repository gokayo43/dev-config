/**
 * Writes `tests/proc-stat/*.stat`: the `/proc/<pid>/stat` text of a real
 * process in each state `parseStat` in `file-lock.ts` has to judge, taken on
 * this machine as each state is reached. `tests/file-lock.test.ts` grades the
 * judgement over them. Run it by hand, `bun tests/proc-stat-capture.ts`, and
 * commit what it writes: a fixture typed by hand would grade a reading of the
 * kernel nobody took.
 *
 * Each zombie is a child whose parent never waits: `orphaned` in
 * `proc-reading.ts`.
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { exits, orphaned, reaches } from "./proc-reading.ts";

const HERE = join(import.meta.dir, "proc-stat");

/** A process this script started and has to end, whatever state it was left in. */
interface Taken extends AsyncDisposable {
  readonly pid: number;
}

/** The text, once the process is in `state`. Every state captured here holds until this script ends it. */
async function once(pid: number, state: string): Promise<string> {
  await reaches(pid, state);
  return await readFile(`/proc/${pid}/stat`, "utf8");
}

/** The text of a zombie, once every one of its threads has exited. */
async function dead(pid: number): Promise<string> {
  await exits(pid);
  return await readFile(`/proc/${pid}/stat`, "utf8");
}

function spawned(argv: readonly string[]): Taken {
  const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  return {
    pid: proc.pid,
    async [Symbol.asyncDispose](): Promise<void> {
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

/** A Bun whose main thread exits through `pthread_exit` while the runtime's other threads run on. */
const MAIN_THREAD_EXITS = `import { dlopen, FFIType } from "bun:ffi";
dlopen("libc.so.6", { pthread_exit: { args: [FFIType.ptr], returns: FFIType.void } }).symbols.pthread_exit(null);`;

const captures = {
  // This process reading its own entry on its main thread, which shows running
  // while it reads. A read on Bun's thread pool would show the main thread
  // asleep, waiting for it.
  "running.stat": async () => readFileSync("/proc/self/stat", "utf8"),
  "sleeping.stat": async () => {
    await using sleeper = spawned(["sleep", "60"]);
    return await once(sleeper.pid, "S");
  },
  "stopped.stat": async () => {
    await using sleeper = spawned(["sleep", "60"]);
    process.kill(sleeper.pid, "SIGSTOP");
    return await once(sleeper.pid, "T");
  },
  "zombie.stat": async () => {
    await using zombie = await orphaned(["sleep", "0"]);
    return await dead(zombie.pid);
  },
  // `setsid` execs in place here, since the background child of a shell
  // without job control leads no group, so the zombie leads one of its own,
  // which is what a dev server's leader is.
  "zombie-group-leader.stat": async () => {
    await using zombie = await orphaned(["setsid", "sleep", "0"]);
    return await dead(zombie.pid);
  },
  // A Bun runs several threads, all of which have exited by the time it is a zombie.
  "zombie-multithreaded.stat": async () => {
    await using zombie = await orphaned([process.execPath, "-e", ""]);
    return await dead(zombie.pid);
  },
  "main-thread-exited.stat": async () => {
    await using half = spawned([process.execPath, "-e", MAIN_THREAD_EXITS]);
    const raw = await once(half.pid, "Z");
    // Its threads as the kernel lists them, which is not the stat line being captured.
    if ((await readdir(`/proc/${half.pid}/task`)).length < 2) {
      throw new Error(`process ${half.pid} has no thread left running, so it is a zombie`);
    }
    return raw;
  },
};

await mkdir(HERE, { recursive: true });
for (const [name, capture] of Object.entries(captures)) {
  await writeFile(join(HERE, name), await capture());
}
