#!/usr/bin/env bun
// oxlint-disable no-console -- stdout is this CLI's interface: the URL a caller reads, the table it prints, the log lines it tails
/**
 * One supervised dev server per git worktree, on a port the worktree derives.
 *
 * ```sh
 * bun run dev-server up      # start it if it is not up, wait until it answers, print its URL
 * bun run dev-server down    # stop it, and say so; exit 0 whether or not one was running
 * bun run dev-server status  # every server this repository has, and whether it is alive and answering
 * bun run dev-server url     # this worktree's URL, or exit 1 if no server is up
 * bun run dev-server logs    # the tail of this worktree's log; `-f` follows it
 * bun run dev-server sweep   # stop and forget the servers of worktrees that are gone
 * ```
 *
 * The whole contract with the consuming repo is its `dev` script: it must bind
 * `$PORT` on `$HOST`. This hands it `PORT`, `DEV_PORT`, `HOST=127.0.0.1` and
 * `SITE_URL`, and reads nothing back out of it — a `.env` is the repo's own
 * business. `HOST` is a request rather than a guarantee, so `up` asks the
 * machine afterwards: a server that also answers off loopback is stopped.
 *
 * **Linux only.** The child is put in a session of its own with util-linux
 * `setsid`, and the proof that a recorded pid is still the process this tool
 * started is read out of `/proc`. Neither exists on macOS, and nobody on this
 * fleet runs one.
 *
 * Nothing here is a daemon: `up` spawns a child into a session of its own and
 * exits, and the record it leaves under `.git` is how the next command finds it.
 * Stdout is the answer — a URL, a table, log lines — and everything a person
 * reads rather than pipes goes to stderr, so `open "$(bun run dev-server url)"`
 * is a thing that works.
 */
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  basePort,
  freePort,
  type Holder,
  type Identity,
  inBlock,
  isHolder,
  isServer,
  recordStem,
  type Server,
} from "./dev-server-derive.ts";

/** The only interface a server here is asked to bind, and the one `up` proves it kept to. */
const LOOPBACK = "127.0.0.1";

/** How long `up` waits for the first HTTP response before it gives up, and the variable that shortens it. */
const READY_TIMEOUT_MS = 120_000;
const READY_TIMEOUT = "DEV_SERVER_READY_TIMEOUT_MS";

/** How long `down` gives SIGTERM, and then SIGKILL, before it refuses to say the server is gone. */
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 2_000;

/** How long `up` waits for another `up` in this worktree to finish. */
const LOCK_TIMEOUT_MS = 30_000;

/** How often every waiting loop looks again, and how long one HTTP probe may take. */
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 2_000;

/** How much log a person is shown: after a readiness timeout, and by `logs`. */
const TIMEOUT_LINES = 40;
const TAIL_LINES = 200;

/** Nobody but the owner reads these: the log carries whatever the dev script printed, environment included. */
const STATE_MODE = 0o700;
const FILE_MODE = 0o600;

/** The repository as this invocation finds it, and nothing that costs more than every command needs. */
interface Checkout extends Identity {
  readonly state: string;
  readonly stem: string;
}

/** A file in the state directory: a record, or something that is not one. */
type Entry =
  | { readonly kind: "server"; readonly path: string; readonly server: Server }
  | { readonly kind: "junk"; readonly path: string; readonly why: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
  return stdout.trim();
}

/**
 * One git call, and nothing else: `status`, `down`, `url`, `logs` and `sweep`
 * need no package manifest and create no directory, so asking for either here
 * would make a repo whose manifest has no `name` unable to stop its own server.
 *
 * The records live in the git common directory — one per repository, shared by
 * every worktree of it, never tracked, and still there when a worktree's own
 * directory is not, which is the state `sweep` is about. A directory beside the
 * checkout would be none of those things and would need a `.gitignore` line from
 * every consumer.
 */
async function checkout(cwd: string): Promise<Checkout> {
  const [top = "", head = "", common = ""] = (
    await git(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"])
  ).split("\n");
  const detached = head === "HEAD";
  const worktree = await realpath(top);
  const branch = detached ? await git(cwd, ["rev-parse", "--short", "HEAD"]) : head;
  return {
    worktree,
    branch,
    detached,
    state: join(isAbsolute(common) ? common : resolve(cwd, common), "dev-server"),
    stem: recordStem(worktree, branch),
  };
}

async function declaredName(worktree: string): Promise<string> {
  const path = join(worktree, "package.json");
  if (!existsSync(path)) {
    throw new Error(
      `${path} is not there, and \`up\` derives this worktree's port from its \`name\``,
    );
  }
  const parsed: unknown = await Bun.file(path).json();
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    throw new Error(`${path} declares no \`name\`, which is half of what a port is derived from`);
  }
  if (typeof parsed.name !== "string") throw new Error(`${path}'s \`name\` is not a string`);
  return parsed.name;
}

function recordPath(state: string, stem: string): string {
  return join(state, `${stem}.json`);
}

function logPath(state: string, stem: string): string {
  return join(state, `${stem}.log`);
}

function origin(port: number): string {
  return `http://${LOOPBACK}:${port}`;
}

/** Reading a record never throws: one unreadable file used to take every command down with it. */
async function readEntry(path: string): Promise<Entry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { kind: "junk", path, why: error instanceof Error ? error.message : String(error) };
  }
  return isServer(parsed)
    ? { kind: "server", path, server: parsed }
    : { kind: "junk", path, why: "not the shape a dev-server record has" };
}

/** Every file in the state directory, in a stable order so `status` reads the same twice. */
async function entries(state: string): Promise<Entry[]> {
  if (!existsSync(state)) return [];
  const names = (await readdir(state)).filter((name) => name.endsWith(".json")).toSorted();
  return await Promise.all(names.map(async (name) => await readEntry(join(state, name))));
}

/**
 * The record this checkout owns, and the one choke point that decides what a
 * command may act on: an unreadable one is said out loud and treated as absent,
 * and one naming another worktree is refused outright. The stem carries a tag of
 * the worktree path, so a record here that names a different path is either a
 * tag collision or a checkout that moved — either way this is not its server to
 * start, stop or report.
 */
async function serverHere(here: Checkout): Promise<Server | null> {
  const path = recordPath(here.state, here.stem);
  if (!existsSync(path)) return null;
  const entry = await readEntry(path);
  if (entry.kind === "junk") {
    console.error(
      `${path} is not a dev-server record (${entry.why}) — it is being ignored; delete it, or let \`dev-server sweep\` collect it`,
    );
    return null;
  }
  if (entry.server.worktree !== here.worktree) {
    throw new Error(
      `${path} belongs to ${entry.server.worktree}, not to this checkout (${here.worktree}) — run \`dev-server sweep\` if that worktree is gone, and otherwise say so: two checkouts have landed on one record name`,
    );
  }
  return entry.server;
}

/** Written whole and moved into place: a reader never sees half of one. */
async function writeRecord(state: string, stem: string, server: Server): Promise<void> {
  const path = recordPath(state, stem);
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(server, null, 2)}\n`);
  await chmod(temporary, FILE_MODE);
  await rename(temporary, path);
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

async function answers(host: string, port: number): Promise<boolean> {
  try {
    // Any response at all is ready — a 404 or a 500 is a server that is up, and
    // a redirect is not followed because where it points is not this question.
    await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

/** This machine's boot. Every pid this tool wrote down belongs to exactly one of these. */
async function bootId(): Promise<string> {
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
async function procStat(
  pid: number,
): Promise<{ startTicks: number; leadsItsGroup: boolean } | null> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    // No such process, which is the answer being asked for.
    return null;
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
 * Whether a pid a file names is still the process that wrote the file down, or
 * nothing. A pid is reused, and a reboot recycles every one of them at once, so
 * a file carried across either names somebody else — which for a record is a
 * `kill` aimed at a stranger and for a lock is a worktree nobody can start.
 *
 * Answers with what `/proc` said rather than a boolean, because the one caller
 * that goes on to signal has a second question to ask of it and no reason to
 * read the same file twice.
 */
async function ours(who: Holder, boot: string): Promise<{ leadsItsGroup: boolean } | null> {
  if (who.bootId !== boot) return null;
  const stat = await procStat(who.pid);
  return stat !== null && stat.startTicks === who.startTicks ? stat : null;
}

async function stillOurs(who: Holder, boot: string): Promise<boolean> {
  return (await ours(who, boot)) !== null;
}

/**
 * Signals the whole process group rather than the pid, because `bun run dev` is
 * a parent: signalling it alone leaves the server itself holding the port.
 * `setsid` at spawn is what makes the recorded pid that group's leader, and
 * `stillOurs` above is what proves it still is before this is ever called.
 */
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group went away between the proof and the signal, which is the
    // ordinary case for a server that stopped on its own mid-`down`.
  }
}

/**
 * Stops a server and forgets it, or forgets a record whose process is not ours
 * any more. The record is removed only once the process is proven gone: it is
 * the only handle anything has on that pid, and dropping it while the server
 * runs is how a port stays held by something nothing can find.
 */
async function stop(
  state: string,
  stem: string,
  server: Server,
  boot: string,
): Promise<"stopped" | "gone"> {
  const alive = await ours(server, boot);
  if (alive === null) {
    await rm(recordPath(state, stem), { force: true });
    return "gone";
  }
  // Every server this tool starts is a session leader, because `setsid` made it
  // one. A pid that is alive and ours and yet leads no group is a contradiction
  // rather than a case, and the answer to it is not to signal a group somebody
  // else owns.
  if (!alive.leadsItsGroup) {
    throw new Error(
      `pid ${server.pid} does not lead its own process group, so it is not a server this tool started — refusing to signal it, and keeping ${recordPath(state, stem)}`,
    );
  }
  signalGroup(server.pid, "SIGTERM");
  await waitUntilGone(server, boot, STOP_TIMEOUT_MS);
  if (await stillOurs(server, boot)) {
    signalGroup(server.pid, "SIGKILL");
    await waitUntilGone(server, boot, KILL_TIMEOUT_MS);
  }
  if (await stillOurs(server, boot)) {
    throw new Error(
      `process group ${server.pid} is still running after SIGKILL — its record is being kept, because it is the only thing that names it`,
    );
  }
  await rm(recordPath(state, stem), { force: true });
  return "stopped";
}

async function waitUntilGone(server: Server, boot: string, budgetMs: number): Promise<void> {
  for (let waited = 0; waited < budgetMs && (await stillOurs(server, boot)); waited += POLL_MS) {
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Read before anything is spawned, so a value nobody can parse costs a message
 * rather than a running server nothing waited for.
 */
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
 * One `up` per worktree at a time, held across read-decide-spawn-write.
 *
 * That sequence is not atomic, and two `up`s racing it both bind: measured, five
 * concurrent pairs left four servers running that no record named, which nothing
 * can stop and which push every later `up` one port along — past the refusal
 * that is supposed to be the answer to a port that is taken.
 *
 * A lock whose holder is gone is taken: the same three questions `stillOurs`
 * asks of a server, asked of whoever wrote the lock, so a run killed mid-`up`
 * costs the next one nothing.
 */
async function lock(state: string, stem: string, boot: string): Promise<AsyncDisposable> {
  const path = join(state, `${stem}.lock`);
  const mine = await procStat(process.pid);
  if (mine === null) throw new Error(`/proc/${process.pid} is not readable — this needs Linux`);
  // Written whole, then LINKED into place. `open` with O_EXCL would make the
  // file exist before its contents do, and the loser reads it in that gap: an
  // empty lock parses as nobody, reads as stale, and gets stolen — which is no
  // lock at all, measured. `link` publishes a complete file or fails.
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(
    temporary,
    `${JSON.stringify({ pid: process.pid, bootId: boot, startTicks: mine.startTicks })}\n`,
  );
  await chmod(temporary, FILE_MODE);
  try {
    for (let waited = 0; waited <= LOCK_TIMEOUT_MS; waited += POLL_MS) {
      try {
        await link(temporary, path);
        return {
          async [Symbol.asyncDispose](): Promise<void> {
            await rm(path, { force: true });
          },
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (await isStale(path, boot)) {
        await rm(path, { force: true });
        continue;
      }
      await Bun.sleep(POLL_MS);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  throw new Error(
    `another \`dev-server up\` has been working in this worktree for ${LOCK_TIMEOUT_MS}ms (${path}) — wait for it, or delete that file if nothing is`,
  );
}

async function isStale(path: string, boot: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Gone between the failed create and this read, or never whole. Either way
    // nobody can prove a holder it does not name, and a lock nothing can release
    // is a worktree nobody can start again.
    return true;
  }
  return !isHolder(parsed) || !(await stillOurs(parsed, boot));
}

/**
 * `HOST=127.0.0.1` is a request a dev script may ignore, and a dev server on a
 * LAN is somebody else's code running on this machine's ports. So `up` asks the
 * machine rather than trusting the request: if the port answers on an address
 * that is not loopback, the child is stopped and the dev script is named.
 */
async function refuseOffLoopback(
  state: string,
  stem: string,
  server: Server,
  boot: string,
): Promise<void> {
  for (const address of elsewhere()) {
    if (!(await answers(address, server.port))) continue;
    await stop(state, stem, server, boot);
    throw new Error(
      `\`bun run dev\` in ${server.worktree} answered on ${address}:${server.port} as well as on ${LOOPBACK} — it is binding every interface instead of $HOST, and has been stopped`,
    );
  }
}

/**
 * The addresses a loopback-bound server must NOT answer on. `127.0.0.2` is the
 * one that always exists — Linux gives `lo` the whole `127.0.0.0/8`, so a server
 * on `0.0.0.0` answers there and one on `127.0.0.1` does not, on a machine with
 * no network at all. The real addresses are asked as well, for the dev script
 * that binds one of them by name rather than binding everything.
 */
function elsewhere(): string[] {
  const found = ["127.0.0.2"];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) found.push(address.address);
    }
  }
  return found;
}

/**
 * Waits for the first HTTP response and prints the URL, or takes the server down
 * and says what its log said.
 *
 * Readiness is this child answering, never merely something answering: the port
 * is asked only while the recorded process is proven to be ours, so an `up`
 * whose own child died of EADDRINUSE reports the failure rather than a sibling's
 * server. A server that never answers is not left running either — the next `up`
 * would find a live pid and wait for it all over again.
 */
async function awaitReady(
  here: Checkout,
  server: Server,
  boot: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let live = true;
  while (Date.now() < deadline && live) {
    live = await stillOurs(server, boot);
    if (live && (await answers(LOOPBACK, server.port))) {
      await refuseOffLoopback(here.state, here.stem, server, boot);
      console.log(origin(server.port));
      return;
    }
    if (live) await Bun.sleep(POLL_MS);
  }
  await stop(here.state, here.stem, server, boot);
  console.error(tail(await readFile(server.log, "utf8"), TIMEOUT_LINES));
  throw new Error(
    live
      ? `\`bun run dev\` in ${server.worktree} did not answer on port ${server.port} within ${budgetMs}ms — its last ${TIMEOUT_LINES} log lines are above (${server.log})`
      : `\`bun run dev\` in ${server.worktree} exited before it answered on port ${server.port} — its last ${TIMEOUT_LINES} log lines are above (${server.log})`,
  );
}

/**
 * The port this worktree already claimed, or the refusal. A claimed port is
 * never stepped over: moving to the next one would keep `up` working and quietly
 * break the property the whole derivation exists for — that a worktree's URL is
 * the same one tomorrow.
 */
async function keptPort(port: number): Promise<number> {
  if (await isFree(port)) return port;
  throw new Error(
    `port ${port} is claimed by this worktree and something else is listening on it — stop that process (\`lsof -iTCP:${port} -sTCP:LISTEN\`), or run \`dev-server down\` here to give the claim up so the next \`up\` derives another`,
  );
}

async function up(here: Checkout): Promise<void> {
  const budgetMs = readyTimeout();
  const boot = await bootId();
  await mkdir(here.state, { recursive: true, mode: STATE_MODE });
  await chmod(here.state, STATE_MODE);
  await using guard = await lock(here.state, here.stem, boot);
  void guard;
  const existing = await serverHere(here);
  if (existing !== null && (await stillOurs(existing, boot))) {
    await awaitReady(here, existing, boot, budgetMs);
    return;
  }
  const packageName = await declaredName(here.worktree);
  const base = basePort(packageName, here);
  const port =
    existing !== null && inBlock(base, existing.port)
      ? await keptPort(existing.port)
      : await freePort(base, isFree);
  const log = logPath(here.state, here.stem);
  // Appended, not truncated: a spawn that fails on its first line would
  // otherwise destroy the log of the run somebody came here to read. The mode is
  // set as well as asked for, because `open` applies it only when it creates.
  const handle = await open(log, "a", FILE_MODE);
  await handle.chmod(FILE_MODE);
  await handle.writeFile(`\n=== dev-server up ${new Date().toISOString()} on port ${port} ===\n`);
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
  const stat = await procStat(child.pid);
  if (stat === null) {
    console.error(tail(await readFile(log, "utf8"), TIMEOUT_LINES));
    throw new Error(
      `\`bun run dev\` in ${here.worktree} exited before it started — its last ${TIMEOUT_LINES} log lines are above (${log})`,
    );
  }
  // Written as soon as there is a pid to write, and under the lock, so nothing
  // else in this worktree can be between the two. The window that remains is
  // this process dying in it: the child is then orphaned with no record, and
  // what surfaces it is the next `up` refusing the port it is holding.
  await writeRecord(here.state, here.stem, {
    worktree: here.worktree,
    branch: here.branch,
    packageName,
    port,
    pid: child.pid,
    bootId: boot,
    startTicks: stat.startTicks,
    log,
    startedAt: new Date().toISOString(),
  });
  await awaitReady(here, await mustRead(here), boot, budgetMs);
}

/** The record just written, read back through the one decoder every other command uses. */
async function mustRead(here: Checkout): Promise<Server> {
  const server = await serverHere(here);
  if (server === null)
    throw new Error(`${recordPath(here.state, here.stem)} vanished as it was written`);
  return server;
}

async function down(here: Checkout): Promise<void> {
  const server = await serverHere(here);
  if (server === null) {
    console.error(`no dev server recorded for ${here.branch}`);
    return;
  }
  const outcome = await stop(here.state, here.stem, server, await bootId());
  console.error(
    outcome === "stopped"
      ? `stopped ${here.branch} on port ${server.port}`
      : `${here.branch} on port ${server.port} was already gone — forgot its record`,
  );
}

const COLUMNS = ["branch", "port", "pid", "process", "http", "worktree"] as const;
type Column = (typeof COLUMNS)[number];
type Row = Readonly<Record<Column, string>>;

async function status(here: Checkout): Promise<void> {
  const found = await entries(here.state);
  if (found.length === 0) {
    console.error("no dev server has been started in this repository");
    return;
  }
  const boot = await bootId();
  const rows: Row[] = [];
  for (const entry of found) {
    if (entry.kind !== "server") continue;
    const live = await stillOurs(entry.server, boot);
    rows.push({
      branch: entry.server.branch,
      port: String(entry.server.port),
      pid: String(entry.server.pid),
      process: live ? "alive" : "dead",
      http: (await answers(LOOPBACK, entry.server.port)) ? "answering" : "silent",
      worktree: entry.server.worktree,
    });
  }
  if (rows.length > 0) {
    const header: Row = {
      branch: "branch",
      port: "port",
      pid: "pid",
      process: "process",
      http: "http",
      worktree: "worktree",
    };
    const table = [header, ...rows];
    const width = (column: Column): number => Math.max(...table.map((row) => row[column].length));
    for (const row of table) {
      console.log(
        COLUMNS.map((column) => row[column].padEnd(width(column)))
          .join("  ")
          .trimEnd(),
      );
    }
  }
  for (const entry of found) {
    if (entry.kind === "junk") console.log(`junk  ${entry.path}  ${entry.why}`);
  }
}

async function url(here: Checkout): Promise<void> {
  const server = await serverHere(here);
  if (
    server === null ||
    !(await stillOurs(server, await bootId())) ||
    !(await answers(LOOPBACK, server.port))
  ) {
    console.error(`no dev server is up for ${here.branch} — \`dev-server up\` starts one`);
    process.exitCode = 1;
    return;
  }
  console.log(origin(server.port));
}

async function logs(here: Checkout, flags: ReadonlySet<string>): Promise<void> {
  const server = await serverHere(here);
  // The log outlives the record — `down` keeps it on purpose — so its path is
  // the stem's whenever there is no record to read it off.
  const log = server === null ? logPath(here.state, here.stem) : server.log;
  if (!existsSync(log)) {
    console.error(`no dev server has been started for ${here.branch}, so there is no log yet`);
    process.exitCode = 1;
    return;
  }
  if (!flags.has("-f") && !flags.has("--follow")) {
    console.log(tail(await readFile(log, "utf8"), TAIL_LINES));
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
 * as live, and a record of one is exactly what `sweep` is looking for. The rule
 * is therefore "the path is not there", which a worktree on an unmounted volume
 * also satisfies: `sweep` would stop its server and forget it.
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
  const boot = await bootId();
  let collected = 0;
  for (const entry of await entries(here.state)) {
    if (entry.kind === "junk") {
      await rm(entry.path, { force: true });
      await rm(entry.path.replace(/\.json$/, ".log"), { force: true });
      console.error(`removed ${entry.path} — it is not a dev-server record`);
      collected += 1;
      continue;
    }
    if (live.has(entry.server.worktree)) continue;
    const stem = entry.path.slice(here.state.length + 1, -".json".length);
    await stop(here.state, stem, entry.server, boot);
    // The log goes too, and only here: `down` keeps it because someone is about
    // to read why the server stopped, while a worktree that is gone has nobody
    // left who can even ask — `logs` derives its path from a checkout that is
    // no longer there.
    await rm(entry.server.log, { force: true });
    console.error(
      `stopped ${entry.server.branch} on port ${entry.server.port} — ${entry.server.worktree} is gone`,
    );
    collected += 1;
  }
  if (collected === 0) console.error("every record belongs to a worktree that is still here");
}

interface Command {
  readonly summary: string;
  /** What this command takes besides its name. Anything else is a typo, and says so. */
  readonly flags: readonly string[];
  run(here: Checkout, flags: ReadonlySet<string>): Promise<void>;
}

const COMMANDS = new Map<string, Command>([
  [
    "up",
    {
      summary: "start this worktree's dev server if it is not up, and print its URL",
      flags: [],
      run: async (here) => await up(here),
    },
  ],
  ["down", { summary: "stop it", flags: [], run: async (here) => await down(here) }],
  [
    "status",
    {
      summary: "every server this repository has, and whether it is alive and answering",
      flags: [],
      run: async (here) => await status(here),
    },
  ],
  [
    "url",
    {
      summary: "this worktree's URL, or exit 1 if no server is up",
      flags: [],
      run: async (here) => await url(here),
    },
  ],
  ["logs", { summary: "the tail of this worktree's log", flags: ["-f", "--follow"], run: logs }],
  [
    "sweep",
    {
      summary: "stop and forget the servers of worktrees that are gone",
      flags: [],
      run: async (here) => await sweep(here),
    },
  ],
]);

function usage(): string {
  const names = [...COMMANDS.keys()];
  const width = Math.max(...names.map((name) => name.length));
  const lines = [...COMMANDS].map(
    ([name, command]) =>
      `  ${name.padEnd(width)}  ${command.summary}${command.flags.length === 0 ? "" : ` (${command.flags.join(", ")})`}`,
  );
  return [`dev-server <${names.join("|")}>`, "", ...lines].join("\n");
}

/**
 * The command word and its arguments are settled before anything is read off the
 * machine, so `dev-server restart` outside a repository prints the usage rather
 * than git's complaint, and leaves no directory behind.
 */
async function main(argv: readonly string[]): Promise<void> {
  const [name = "", ...rest] = argv;
  const command = COMMANDS.get(name);
  if (command === undefined) {
    throw new Error(name === "" ? usage() : `no such command \`${name}\`\n\n${usage()}`);
  }
  const unknown = rest.filter((argument) => !command.flags.includes(argument));
  if (unknown.length > 0) {
    throw new Error(`\`${name}\` does not take \`${unknown.join(" ")}\`\n\n${usage()}`);
  }
  await command.run(await checkout(process.cwd()), new Set(rest));
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
