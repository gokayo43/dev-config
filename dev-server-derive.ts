/**
 * The pure half of the `dev-server` bin: what a worktree's server is called,
 * which port it gets, and what its record has to be. Nothing here reads the
 * machine, so every naming rule is testable without a repository, a process or
 * a free port.
 *
 * Identity is the **worktree**, never a name derived from it. Two branches that
 * differ only in punctuation or case reduce to one slug, and two detached
 * worktrees share one short commit — so anything keyed on a readable name is one
 * record and one port for two servers, which is one worktree serving another's
 * code under a URL it prints itself.
 */

/**
 * Where derived dev ports live. The floor is above the ports servers are
 * conventionally reached on; the ceiling is below 65535. It deliberately does
 * NOT dodge the ephemeral range the kernel hands out — that is 32768-60999 on
 * this fleet's kernels, which no span of 40000 usable ports could avoid — so
 * every port is probed before it is claimed rather than assumed free.
 */
export const PORT_FLOOR = 20_000;
export const PORT_CEILING = 60_000;

/** Ports one worktree may claim, all inside one block, so two branches cannot drift into each other. */
export const PORTS_PER_WORKTREE = 10;

/** What a worktree is, to the two derivations below. */
export interface Identity {
  /** The absolute, resolved path of the checkout. */
  readonly worktree: string;
  /** The branch as git spells it, or the short commit when there is no branch. */
  readonly branch: string;
  /** Whether that commit is all the name there is. */
  readonly detached: boolean;
}

/**
 * Which process a file names, beyond its number. A pid alone names a different
 * process after a reboot and, given time, on the same one — and this tool
 * signals process GROUPS, so being wrong costs somebody else's processes rather
 * than an error. The boot id says which boot the number was taken on, and the
 * start tick (`/proc/<pid>/stat` field 22) says when within it, which together
 * no recycled pid reproduces.
 *
 * Two files carry one: a server's record, and the lock one `up` holds against
 * another. So one guard reads both, and one question is asked of both.
 */
export interface Holder {
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: number;
}

/** What `up` wrote down, and what every other command reads to find the process again. */
export interface Server extends Holder {
  readonly worktree: string;
  readonly branch: string;
  readonly packageName: string;
  readonly port: number;
  readonly log: string;
  readonly startedAt: string;
}

/**
 * A branch name reduced to what a filename can carry: lowercase, `_` for
 * anything else, no leading digit, no repeated or trailing separators. It is a
 * prefix a person reads and nothing else decides — `recordStem` puts the
 * worktree's own tag after it, because this reduction is lossy and two branches
 * that collapse together are two live worktrees.
 */
export function worktreeSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return slug === "" || /^[0-9]/.test(slug) ? `w_${slug}` : slug;
}

/** A short fixed-width tag for a string, so a readable prefix can carry an exact one. */
export function tag(text: string): string {
  return hash(text).toString(36).padStart(7, "0");
}

/**
 * The filename a worktree's record and log are named after: the branch for a
 * reader, the worktree's path for the machine. The path is what makes it an
 * identity — one checkout, one stem — and `up` still checks the `worktree` field
 * of what it reads, because a 32-bit tag is short enough to owe that check.
 */
export function recordStem(worktree: string, branch: string): string {
  return `${worktreeSlug(branch)}-${tag(worktree)}`;
}

/**
 * Where this worktree's ports live. Deterministic, so a worktree comes back to
 * the same block across restarts, and spread out, so two worktrees rarely start
 * in the same place — the probe decides which port inside the block is used.
 *
 * Hashed from the branch **as git spells it**, not from its slug: `feat/x` and
 * `feat-x` are two worktrees and must be two blocks. A detached worktree hashes
 * its path instead, because two of them at one commit have the same name and
 * only their paths differ. The package name is in the hash and not merely beside
 * it: every repo on a machine has a `main`, and hashing the branch alone puts
 * two of them in one block.
 */
export function basePort(packageName: string, who: Identity): number {
  const span = (PORT_CEILING - PORT_FLOOR) / PORTS_PER_WORKTREE;
  const key = `${packageName}/${who.detached ? who.worktree : who.branch}`;
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
 * the block another worktree is deterministically about to claim.
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

/**
 * Every field checked, and the numbers checked for more than their type: this
 * file outlives the version that wrote it, and a record is the input to a `kill`.
 * A pid of `0` signals the caller's own process group and `1` signals everything
 * the user may signal, so "is a number" is not a bound — nor is a port outside
 * the range anything this tool ever derived.
 */
export function isServer(value: unknown): value is Server {
  return isHolder(value) && hasText(value) && hasPort(value);
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

/** The five fields that are text. */
function hasText(value: unknown): value is {
  worktree: string;
  branch: string;
  packageName: string;
  log: string;
  startedAt: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "worktree" in value &&
    typeof value.worktree === "string" &&
    "branch" in value &&
    typeof value.branch === "string" &&
    "packageName" in value &&
    typeof value.packageName === "string" &&
    "log" in value &&
    typeof value.log === "string" &&
    "startedAt" in value &&
    typeof value.startedAt === "string"
  );
}

function hasPort(value: unknown): value is { port: number } {
  return typeof value === "object" && value !== null && "port" in value && isPort(value.port);
}

/** A pid this tool may signal: a real process, never `0` (its own group) or `1` (everything). */
function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

/** A port this tool could have derived. Anything else did not come from here. */
function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PORT_FLOOR &&
    value < PORT_CEILING
  );
}

/** A tick count `/proc` could have reported. */
function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** FNV-1a: short, stable across runs, and not a security claim — it names things. */
function hash(text: string): number {
  let value = 2_166_136_261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  return value;
}
