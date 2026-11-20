/**
 * This suite's own reading of `/proc/<pid>/stat`, apart from `file-lock.ts`,
 * whose reading of the same line is what `file-lock.test.ts` and
 * `dev-server.test.ts` grade: the state letter, field 3, the process group,
 * field 5, and the number of threads, field 20.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface Fields {
  readonly state: string;
  readonly group: number;
  readonly threads: number;
}

/** What `/proc` says of a process, or nothing when it is not there. */
export function procFields(pid: number): Fields | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // Not there, or reaped between the open and the read.
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return null;
    }
    throw error;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] ?? "", group: Number(fields[2]), threads: Number(fields[17]) };
}

/** Whether every thread of a listed process has exited: a zombie, or one being released. */
export function exited(fields: Fields): boolean {
  return (fields.state === "Z" || fields.state === "X") && fields.threads <= 1;
}

/** Every process of a group that still runs. */
export function runningIn(group: number): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      const fields = procFields(pid);
      return fields !== null && fields.group === group && !exited(fields);
    });
}

/** Waits until a process is in `state`, which the kernel gets it to on its own time. */
export async function reaches(pid: number, state: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (procFields(pid)?.state === state) return;
    await Bun.sleep(25);
  }
  throw new Error(`process ${pid} never reached state ${state}`);
}
