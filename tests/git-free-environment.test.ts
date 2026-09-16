/**
 * The suite, run the way a git hook runs it, against a repository it must not
 * touch. `lefthook.yml` runs `bun test` from `pre-push`, and git hands every
 * hook the location of the repository it is acting on — so the fixtures' own
 * `git init` / `git add` / `git commit` land in that repository instead of in
 * the temp directory they were given, which is how a push once rewrote its own
 * branch into `commit 0`, `commit 1` and flipped `core.bare` to `true`.
 *
 * Observed from outside: a `bun test` child is given a hook's variables pointed
 * at a sacrificial repository this case builds, and what is graded is that
 * repository afterwards. Grading it from inside would ask the damaged
 * repository about itself — every read a fixture makes under those variables
 * answers from the sacrificial repository too, so a case that asks the fixture
 * whether it has its commits passes on the unfixed tree.
 */
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { plainly } from "../.github/actions/_lib/gate.ts";
import { IDENTITY, git, scratch } from "./tree.ts";

const HERE = join(import.meta.dir, "..");

/**
 * A read of the sacrificial repository that survives the repository being
 * broken, which is the state the unfixed tree leaves it in: a `git` that throws
 * on a non-zero exit reports the first damaged read instead of the whole diff.
 * Synchronous because a snapshot is one value, and because it is this file's
 * own use of the second wrapper the preload installs.
 */
function reads(cwd: string, args: readonly string[]): string {
  const done = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const said = done.exitCode === 0 ? done.stdout : done.stderr;
  return said.toString().trim();
}

/** Asked rather than written down: the value is this machine's, and a fixture stating one states a lie on the next. */
const EXEC_PATH = reads(HERE, ["--exec-path"]);

interface Sacrificial {
  /** What a hook puts in `GIT_DIR`: a linked worktree's git dir, which is where the incident's was. */
  readonly gitDir: string;
  readonly worktree: string;
  readonly main: string;
}

/** A repository with one commit and a linked worktree, which is the shape a hook is run from. */
async function sacrificial(): Promise<Sacrificial> {
  const root = await scratch();
  const main = join(root, "main");
  const worktree = join(root, "probe");
  await mkdir(main, { recursive: true });
  await git(main, ["init", "--quiet", "--initial-branch=main"]);
  await Bun.write(join(main, "kept.txt"), "kept\n");
  await git(main, [...IDENTITY, "add", "--all"]);
  await git(main, [...IDENTITY, "commit", "--quiet", "--message", "the one commit"]);
  await git(main, [...IDENTITY, "worktree", "add", "--quiet", "-b", "probe", worktree, "main"]);
  return { gitDir: join(main, ".git", "worktrees", "probe"), worktree, main };
}

/** Everything the acceptance contract says a run must leave alone. */
function state(repository: Sacrificial) {
  const { main, worktree } = repository;
  return {
    head: reads(worktree, ["rev-parse", "HEAD"]),
    branch: reads(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    log: reads(worktree, ["log", "--oneline"]),
    tracked: reads(worktree, ["ls-tree", "-r", "--name-only", "HEAD"]),
    index: reads(worktree, ["status", "--porcelain"]),
    reflog: reads(worktree, ["reflog", "show", "probe"]),
    bare: reads(main, ["config", "--get", "core.bare"]),
    // The one field the hook's `GIT_AUTHOR_*` would rewrite rather than add to.
    author: reads(worktree, ["log", "-1", "--format=%an <%ae> %aI"]),
  };
}

/**
 * A test file that commits through every spawn shape this suite uses: the
 * shared fixture builder, which hands `Bun.spawn` an `env` of its own, and both
 * call forms of each of `Bun.spawn` and `Bun.spawnSync` handing it none. The
 * second group is the half a scrub of `process.env` alone does not reach, and
 * the synchronous one is a wrapper of its own — deleting it leaves this file's
 * other cases green.
 */
const COMMITTING = `
import { expect, test } from "bun:test";
import { join } from "node:path";
import { history, scratch } from ${JSON.stringify(join(HERE, "tests", "tree.ts"))};

const WHO = ["-c", "user.email=probe@example.com", "-c", "user.name=probe"];

async function ran(options) {
  const proc = Bun.spawn(options);
  const said = await new Response(proc.stderr).text();
  expect(await proc.exited, said).toBe(0);
}

function ranSync(options) {
  const done = Bun.spawnSync(options);
  expect(done.exitCode, done.stderr.toString()).toBe(0);
}

test("the fixture builder commits into its own root", async () => {
  const repo = await history({ "one.txt": "one" }, { "two.txt": "two" });
  expect(repo.revs).toHaveLength(2);
  expect(await Bun.file(join(repo.root, ".git", "HEAD")).exists()).toBe(true);
});

test("a spawn that states no env commits into its own root", async () => {
  const root = await scratch();
  await Bun.write(join(root, "raw.txt"), "raw");
  // The array call form, which every git in this suite that omits \`env\` uses.
  await ran({ cmd: ["git", "init", "--quiet", "--initial-branch=main"], cwd: root, stderr: "pipe" });
  await ran({ cmd: ["git", ...WHO, "add", "--all"], cwd: root, stderr: "pipe" });
  await ran({ cmd: ["git", ...WHO, "commit", "--quiet", "--message", "raw"], cwd: root, stderr: "pipe" });
  // The object call form, which is the other half of the same public API.
  const log = Bun.spawn({ cmd: ["git", "log", "--oneline"], cwd: root, stdout: "pipe" });
  expect(await new Response(log.stdout).text()).toContain("raw");
});

test("a synchronous spawn that states no env commits into its own root", async () => {
  const root = await scratch();
  await Bun.write(join(root, "sync.txt"), "sync");
  ranSync({ cmd: ["git", "init", "--quiet", "--initial-branch=main"], cwd: root, stderr: "pipe" });
  ranSync({ cmd: ["git", ...WHO, "add", "--all"], cwd: root, stderr: "pipe" });
  // The array form of the synchronous spawn, so both of its call forms are driven.
  const done = Bun.spawnSync(["git", ...WHO, "commit", "--quiet", "--message", "sync"], {
    cwd: root,
    stderr: "pipe",
  });
  expect(done.exitCode, done.stderr.toString()).toBe(0);
  const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: root, stdout: "pipe" });
  expect(log.stdout.toString()).toContain("sync");
});
`;

/** The `bun test` a hook runs, given the variables git exports to one. */
async function runs(exported: Record<string, string>): Promise<{ code: number; said: string }> {
  const home = await scratch();
  const file = join(home, "committing.test.ts");
  await Bun.write(file, COMMITTING);
  const proc = Bun.spawn([process.execPath, "test", file], {
    cwd: HERE,
    // `TMPDIR` because the fixture registry derives its root from this worktree
    // and nothing else: without it the child reuses the roots the parent run is
    // using, and the two delete each other's fixtures.
    env: { ...plainly(process.env), TMPDIR: home, ...exported },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, bad] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, said: `${out}\n${bad}` };
}

/** What git exports to `pre-push`, which is the hook `lefthook.yml` runs the suite from. */
function prePush({ gitDir }: Sacrificial) {
  return { GIT_DIR: gitDir, GIT_EDITOR: "true", GIT_EXEC_PATH: EXEC_PATH, GIT_PREFIX: "" };
}

/**
 * One hook environment per case, each with the wrong implementation it exists to
 * kill — reported as the failure's message, so a case that goes red says which
 * guarantee went with it rather than only which bytes moved.
 *
 * Every set is what git 2.43.0 was probed exporting from a linked worktree,
 * except `GIT_CONFIG_PARAMETERS`, which git adds only when the invocation
 * carried `-c` — a hook can be run under one, so the prefix has to take it too.
 */
const HOOKS = [
  [
    "pre-push",
    prePush,
    "a preload that removes the variables from `process.env` and stops there, leaving every spawn site that states no `env` reading the block the process launched with",
  ],
  [
    "pre-commit, which carries an index and an author besides",
    (repository: Sacrificial) => ({
      ...prePush(repository),
      GIT_EDITOR: ":",
      GIT_INDEX_FILE: join(repository.gitDir, "index"),
      GIT_AUTHOR_DATE: "@1700000000 +0000",
      GIT_AUTHOR_EMAIL: "hook@example.com",
      GIT_AUTHOR_NAME: "hook",
      GIT_CONFIG_PARAMETERS: "'user.name=hook'",
    }),
    "a scrub that keeps the variables naming an identity rather than a location, which decide what a fixture commit contains and so what it hashes to",
  ],
  [
    "pre-push and a work tree besides",
    (repository: Sacrificial) => ({ ...prePush(repository), GIT_WORK_TREE: repository.worktree }),
    "a scrub of the set a hook is known to carry rather than of the whole `GIT_` prefix",
  ],
] as const;

describe("a suite run from a git hook", () => {
  test.each(HOOKS)("leaves the repository it is acting on untouched: %s", async (_, set, kills) => {
    const repository = await sacrificial();
    const before = state(repository);

    const { code, said } = await runs(set(repository));

    // Both, and in this order. The repository is the guarantee; the exit status
    // is what catches an implementation that leaves it alone only because git
    // refused the environment it was handed — `GIT_WORK_TREE` surviving without
    // `GIT_DIR` is refused outright, so the third case reaches the child's own
    // failure rather than the repository state.
    expect(state(repository), kills).toEqual(before);
    expect(code, said).toBe(0);
  });
});
