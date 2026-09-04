/**
 * A real git repository, real linked worktrees and real detached processes for
 * the dev-server suite. Nothing here is stubbed: the subject IS process
 * lifecycle, so a fake spawn would grade nothing that can go wrong.
 *
 * That is also why this suite spends real time rather than driving a clock. It
 * spends as little as it can: every case sets `DEV_SERVER_READY_TIMEOUT_MS`,
 * which is the one wait long enough to matter, and the cases about a server that
 * never answers set it to two seconds.
 *
 * The fixture root is derived rather than made fresh, for `tests/tree.ts`'s
 * reason one step further on: what a killed run leaks here is a detached server
 * process holding a port, and the port comes from the package name — so two
 * checkouts under review get different names and different ports, while two runs
 * of one checkout get the same ones and reclaim them.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isServer, recordStem, type Server } from "../dev-server-derive.ts";

/** The CLI under test, reached the way a consuming repo reaches it. */
const CLI = join(dirname(import.meta.dir), "dev-server.ts");

const CHECKOUT = dirname(import.meta.dir);
const DIGEST = new Bun.CryptoHasher("sha256").update(CHECKOUT).digest("hex").slice(0, 12);
const FIXTURES = join(tmpdir(), `dev-server-fixtures-${DIGEST}`);

/** The fixture's position in the run, which is the half of its name that varies. */
let made = 0;

/**
 * A `dev` script that binds what it was told to bind, and echoes every name the
 * CLI promises to hand it — so dropping one from the spawn fails a case rather
 * than nothing.
 */
export const SERVES = `const port = Number(process.env["PORT"]);
const hostname = process.env["HOST"];
console.log("fixture PORT=" + process.env["PORT"]);
console.log("fixture DEV_PORT=" + process.env["DEV_PORT"]);
console.log("fixture HOST=" + process.env["HOST"]);
console.log("fixture SITE_URL=" + process.env["SITE_URL"]);
console.log("fixture serving on " + hostname + ":" + port);
Bun.serve({ port, hostname, fetch: () => new Response("ok") });
`;

/** A `dev` script that ignores `$HOST` and binds every interface, which is what `up` must catch. */
export const SERVES_EVERYWHERE = `const port = Number(process.env["PORT"]);
console.log("fixture binding 0.0.0.0:" + port);
Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("ok") });
`;

/** A `dev` script that fails on its first line, which is what a broken config looks like. */
export const EXITS_AT_ONCE = `console.error("boom: the dev script could not start");
process.exit(3);
`;

/** A `dev` script that starts, says so, and never listens. */
export const NEVER_BINDS = `console.log("started, binding nothing");
await Bun.sleep(60000);
`;

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Scratch extends AsyncDisposable {
  /** The primary checkout. */
  readonly root: string;
  /** Where the records are, so a case can read one or check that it is gone. */
  readonly state: string;
  /** A linked worktree on a branch of its own, ready to run the CLI. */
  worktree(branch: string): Promise<string>;
  /** `bun run dev-server <args>` in a worktree, exactly as a person would type it. */
  devServer(cwd: string, ...args: readonly string[]): Promise<Run>;
  /** Two of them at once, started as close together as this can arrange. */
  devServerRace(cwd: string, ...args: readonly string[]): Promise<[Run, Run]>;
  /** Where a branch's record, log and lock live, derived the way the CLI derives them. */
  paths(branch: string): { readonly record: string; readonly log: string; readonly lock: string };
  /** The record for a branch. Refuses to invent one: an absent record is a failing case, not a zero. */
  record(branch: string): Promise<Server>;
  /** The record for a branch, or null — for the cases whose whole claim is that there is none. */
  recordOrNull(branch: string): Promise<Server | null>;
  /** Puts exactly these bytes where a branch's record goes, for the cases about a record nothing wrote. */
  putRecord(branch: string, contents: string): Promise<void>;
  /** The same, for the lock one `up` holds against another. */
  putLock(branch: string, contents: string): Promise<void>;
}

/**
 * A record, refusing anything that is not one. The shipped decoder does the
 * narrowing rather than a copy of it: what it accepts is itself under test — a
 * case plants a record with pid 0, pid 1 and an impossible port and requires
 * each to be reported as junk — and every field the writer puts in is asserted
 * by value in the record-shape case, so neither half is graded by itself.
 */
function read(value: unknown): Server {
  if (!isServer(value)) throw new Error(`not a dev-server record: ${JSON.stringify(value)}`);
  return value;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

/**
 * The bin shim bun writes when a package declaring `bin` is installed, written by
 * hand because installing this package into a fixture would resolve its whole
 * dependency tree. What it proves is the invocation — `bun run dev-server` finds
 * a binary of that name in the worktree it is run from; `dev-server.test.ts`
 * holds the manifest that earns the name separately.
 */
async function shim(worktree: string): Promise<void> {
  const path = join(worktree, "node_modules", ".bin", "dev-server");
  await Bun.write(path, `#!/bin/sh\nexec ${process.execPath} ${CLI} "$@"\n`);
  await chmod(path, 0o755);
}

/**
 * A pid this fixture may signal. `0` is the caller's own process group and `1`
 * is everything it may signal at all, so a case reading a pid out of a record
 * that is not there would otherwise SIGKILL the test runner — which is what the
 * `?? 0` these guards replaced actually did.
 */
function signalable(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

function real(pid: number): number {
  if (signalable(pid)) return pid;
  throw new Error(
    `${String(pid)} is not a pid this fixture will signal — 0 is my own group and 1 is everything`,
  );
}

function slay(pid: number): void {
  // Checked outside the catch, or the guard is swallowed by the same `catch`
  // that tolerates a process being gone — which is the guard not existing.
  const target = real(pid);
  try {
    process.kill(-target, "SIGKILL");
  } catch {
    // Already gone, which is what every well-behaved case leaves behind.
  }
}

export async function scratchRepo(dev: string, ready = 20_000): Promise<Scratch> {
  const home = join(FIXTURES, `${made}`);
  const name = `dev-server-fixture-${DIGEST}-${made++}`;
  // Whatever a killed run left at this exact path, rather than a sweep of the
  // directory: a sweep is how two runs sharing a machine delete each other's work.
  await rm(home, { recursive: true, force: true });
  const root = join(home, "repo");
  await mkdir(root, { recursive: true });
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", scripts: { dev: "bun dev.ts" } }, null, 2)}\n`,
  );
  await Bun.write(join(root, "dev.ts"), dev);
  await Bun.write(join(root, ".gitignore"), "node_modules/\n");
  await shim(root);
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "--quiet", "--message", "fixture"]);

  const seen = new Set<number>();
  const state = join(root, ".git", "dev-server");
  const worktrees = new Map<string, string>([["main", root]]);

  function paths(branch: string): { record: string; log: string; lock: string } {
    const path = worktrees.get(branch);
    if (path === undefined) throw new Error(`this fixture has no worktree on ${branch}`);
    const stem = recordStem(path, branch);
    return {
      record: join(state, `${stem}.json`),
      log: join(state, `${stem}.log`),
      lock: join(state, `${stem}.lock`),
    };
  }

  async function remember(): Promise<void> {
    if (!existsSync(state)) return;
    for (const entry of await readdir(state)) {
      if (!entry.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(state, entry), "utf8"));
      } catch {
        // A case that planted an unreadable record on purpose; there is no pid
        // in it to remember, and disposal has nothing to do about it.
        continue;
      }
      // The same rule the guards below apply, and not a looser one: a case that
      // plants an impossible pid on purpose would otherwise have it handed
      // straight back to `kill` by this suite's own disposal.
      if (typeof parsed === "object" && parsed !== null && "pid" in parsed) {
        if (signalable(parsed.pid)) seen.add(parsed.pid);
      }
    }
  }

  async function invoke(cwd: string, args: readonly string[]): Promise<Run> {
    const proc = Bun.spawn([process.execPath, "run", "dev-server", ...args], {
      cwd,
      env: { ...process.env, DEV_SERVER_READY_TIMEOUT_MS: String(ready) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  return {
    root,
    state,
    paths,
    async worktree(branch: string): Promise<string> {
      // Numbered, because the point of several of these cases is two branches
      // whose readable form is the same one.
      const path = join(home, `wt-${worktrees.size}-${branch.replaceAll(/[^A-Za-z0-9]+/g, "-")}`);
      await git(root, ["worktree", "add", "--quiet", "-b", branch, path]);
      await shim(path);
      worktrees.set(branch, path);
      return path;
    },
    async devServer(cwd: string, ...args: readonly string[]): Promise<Run> {
      const run = await invoke(cwd, args);
      await remember();
      return run;
    },
    async devServerRace(cwd: string, ...args: readonly string[]): Promise<[Run, Run]> {
      const both = await Promise.all([invoke(cwd, args), invoke(cwd, args)]);
      await remember();
      return both;
    },
    async record(branch: string): Promise<Server> {
      const { record } = paths(branch);
      if (!existsSync(record)) throw new Error(`no record at ${record}`);
      return read(JSON.parse(await readFile(record, "utf8")));
    },
    async recordOrNull(branch: string): Promise<Server | null> {
      const { record } = paths(branch);
      return existsSync(record) ? read(JSON.parse(await readFile(record, "utf8"))) : null;
    },
    async putRecord(branch: string, contents: string): Promise<void> {
      await mkdir(state, { recursive: true });
      await Bun.write(paths(branch).record, contents);
    },
    async putLock(branch: string, contents: string): Promise<void> {
      await mkdir(state, { recursive: true });
      await Bun.write(paths(branch).lock, contents);
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await remember();
      for (const pid of seen) slay(pid);
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A listener this suite owns on a port the CLI is about to claim, which is what "foreign" means here. */
export function occupy(port: number): Disposable {
  const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  return {
    [Symbol.dispose](): void {
      server.stop(true);
    },
  };
}

/** A process group of this suite's own, for the cases about signalling one that is not the CLI's. */
export async function bystander(): Promise<{ readonly pid: number } & Disposable> {
  const proc = Bun.spawn(["setsid", "sleep", "60"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  // `setsid` execs in place, but not before it has run: a case that signalled
  // `-pid` in that gap reached nothing, the process lived on, and the case
  // failed on whichever assertion came next.
  const led = await settles(async () => await leadsItsGroup(proc.pid));
  if (!led) throw new Error(`${proc.pid} never became the leader of its own process group`);
  return {
    pid: proc.pid,
    [Symbol.dispose](): void {
      slay(proc.pid);
    },
  };
}

async function leadsItsGroup(pid: number): Promise<boolean> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[2]) === pid;
  } catch {
    // Gone already, which is not a group leader either.
    return false;
  }
}

/**
 * What a file has to say about a process for this tool to act on it: which boot,
 * and which tick within it. Read the same way the CLI reads it, because a case
 * that planted a different spelling would be grading its own arithmetic.
 */
export async function holderOf(
  pid: number,
): Promise<{ pid: number; bootId: string; startTicks: number }> {
  const raw = await readFile(`/proc/${real(pid)}/stat`, "utf8");
  const startTicks = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]);
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  return { pid, bootId, startTicks };
}

/** Waits for something to exist, and hands it over — for the cases that need it while the command still runs. */
export async function settled<T>(appears: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = await appears();
    if (found !== null) return found;
    await Bun.sleep(25);
  }
  throw new Error("nothing appeared");
}

/** Whether something is STILL not so after a while, which is the shape of "nothing has happened". */
export async function stays(
  unchanged: () => boolean | Promise<boolean>,
  ms = 1500,
): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!(await unchanged())) return false;
    await Bun.sleep(50);
  }
  return await unchanged();
}

/** Whether a process is there at all — the question `status` answers in its own column. */
export function running(pid: number): boolean {
  const target = real(pid);
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a server without telling the CLI, which is what a `pkill` or a reboot does to one. */
export function killBehindItsBack(pid: number): void {
  slay(pid);
}

/** Waits for a condition the operating system reaches on its own time — a process dying, a port closing. */
export async function settles(reached: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await reached()) return true;
    await Bun.sleep(50);
  }
  return await reached();
}

/** Whether anything answers on a port, which is the only definition of "up" this suite uses. */
export async function answers(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}
