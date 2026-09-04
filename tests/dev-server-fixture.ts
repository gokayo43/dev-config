/**
 * A real git repository, real linked worktrees and real detached processes for
 * the dev-server suite. Nothing here is stubbed: the subject IS process
 * lifecycle, so a fake spawn would grade nothing that can go wrong.
 *
 * That is also why this suite spends real time rather than driving a clock. It
 * spends as little as it can: every case sets `DEV_SERVER_READY_TIMEOUT_MS`,
 * which is the one wait long enough to matter, and the case about a server that
 * never answers sets it to two seconds.
 *
 * The fixture root is derived rather than made fresh, for `tests/tree.ts`'s
 * reason one step further on: what a killed run leaks here is a detached server
 * process holding a port, and the port comes from the package name — so two
 * checkouts under review get different names and different ports, while two
 * runs of one checkout get the same ones and reclaim them.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Server } from "../dev-server.ts";

/** The CLI under test, reached the way a consuming repo reaches it. */
const CLI = join(dirname(import.meta.dir), "dev-server.ts");

const CHECKOUT = dirname(import.meta.dir);
const DIGEST = new Bun.CryptoHasher("sha256").update(CHECKOUT).digest("hex").slice(0, 12);
const FIXTURES = join(tmpdir(), `dev-server-fixtures-${DIGEST}`);

/** The fixture's position in the run, which is the half of its name that varies. */
let made = 0;

/** A `dev` script that binds what it was told to bind, which is the whole contract. */
export const SERVES = `const port = Number(process.env["PORT"]);
const hostname = process.env["HOST"];
console.log("fixture serving on " + hostname + ":" + port);
Bun.serve({ port, hostname, fetch: () => new Response("ok") });
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
  /** The record for a branch, or null when there is none. */
  record(branch: string): Promise<Server | null>;
}

/**
 * A record as this suite reads one, narrowed here rather than through the CLI's
 * own decoder: a case that used the writer's reader to grade the writer would
 * agree with it about a field neither of them has.
 */
function read(value: unknown): Server {
  if (
    typeof value !== "object" ||
    value === null ||
    !("worktree" in value && typeof value.worktree === "string") ||
    !("branch" in value && typeof value.branch === "string") ||
    !("packageName" in value && typeof value.packageName === "string") ||
    !("port" in value && typeof value.port === "number") ||
    !("pid" in value && typeof value.pid === "number") ||
    !("log" in value && typeof value.log === "string") ||
    !("startedAt" in value && typeof value.startedAt === "string")
  ) {
    throw new Error(`not a dev-server record: ${JSON.stringify(value)}`);
  }
  return {
    worktree: value.worktree,
    branch: value.branch,
    packageName: value.packageName,
    port: value.port,
    pid: value.pid,
    log: value.log,
    startedAt: value.startedAt,
  };
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
 * The bin shim bun writes when a package declaring `bin` is installed, written
 * by hand because installing this package into a fixture would resolve its whole
 * dependency tree. What it proves is the invocation — `bun run dev-server` finds
 * a binary of that name in the worktree it is run from; `dev-server.test.ts`
 * holds the manifest that earns the name separately.
 */
async function shim(worktree: string): Promise<void> {
  const path = join(worktree, "node_modules", ".bin", "dev-server");
  await Bun.write(path, `#!/bin/sh\nexec ${process.execPath} ${CLI} "$@"\n`);
  await chmod(path, 0o755);
}

/** Whatever is still running when a case ends, whether or not the case knew about it. */
function slay(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
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

  async function remember(): Promise<void> {
    if (!existsSync(state)) return;
    for (const entry of await readdir(state)) {
      if (!entry.endsWith(".json")) continue;
      seen.add(read(await Bun.file(join(state, entry)).json()).pid);
    }
  }

  return {
    root,
    state,
    async worktree(branch: string): Promise<string> {
      const path = join(home, `wt-${branch}`);
      await git(root, ["worktree", "add", "--quiet", "-b", branch, path]);
      await shim(path);
      return path;
    },
    async devServer(cwd: string, ...args: readonly string[]): Promise<Run> {
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
      await remember();
      return { code, stdout, stderr };
    },
    async record(branch: string): Promise<Server | null> {
      const path = join(state, `${branch.replaceAll(/[^a-z0-9]+/g, "_")}.json`);
      const file = Bun.file(path);
      return (await file.exists()) ? read(await file.json()) : null;
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

/** Whether a process is there at all — the question `status` answers in its own column. */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
export async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}
