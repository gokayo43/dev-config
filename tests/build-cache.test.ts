/**
 * The build action's script, run for real against a fixture repository whose
 * `build` records, before it writes, what the cached path already held. That
 * record is the one thing a cache is for, and it is read off the build itself
 * rather than off the script's log lines.
 *
 * Each run gets a fresh workspace with the same files, because a runner's
 * checkout deletes the ignored build output between runs: a marker the build
 * sees can only have come from the store.
 *
 * The script runs in a session of its own (`setsid`), so a shim can kill it the
 * way a cancelled job is killed: every process of the step at once, the
 * subshells it copies in included.
 */
import { describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { scratch } from "./tree.ts";

const SCRIPT = new URL("../.github/actions/build/build.sh", import.meta.url).pathname;

const REPOSITORY = "owner/repo";

const CACHED = ".next/cache";

/**
 * Logs `warm:<the last build's marker>` or `cold`, writes this run's marker,
 * and exits as told. On request it also leaves a read-only directory, or a file
 * nobody may read, under the cached path: what a build tool may write and the
 * store has to carry or refuse without failing the build.
 */
const BUILD = [
  `if [ -f ${CACHED}/marker ]; then echo "warm:$(cat ${CACHED}/marker)" >> "$BUILD_LOG"; else echo cold >> "$BUILD_LOG"; fi`,
  `mkdir -p ${CACHED}`,
  `echo "$BUILD_OUTPUT" > ${CACHED}/marker`,
  `if [ -n "\${BUILD_SEALED:-}" ]; then mkdir -p ${CACHED}/sealed; [ -f ${CACHED}/sealed/file ] || echo sealed > ${CACHED}/sealed/file; chmod 555 ${CACHED}/sealed; fi`,
  `if [ -n "\${BUILD_UNREADABLE:-}" ]; then echo private > ${CACHED}/unreadable; chmod 000 ${CACHED}/unreadable; fi`,
  `exit "$BUILD_EXIT"`,
].join("\n");

interface Runner {
  /** The runner's tool cache, which outlives every workspace. */
  readonly tools: string;
  /** What each build said about the cache it found, in order. */
  readonly log: string;
}

async function runner(): Promise<Runner> {
  const root = await scratch();
  return { tools: join(root, "tools"), log: join(root, "build.log") };
}

/** A checkout as the runner leaves it before the build: the tracked files and no build output. */
async function workspace(lockfile: string | null): Promise<string> {
  const root = await scratch();
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({ scripts: { build: "sh build.sh" } }),
  );
  await Bun.write(join(root, "build.sh"), BUILD);
  if (lockfile !== null) await Bun.write(join(root, "bun.lock"), lockfile);
  return root;
}

interface Run {
  readonly exitCode: number;
  readonly output: string;
}

interface Options {
  /** What the fixture's build exits with. */
  readonly exit: number;
  /** What it writes into the cached path. */
  readonly output: string;
  /** Anything else the script's environment carries: a shim's PATH, another repository, a fixture switch. */
  readonly env: Record<string, string>;
}

async function build(
  at: Runner,
  cwd: string,
  cache: string,
  { exit = 0, output = "built", env = {} }: Partial<Options> = {},
): Promise<Run> {
  const proc = Bun.spawn(["setsid", "bash", SCRIPT], {
    cwd,
    env: {
      ...process.env,
      BUILD_CACHE: cache,
      RUNNER_TOOL_CACHE: at.tools,
      GITHUB_REPOSITORY: REPOSITORY,
      BUILD_LOG: at.log,
      BUILD_EXIT: String(exit),
      BUILD_OUTPUT: output,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** What each build saw; an absent log is a build that never ran. */
async function seen(at: Runner): Promise<string[]> {
  if (!(await exists(at.log))) return [];
  return (await readFile(at.log, "utf8")).trim().split("\n");
}

/** The key the contract names: the first 16 hex digits of bun.lock's sha256. */
function keyOf(lockfile: string): string {
  return new Bun.CryptoHasher("sha256").update(lockfile).digest("hex").slice(0, 16);
}

function storeOf(at: Runner, repository = REPOSITORY): string {
  return join(at.tools, "build-cache", repository);
}

/** The directory the store's `current` link names, which is the one a restore reads. */
async function live(at: Runner): Promise<string> {
  return readlink(join(storeOf(at), "current"));
}

/** Every entry under a directory with its bytes, so two snapshots differ wherever the trees do. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const contents = entry.isSymbolicLink()
        ? `-> ${await readlink(path)}`
        : entry.isDirectory()
          ? "<directory>"
          : await readFile(path, "utf8");
      return [path.slice(root.length), contents] as const;
    }),
  );
  return Object.fromEntries(files);
}

/**
 * A `cp` or `mv` first on PATH that does the real thing, and kills the step
 * whenever the destination matches: after the copy for `cp`, so what it wrote
 * stays, and before the move for `mv`, so the move never happens.
 */
async function killing(tool: "cp" | "mv", destination: string): Promise<Record<string, string>> {
  const real = Bun.which(tool);
  if (real === null) throw new Error(`no ${tool} on PATH to put a shim in front of`);
  const kill = 'for into; do :; done; case "$into" in $KILL_ON) kill -9 0 ;; esac';
  const bin = join(await scratch(), "bin");
  await Bun.write(
    join(bin, tool),
    ["#!/bin/sh", ...(tool === "cp" ? [`${real} "$@"`, kill] : [kill, `exec ${real} "$@"`])].join(
      "\n",
    ),
  );
  await chmod(join(bin, tool), 0o755);
  return { PATH: `${bin}:${process.env["PATH"] ?? ""}`, KILL_ON: destination };
}

/** Gives the owner write access back, so the suite's cleanup can delete what a sealed build left. */
async function unseal(...roots: string[]): Promise<void> {
  await Promise.all(roots.map((root) => Bun.spawn(["chmod", "-R", "u+w", root]).exited));
}

const LOCK = "lockfile one\n";

describe("the store between runs", () => {
  // Wrong implementation: a save that is never written, or written somewhere
  // the next restore does not look.
  test("a cold run builds without a cache and saves the path under the lockfile's key", async () => {
    const at = await runner();
    const run = await build(at, await workspace(LOCK), CACHED);

    expect(run.exitCode).toBe(0);
    expect(await seen(at)).toEqual(["cold"]);
    expect(await live(at)).toStartWith(`${keyOf(LOCK)}.`);
    expect(await readFile(join(storeOf(at), await live(at), CACHED, "marker"), "utf8")).toBe(
      "built\n",
    );
  });

  // Wrong implementations: a restore that runs after the build, and a key
  // derived from anything but the lockfile, such as the workspace's path.
  test("a second run with the same lockfile builds on the first run's cache", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const run = await build(at, await workspace(LOCK), CACHED, { output: "second" });

    expect(run.exitCode).toBe(0);
    expect(await seen(at)).toEqual(["cold", "warm:built"]);
  });

  // Wrong implementation: no eviction, so every lockfile the repository ever
  // had keeps a whole build cache on the runner's disk.
  test("a changed lockfile builds cold and leaves only its own key", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const changed = "lockfile two\n";
    const run = await build(at, await workspace(changed), CACHED);

    expect(run.exitCode).toBe(0);
    expect(await seen(at)).toEqual(["cold", "cold"]);
    expect(await live(at)).toStartWith(`${keyOf(changed)}.`);
    expect((await readdir(storeOf(at))).toSorted()).toEqual(["current", await live(at)].toSorted());
  });

  // Wrong implementation: an eviction over the whole tool cache rather than
  // this repository's store, which empties every other repository's cache on
  // the runner.
  test("the eviction leaves another repository's cache alone", async () => {
    const at = await runner();
    const other = { GITHUB_REPOSITORY: "owner/other" };
    await build(at, await workspace("theirs\n"), CACHED, { output: "theirs", env: other });
    await build(at, await workspace(LOCK), CACHED);
    await build(at, await workspace("theirs\n"), CACHED, { env: other });

    expect(await seen(at)).toEqual(["cold", "cold", "warm:theirs"]);
  });

  // Wrong implementation: a save before the build, or one that runs whatever
  // the build answered, which files a broken build's output for the next run.
  test("a failed build fails the step and leaves the store as it was", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const before = await snapshot(at.tools);
    const run = await build(at, await workspace(LOCK), CACHED, { exit: 1, output: "broken" });

    expect(run.exitCode).not.toBe(0);
    expect(await seen(at)).toEqual(["cold", "warm:built"]);
    expect(await snapshot(at.tools)).toEqual(before);
  });

  // Wrong implementation: a move into the store, which leaves a job that
  // starts the built app afterwards without the cache Next writes under.
  test("the workspace keeps the cached path after the save", async () => {
    const at = await runner();
    const checkout = await workspace(LOCK);
    await build(at, checkout, CACHED);

    expect(await readFile(join(checkout, CACHED, "marker"), "utf8")).toBe("built\n");
  });

  // Wrong implementation: a save that fails, or stops, at a path this build
  // did not write, which is why that path comes first.
  test("a path the build never wrote is reported and the paths after it are saved", async () => {
    const at = await runner();
    const run = await build(at, await workspace(LOCK), `\n.turbo/cache\n\n${CACHED}\n`);

    expect(run.exitCode).toBe(0);
    expect(run.output).toContain(".turbo/cache not written by this build");
    expect(await readdir(join(storeOf(at), await live(at)))).toEqual([".next"]);
  });

  // Wrong implementation: a line taken as the path it spells, whitespace and
  // all, which a YAML block keeps at the end of a line and nobody sees: the
  // build writes `.next/cache` and the script looks for `.next/cache  `.
  test("whitespace around a path is not part of it", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), `  ${CACHED}  `);
    await build(at, await workspace(LOCK), `  ${CACHED}  `);

    expect(await seen(at)).toEqual(["cold", "warm:built"]);
  });
});

describe("a save that never finished", () => {
  // Wrong implementation: a save written straight into the directory the next
  // restore reads, so a run killed half way leaves part of a cache there.
  test("killed while copying, the previous save is what the next run restores", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const before = await snapshot(storeOf(at));

    const killed = await build(at, await workspace(LOCK), CACHED, {
      output: "half",
      env: await killing("cp", `${storeOf(at)}/*`),
    });
    expect(killed.exitCode).not.toBe(0);
    expect(await snapshot(storeOf(at))).toMatchObject(before);

    await build(at, await workspace(LOCK), CACHED);
    expect(await seen(at)).toEqual(["cold", "warm:built", "warm:built"]);
    expect(await readdir(storeOf(at))).toHaveLength(2);
  });

  // Wrong implementation: the previous save moved aside, or deleted, before
  // the new one takes its place, so a kill between the two steps leaves no
  // cache at all and the next save's eviction deletes a good one.
  test("killed just before the new save takes over, the previous one still serves", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);

    const killed = await build(at, await workspace(LOCK), CACHED, {
      output: "complete but never live",
      env: await killing("mv", `${storeOf(at)}/current`),
    });
    expect(killed.exitCode).not.toBe(0);

    await build(at, await workspace(LOCK), CACHED);
    expect(await seen(at)).toEqual(["cold", "warm:built", "warm:built"]);
    expect(await readdir(storeOf(at))).toHaveLength(2);
  });
});

/**
 * The store is the runner's disk, and the build is the step's verdict: a store
 * that cannot be read or written costs the cache, says so with a warning, and
 * never turns a passing build red.
 */
describe("a store that fails", () => {
  // Wrong implementations: a restore under `set -e`, so one file the restore
  // cannot read fails this run and, since nothing replaces that key, every
  // run on that runner after it; and a failed restore that leaves what it did
  // copy in the workspace, so the build runs on part of a cache. The file
  // nobody may read sits beside the marker, which cp copies regardless.
  test("a cache the restore cannot read is dropped and the build runs cold", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const unreadable = join(storeOf(at), await live(at), CACHED, "unreadable");
    await Bun.write(unreadable, "private\n");
    await chmod(unreadable, 0o000);

    const run = await build(at, await workspace(LOCK), CACHED, { output: "rebuilt" });
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("::warning::");
    await build(at, await workspace(LOCK), CACHED);
    expect(await seen(at)).toEqual(["cold", "cold", "warm:rebuilt"]);
  });

  // Wrong implementation: a failed restore that leaves the cache it could not
  // read in place, so every run until a save succeeds warns about it again;
  // a build that fails as well is what keeps a save from replacing it.
  test("a cache the restore could not read is gone even when the build fails", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);
    const unreadable = join(storeOf(at), await live(at), CACHED, "unreadable");
    await Bun.write(unreadable, "private\n");
    await chmod(unreadable, 0o000);

    await build(at, await workspace(LOCK), CACHED, { exit: 1 });
    const next = await build(at, await workspace(LOCK), CACHED);
    expect(next.exitCode).toBe(0);
    expect(next.output).not.toContain("::warning::");
    expect(await seen(at)).toEqual(["cold", "cold", "cold"]);
  });

  // Wrong implementation: a save whose failure fails the step, which makes a
  // build that passed red for a reason that is not the build.
  test("a save that cannot copy warns, passes, and leaves the previous save live", async () => {
    const at = await runner();
    await build(at, await workspace(LOCK), CACHED);

    const run = await build(at, await workspace(LOCK), CACHED, {
      output: "unsaved",
      env: { BUILD_UNREADABLE: "1" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("::warning::");
    await build(at, await workspace(LOCK), CACHED);
    expect(await seen(at)).toEqual(["cold", "warm:built", "warm:built"]);
    expect(await readdir(storeOf(at))).toHaveLength(2);
  });

  // Wrong implementation: an eviction that cannot delete a read-only directory
  // a build tool wrote (cp -a keeps its mode), which fails a passing build and
  // leaves one more cache on the disk every run.
  test("a read-only directory in the cache is carried and evicted like any other", async () => {
    const at = await runner();
    const sealed = { BUILD_SEALED: "1" };
    const checkouts = [await workspace(LOCK), await workspace(LOCK), await workspace(LOCK)];
    try {
      const runs = [];
      for (const checkout of checkouts)
        runs.push(await build(at, checkout, CACHED, { env: sealed }));

      expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0]);
      expect(await seen(at)).toEqual(["cold", "warm:built", "warm:built"]);
      expect(await readdir(storeOf(at))).toHaveLength(2);
    } finally {
      await unseal(at.tools, ...checkouts);
    }
  });
});

describe("what runs without a store", () => {
  // Wrong implementations: a store made, or a lockfile demanded, for a caller
  // that named nothing to cache, which is every caller before this input; and
  // the one blank line an empty input arrives as, read as a path.
  test.each([
    ["with a lockfile", LOCK],
    ["without a lockfile", null],
  ])("an empty cache builds %s and makes no store", async (_, lockfile) => {
    const at = await runner();
    const run = await build(at, await workspace(lockfile), "");

    expect(run.exitCode).toBe(0);
    expect(await seen(at)).toEqual(["cold"]);
    expect(await exists(join(at.tools, "build-cache"))).toBe(false);
  });
});

describe("what the caller's own input refuses", () => {
  // Wrong implementation: a path checked after the build, or not at all, so
  // the save copies outside the repository or over another repository's store,
  // the restore deletes the checkout it stands in, or a path named twice or
  // inside another lands a copy inside the copy and the store grows every run.
  test.each([
    ["a path climbing out", "../outside", LOCK],
    ["a path climbing out midway", ".next/../../outside", LOCK],
    ["an absolute path", "/etc", LOCK],
    ["the repository root", ".", LOCK],
    ["the repository root with a slash", "./", LOCK],
    ["the repository root spelled twice", "././", LOCK],
    ["the repository root with an empty segment", ".//", LOCK],
    ["a path named twice", `${CACHED}\n${CACHED}`, LOCK],
    ["a path named twice in two spellings", `./${CACHED}\n${CACHED}/`, LOCK],
    ["a path inside one named before it", `.next\n${CACHED}`, LOCK],
    ["a path inside one named after it", `${CACHED}\n.next`, LOCK],
    ["no lockfile to key on", CACHED, null],
  ])("%s is refused before the build runs", async (_, cache, lockfile) => {
    const at = await runner();
    const run = await build(at, await workspace(lockfile), cache);

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("::error::");
    expect(await seen(at)).toEqual([]);
    expect(await exists(at.tools)).toBe(false);
  });
});
