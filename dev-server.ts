#!/usr/bin/env bun
// oxlint-disable no-console -- stdout is this CLI's interface: the URL a caller reads, the table it prints, the log lines it tails
/**
 * One supervised dev server per git worktree, on a port the worktree derives.
 *
 * ```sh
 * bun run dev-server up      # start it if it is not up, wait until it answers, print its URL
 * bun run dev-server down    # stop it, and say so; exit 0 whether or not one was running
 * bun run dev-server status  # every server this repo has, and whether it is alive and answering
 * bun run dev-server url     # this worktree's URL, or exit 1 if no server is up
 * bun run dev-server logs    # the tail of this worktree's log; `-f` follows it
 * bun run dev-server sweep   # stop and forget the servers of worktrees that are gone
 * ```
 *
 * The whole contract with the consuming repo is its `dev` script: it must bind
 * `$PORT` on `$HOST`. This hands it `PORT`, `DEV_PORT`, `HOST=127.0.0.1` and
 * `SITE_URL`, and reads nothing back out of it — a `.env` is the repo's own
 * business.
 *
 * Everything is derived from the worktree, so two of them serve at once without
 * having agreed on anything, and one of them comes back to the same port across
 * restarts. Nothing here is a daemon: `up` spawns a child into a session of its
 * own and exits, and the record it leaves under `.git` is how the next command
 * finds it.
 *
 * Stdout is the answer — a URL, a table, log lines — and everything a person
 * reads rather than pipes goes to stderr, so `open "$(bun run dev-server url)"`
 * is a thing that works.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Where derived dev ports live: above the ephemeral range Linux hands out, below 65535. */
const PORT_FLOOR = 20_000;
const PORT_CEILING = 60_000;

/** Ports one worktree may claim, all inside one block, so two branches cannot drift into each other. */
export const PORTS_PER_WORKTREE = 10;

/** The only interface a server here is ever bound to. A dev server is not a thing to publish on a LAN. */
const LOOPBACK = "127.0.0.1";

/** How long `up` waits for the first HTTP response before giving up, and the variable that shortens it. */
const READY_TIMEOUT_MS = 120_000;
const READY_TIMEOUT = "DEV_SERVER_READY_TIMEOUT_MS";

/** How long `down` gives SIGTERM before it stops asking. */
const STOP_TIMEOUT_MS = 10_000;

/** How often the readiness and shutdown loops look again, and how long one HTTP probe may take. */
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 2_000;

/** How much log a person is shown: after a readiness timeout, and by `logs`. */
const TIMEOUT_LINES = 40;
const TAIL_LINES = 200;

/**
 * A branch name reduced to what a filename and a human can both carry:
 * lowercase, `_` for anything else, no leading digit, no repeated or trailing
 * separators. `feat/Add-Thing` and `feat/add_thing` collapse together, and that
 * is the right trade — git already refuses two worktrees on one branch, so the
 * only pair this can confuse is one that differs by punctuation alone.
 */
export function worktreeSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return slug === "" || /^[0-9]/.test(slug) ? `w_${slug}` : slug;
}

/**
 * Where this worktree's ports live. Deterministic, so a worktree comes back to
 * the same block across restarts, and spread out, so two branches rarely start
 * in the same place — the probe below decides which port inside the block is used.
 *
 * The package name is in the hash and not merely beside it: two repos on one
 * machine both have a `main`, and hashing the branch alone puts their two dev
 * servers in one block, where the second one silently lands on the first one's
 * neighbouring port.
 */
export function basePort(packageName: string, branch: string): number {
  const span = (PORT_CEILING - PORT_FLOOR) / PORTS_PER_WORKTREE;
  const key = `${worktreeSlug(packageName)}/${worktreeSlug(branch)}`;
  return PORT_FLOOR + (hash(key) % span) * PORTS_PER_WORKTREE;
}

/** Whether a port belongs to the block a worktree's name picks. */
export function inBlock(base: number, port: number): boolean {
  return port >= base && port < base + PORTS_PER_WORKTREE;
}

/**
 * The first free port in this worktree's block. Deriving a port is a guess about
 * a machine's state, so the guess is checked — and the search always starts at
 * the block rather than one past whatever was last used, which would walk into
 * the block another branch is deterministically about to claim.
 */
export async function freePort(
  base: number,
  free: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let port = base; port < base + PORTS_PER_WORKTREE; port++) {
    if (await free(port)) return port;
  }
  throw new Error(
    `no free port left in ${base}-${base + PORTS_PER_WORKTREE - 1}, this worktree's block — stop whatever is holding them, or run \`dev-server sweep\``,
  );
}

/** FNV-1a: short, stable across runs, and not a security claim — it names things. */
function hash(text: string): number {
  let value = 2_166_136_261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  return value;
}

/** What `up` wrote down, and what every other command reads to find the process again. */
export interface Server {
  readonly worktree: string;
  readonly branch: string;
  readonly packageName: string;
  readonly port: number;
  readonly pid: number;
  readonly log: string;
  readonly startedAt: string;
}

/** The repository as this invocation finds it: which worktree, which branch, and where the records are. */
interface Checkout {
  readonly worktree: string;
  readonly branch: string;
  readonly packageName: string;
  readonly state: string;
}

/**
 * Every field checked, because this file outlives the version that wrote it: a
 * record from an older shape reaches a `kill` if nobody looks.
 */
function isServer(value: unknown): value is Server {
  return (
    typeof value === "object" &&
    value !== null &&
    "worktree" in value &&
    typeof value.worktree === "string" &&
    "branch" in value &&
    typeof value.branch === "string" &&
    "packageName" in value &&
    typeof value.packageName === "string" &&
    "port" in value &&
    typeof value.port === "number" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "log" in value &&
    typeof value.log === "string" &&
    "startedAt" in value &&
    typeof value.startedAt === "string"
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
  return stdout.trim();
}

/**
 * The records live in the git common directory — one per repository, shared by
 * every worktree of it, never tracked, and still there when a worktree's own
 * directory is not, which is the state `sweep` is about. A directory beside the
 * checkout would be none of those things and would need a `.gitignore` line
 * from every consumer.
 */
async function checkout(cwd: string): Promise<Checkout> {
  const worktree = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  const state = join(isAbsolute(common) ? common : resolve(cwd, common), "dev-server");
  await mkdir(state, { recursive: true });
  return {
    worktree,
    // A detached HEAD is a worktree like any other, and its commit is the only
    // name it has: deriving from the word `HEAD` would put every detached
    // worktree of this repo on one port.
    branch: head === "HEAD" ? await git(cwd, ["rev-parse", "--short", "HEAD"]) : head,
    packageName: await declaredName(worktree),
    state,
  };
}

async function declaredName(worktree: string): Promise<string> {
  const path = join(worktree, "package.json");
  const parsed: unknown = await Bun.file(path).json();
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    throw new Error(`${path} declares no \`name\`, which is half of what a port is derived from`);
  }
  if (typeof parsed.name !== "string") throw new Error(`${path}'s \`name\` is not a string`);
  return parsed.name;
}

function recordPath(state: string, branch: string): string {
  return join(state, `${worktreeSlug(branch)}.json`);
}

function logPath(state: string, branch: string): string {
  return join(state, `${worktreeSlug(branch)}.log`);
}

function origin(port: number): string {
  return `http://${LOOPBACK}:${port}`;
}

async function decodeRecord(path: string): Promise<Server> {
  const parsed: unknown = await Bun.file(path).json();
  if (!isServer(parsed)) {
    throw new Error(
      `${path} is not a dev-server record — delete it and run \`dev-server up\` again`,
    );
  }
  return parsed;
}

async function readRecord(state: string, branch: string): Promise<Server | null> {
  const path = recordPath(state, branch);
  return (await Bun.file(path).exists()) ? await decodeRecord(path) : null;
}

async function writeRecord(state: string, server: Server): Promise<void> {
  await Bun.write(recordPath(state, server.branch), `${JSON.stringify(server, null, 2)}\n`);
}

/** Every server this repository has a record of, in a stable order so `status` reads the same twice. */
async function records(state: string): Promise<Server[]> {
  const names = (await readdir(state)).filter((name) => name.endsWith(".json")).toSorted();
  return await Promise.all(names.map(async (name) => await decodeRecord(join(state, name))));
}

async function isFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: LOOPBACK, port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    // Held by something on this box, which is the answer being asked for.
    return false;
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    // Any response at all is ready — a 404 or a 500 is a server that is up, and
    // a redirect is not followed because where it points is not this question.
    await fetch(origin(port), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signals the whole process group rather than the pid, because `bun run dev`
 * is a parent: signalling it alone leaves the server itself holding the port.
 * `setsid` at spawn is what makes the recorded pid that group's leader.
 */
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, which is the ordinary case for the second
    // signal and for `down` on a server that died on its own.
  }
}

async function stop(state: string, server: Server): Promise<void> {
  signalGroup(server.pid, "SIGTERM");
  for (let waited = 0; waited < STOP_TIMEOUT_MS && alive(server.pid); waited += POLL_MS) {
    await Bun.sleep(POLL_MS);
  }
  if (alive(server.pid)) signalGroup(server.pid, "SIGKILL");
  await rm(recordPath(state, server.branch), { force: true });
}

function readyTimeout(): number {
  const configured = (process.env[READY_TIMEOUT] ?? "").trim();
  if (configured === "") return READY_TIMEOUT_MS;
  const ms = Number(configured);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${READY_TIMEOUT} is \`${configured}\`, which is not a number of milliseconds`);
  }
  return ms;
}

function tail(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * Waits for the first HTTP response and prints the URL, or takes the server
 * down and says what its log said. A server that never answers is not one to
 * leave running: the next `up` would find a live pid and wait for it again.
 */
async function awaitReady(state: string, server: Server): Promise<void> {
  const deadline = Date.now() + readyTimeout();
  let exited = false;
  while (Date.now() < deadline && !exited) {
    if (await answers(server.port)) {
      console.log(origin(server.port));
      return;
    }
    exited = !alive(server.pid);
    if (!exited) await Bun.sleep(POLL_MS);
  }
  const log = await Bun.file(server.log).text();
  await stop(state, server);
  console.error(tail(log, TIMEOUT_LINES));
  throw new Error(
    exited
      ? `\`bun run dev\` in ${server.worktree} exited before it answered on port ${server.port} — its last ${TIMEOUT_LINES} log lines are above (${server.log})`
      : `\`bun run dev\` in ${server.worktree} did not answer on port ${server.port} within ${readyTimeout()}ms — its last ${TIMEOUT_LINES} log lines are above (${server.log})`,
  );
}

async function up(here: Checkout): Promise<void> {
  const existing = await readRecord(here.state, here.branch);
  if (existing !== null && alive(existing.pid)) {
    await awaitReady(here.state, existing);
    return;
  }
  const base = basePort(here.packageName, here.branch);
  const port =
    existing !== null && inBlock(base, existing.port)
      ? existing.port
      : await freePort(base, isFree);
  // A claimed port is refused rather than stepped over. Moving to the next one
  // would keep `up` working and quietly break the property the whole derivation
  // exists for — that a worktree's URL is the same one tomorrow.
  if (!(await isFree(port))) {
    throw new Error(
      `port ${port} is claimed by this worktree and something else is listening on it — stop that process (\`lsof -iTCP:${port} -sTCP:LISTEN\`), or run \`dev-server down\` here to give the claim up so the next \`up\` derives another`,
    );
  }
  const log = logPath(here.state, here.branch);
  const handle = await open(log, "w");
  // `setsid` puts the child in a session of its own, so it survives this process
  // and so one signal reaches it and everything `bun run dev` started. It execs
  // in place rather than forking, which is what makes the pid below the leader's.
  const child = Bun.spawn(["setsid", process.execPath, "run", "dev"], {
    cwd: here.worktree,
    env: {
      ...process.env,
      PORT: String(port),
      DEV_PORT: String(port),
      HOST: LOOPBACK,
      SITE_URL: origin(port),
    },
    stdin: "ignore",
    stdout: handle.fd,
    stderr: handle.fd,
  });
  child.unref();
  await handle.close();
  const server: Server = {
    worktree: here.worktree,
    branch: here.branch,
    packageName: here.packageName,
    port,
    pid: child.pid,
    log,
    startedAt: new Date().toISOString(),
  };
  // Written before readiness is awaited: a run killed mid-wait leaves a live
  // child, and the record is the only thing that could ever find it again.
  await writeRecord(here.state, server);
  await awaitReady(here.state, server);
}

async function down(here: Checkout): Promise<void> {
  const server = await readRecord(here.state, here.branch);
  if (server === null) {
    console.error(`no dev server recorded for ${here.branch}`);
    return;
  }
  await stop(here.state, server);
  console.error(`stopped ${here.branch} on port ${server.port}`);
}

async function status(here: Checkout): Promise<void> {
  const servers = await records(here.state);
  if (servers.length === 0) {
    console.error("no dev server has been started in this repository");
    return;
  }
  const rows = await Promise.all(
    servers.map(async (server) => [
      server.branch,
      String(server.port),
      String(server.pid),
      alive(server.pid) ? "alive" : "dead",
      (await answers(server.port)) ? "answering" : "silent",
      server.worktree,
    ]),
  );
  const table = [["branch", "port", "pid", "process", "http", "worktree"], ...rows];
  const widths = table[0]?.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? "").length)),
  );
  for (const row of table) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  }
}

async function url(here: Checkout): Promise<void> {
  const server = await readRecord(here.state, here.branch);
  if (server === null || !alive(server.pid) || !(await answers(server.port))) {
    console.error(`no dev server is up for ${here.branch} — \`dev-server up\` starts one`);
    process.exitCode = 1;
    return;
  }
  console.log(origin(server.port));
}

async function logs(here: Checkout, follow: boolean): Promise<void> {
  const log = logPath(here.state, here.branch);
  if (!(await Bun.file(log).exists())) {
    console.error(`no dev server has been started for ${here.branch}, so there is no log yet`);
    process.exitCode = 1;
    return;
  }
  if (!follow) {
    console.log(tail(await Bun.file(log).text(), TAIL_LINES));
    return;
  }
  const proc = Bun.spawn(["tail", "-n", String(TAIL_LINES), "-f", log], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

/**
 * The worktrees this repository still has. A directory that was deleted outright
 * is still listed by git — as prunable — so being listed is not enough to count
 * as live, and a record of one is exactly what `sweep` is looking for.
 */
async function liveWorktrees(cwd: string): Promise<Set<string>> {
  const marker = "worktree ";
  const listed = (await git(cwd, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith(marker))
    .map((line) => line.slice(marker.length));
  const live = new Set<string>();
  for (const path of listed) {
    if (existsSync(path)) live.add(await realpath(path));
  }
  return live;
}

async function sweep(here: Checkout): Promise<void> {
  const live = await liveWorktrees(here.worktree);
  const gone = (await records(here.state)).filter((server) => !live.has(server.worktree));
  for (const server of gone) {
    await stop(here.state, server);
    // The log goes too, and only here: `down` keeps it because someone is about
    // to read why the server stopped, while a worktree that is gone has nobody
    // left who can even ask — `logs` derives its path from a branch that no
    // longer has a checkout.
    await rm(server.log, { force: true });
    console.error(`stopped ${server.branch} on port ${server.port} — ${server.worktree} is gone`);
  }
  if (gone.length === 0)
    console.error("every recorded server belongs to a worktree that is still here");
}

/** How `logs` is told to follow. Everything else a command is handed is a typo, and says so. */
const FOLLOW = new Set(["-f", "--follow"]);

/** What every other command takes. */
const NOTHING: ReadonlySet<string> = new Set();

/**
 * A command that quietly ignores what it was handed is a `--folow` that scrolls
 * once and stops, and a person who concludes the tool is broken.
 */
function only(command: string, rest: readonly string[], accepted: ReadonlySet<string>): void {
  const unknown = rest.filter((argument) => !accepted.has(argument));
  if (unknown.length > 0) {
    throw new Error(`\`${command}\` does not take \`${unknown.join(" ")}\`\n\n${USAGE}`);
  }
}

const USAGE = `dev-server <up|down|status|url|logs|sweep>

  up      start this worktree's dev server if it is not up, and print its URL
  down    stop it
  status  every server this repository has, and whether it is alive and answering
  url     this worktree's URL, or exit 1 if no server is up
  logs    the tail of this worktree's log; -f follows it
  sweep   stop and forget the servers of worktrees that are gone`;

async function main(argv: readonly string[]): Promise<void> {
  const [command = "", ...rest] = argv;
  const here = await checkout(process.cwd());
  switch (command) {
    case "up": {
      only(command, rest, NOTHING);
      return await up(here);
    }
    case "down": {
      only(command, rest, NOTHING);
      return await down(here);
    }
    case "status": {
      only(command, rest, NOTHING);
      return await status(here);
    }
    case "url": {
      only(command, rest, NOTHING);
      return await url(here);
    }
    case "logs": {
      only(command, rest, FOLLOW);
      return await logs(here, rest.length > 0);
    }
    case "sweep": {
      only(command, rest, NOTHING);
      return await sweep(here);
    }
    default: {
      throw new Error(command === "" ? USAGE : `no such command \`${command}\`\n\n${USAGE}`);
    }
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
