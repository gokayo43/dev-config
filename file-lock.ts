/**
 * Which process a file names, and the lock built on that answer: one holder at
 * a time for a path, across processes on one Linux machine.
 *
 * The lock is a file linked into place. A holder is written whole to a file of
 * the waiter's own and then linked at the lock's path, so the lock is never seen
 * half written: `open` with O_EXCL would make the file exist before its
 * contents do, and a waiter reading it in that gap finds nobody, judges the lock
 * abandoned and takes it, which is no lock at all, measured.
 *
 * A lock whose holder is gone is taken over, so a process killed while holding
 * it costs the next one nothing; `takeOver` says how two waiters that judged
 * the same holder gone are kept from both taking it.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Which process a file names, beyond its number. A pid alone names a different
 * process after a reboot and, given time, on the same one — and `dev-server`
 * signals process GROUPS, so being wrong costs somebody else's processes rather
 * than an error. The boot id says which boot the number was taken on, and the
 * start tick (`/proc/<pid>/stat` field 22) says when within it, which together
 * no recycled pid reproduces.
 *
 * A dev server's record carries one, and so does every lock taken here, so one
 * guard reads them and one question is asked of them.
 */
export interface Holder {
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: number;
}

/** A pid this package may signal: a real process, never `0` (its own group) or `1` (everything). */
function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

/** A tick count `/proc` could have reported. */
function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The three fields that say which process, in a record or in a lock. */
export function isHolder(value: unknown): value is Holder {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    isPid(value.pid) &&
    "bootId" in value &&
    typeof value.bootId === "string" &&
    value.bootId !== "" &&
    "startTicks" in value &&
    isTick(value.startTicks)
  );
}

/** This machine's boot. Every pid a holder names belongs to exactly one of these. */
export async function bootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

/**
 * What `/proc` says about a running process, or nothing when it is not there.
 *
 * Read from after the LAST `)`, because field 2 is the executable name, is not
 * escaped, and may contain both spaces and parentheses. What is wanted after
 * that is field 5, the process group, and field 22, the tick this process
 * started on.
 */
export async function procStat(
  pid: number,
): Promise<{ startTicks: number; leadsItsGroup: boolean } | null> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // No such process is the answer being asked for; any other failure to read
    // says nothing about whether it is alive.
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const group = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (!Number.isInteger(group) || !Number.isInteger(startTicks)) {
    throw new Error(
      `/proc/${pid}/stat is not the shape this reads — fields 5 and 22 are not numbers`,
    );
  }
  return { startTicks, leadsItsGroup: group === pid };
}

/**
 * Whether a holder is still the process that wrote it down, or nothing.
 *
 * Answers with what `/proc` said rather than a boolean, because the one caller
 * that goes on to signal has a second question to ask of it and no reason to
 * read the same file twice.
 */
export async function ours(who: Holder, boot: string): Promise<{ leadsItsGroup: boolean } | null> {
  if (who.bootId !== boot) return null;
  const stat = await procStat(who.pid);
  return stat !== null && stat.startTicks === who.startTicks ? stat : null;
}

const POLL_MS = 25;

/**
 * The file operation a waiter is about to perform. `lock` hands each one to
 * `between` before performing it, which is the seam a race probe holds a waiter
 * at: `read` comes after a failed link, `take` after judging the holder gone.
 */
export type Step = "link" | "read" | "wait" | "take" | "recheck" | "move" | "confirm" | "release";

export type Between = (next: Step, path: string) => Promise<void>;

/** How a claim's file name ends, which is how the sweep tells one from the files it may remove. */
const CLAIM = ".claim";

async function paced(next: Step): Promise<void> {
  if (next === "wait") await sleep(POLL_MS);
}

interface Me {
  readonly text: string;
  readonly boot: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** A file's text, or nothing when it is not there. */
async function textAt(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function liveHolder(text: string, boot: string): Promise<Holder | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not a holder: nobody this lock names can ever release it.
    return undefined;
  }
  return isHolder(parsed) && (await ours(parsed, boot)) !== null ? parsed : undefined;
}

/** A name beside `path` that no other waiter, in this process or another, will pick. */
function own(path: string): string {
  return `${path}.${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** Whether `from` was linked at `to`; `false` when `to` already exists. */
async function linked(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

/** Whether `from` was renamed to `to`; `false` when `from` is gone. */
async function renamed(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Moves aside the lock at `path` if it still holds `dead`, the text of a holder
 * judged gone. Only one waiter at a time does this for a given dead holder: the
 * one holding the claim named after its text, a lock taken the same way. So
 * the lock cannot have been taken over and taken again by somebody alive
 * between the recheck and the move, and a waiter whose judgement is stale finds
 * that at the recheck and moves nothing.
 */
async function takeOver(
  path: string,
  dead: string,
  patienceMs: number,
  between: Between,
  me: Me,
): Promise<void> {
  const claim = `${path}.${createHash("sha256").update(dead).digest("hex").slice(0, 16)}${CLAIM}`;
  await using held = await acquire(claim, patienceMs, between, me);
  void held;
  await between("recheck", path);
  if ((await textAt(path)) !== dead) return;
  const aside = `${own(path)}.moved`;
  await between("move", path);
  if (!(await renamed(path, aside))) return;
  await between("confirm", path);
  const moved = await textAt(aside);
  // Gone already means the next holder swept it as a dead holder's file.
  if (moved === undefined || moved === dead) {
    await rm(aside, { force: true });
    return;
  }
  // Somebody replaced the lock by hand between the recheck and the move, and
  // what was moved is a holder's: it goes back where it was.
  try {
    if (!(await linked(aside, path))) {
      throw new Error(
        `${path} was replaced by hand while a dead holder's lock was being taken over, and a second process took it before the first could be put back, so two processes may each believe they hold it. Stop the runs that use it and remove ${path}.`,
      );
    }
  } finally {
    await rm(aside, { force: true });
  }
}

async function acquire(
  path: string,
  patienceMs: number,
  between: Between,
  me: Me,
): Promise<AsyncDisposable> {
  const mine = own(path);
  await writeFile(mine, me.text, { flag: "wx", mode: 0o600 });
  try {
    for (let waited = 0; ;) {
      await between("link", path);
      if (await linked(mine, path)) {
        return {
          async [Symbol.asyncDispose](): Promise<void> {
            await between("release", path);
            await rm(path, { force: true });
          },
        };
      }
      await between("read", path);
      const found = await textAt(path);
      if (found === undefined) continue;
      const holder = await liveHolder(found, me.boot);
      if (holder === undefined) {
        await between("take", path);
        await takeOver(path, found, patienceMs, between, me);
        continue;
      }
      if (waited >= patienceMs) {
        throw new Error(
          `${path} has been held for ${patienceMs}ms by process ${holder.pid}, which is still running: wait for it, or remove ${path} if that process is not using it.`,
        );
      }
      await between("wait", path);
      waited += POLL_MS;
    }
  } finally {
    await rm(mine, { force: true });
  }
}

/**
 * Clears every file beside the lock that names a process that is gone: the file
 * a waiter killed while waiting wrote its holder to, and a dead holder's lock
 * moved aside by a waiter killed before discarding it, are removed, since only
 * the process that wrote either ever touches it. A claim its taker died holding
 * is taken over through `takeOver` like any dead lock and never removed by
 * name, because another waiter may be taking it over at the same moment.
 */
async function sweep(path: string, patienceMs: number, between: Between, me: Me): Promise<void> {
  const prefix = `${basename(path)}.`;
  const beside = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix));
  for (const name of beside) {
    const file = join(dirname(path), name);
    const text = await textAt(file);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not a file this lock wrote, so not one it may remove.
      continue;
    }
    if (!isHolder(parsed) || (await ours(parsed, me.boot)) !== null) continue;
    if (name.endsWith(CLAIM)) await takeOver(file, text, patienceMs, between, me);
    else await rm(file, { force: true });
  }
}

/**
 * Takes the lock at `path`, waiting up to `patienceMs` for a live holder, and
 * releases it when disposed. Linux only: a holder is proven alive from `/proc`.
 *
 * `between` defaults to sleeping before each look at a live holder's lock; a
 * test passes its own to decide when each step runs.
 */
export async function lock(
  path: string,
  patienceMs: number,
  between: Between = paced,
): Promise<AsyncDisposable> {
  const stat = await procStat(process.pid);
  if (stat === null) throw new Error(`/proc/${process.pid} is not readable — this needs Linux`);
  const boot = await bootId();
  const text = `${JSON.stringify({ pid: process.pid, bootId: boot, startTicks: stat.startTicks })}\n`;
  const me = { text, boot };
  const held = await acquire(path, patienceMs, between, me);
  try {
    await sweep(path, patienceMs, between, me);
  } catch (error) {
    await held[Symbol.asyncDispose]();
    throw error;
  }
  return held;
}
