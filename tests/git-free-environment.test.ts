/**
 * The suite, run the way a git hook runs it, against a repository it must not
 * touch. lefthook's `pre-push` runs `bun test`, and git hands every hook the
 * location of the repository it is acting on — so the fixtures' own
 * `git init` / `git add` / `git commit` land in that repository instead of in
 * the temp directory they were given, which is how a push once rewrote its own
 * branch into `commit 0`, `commit 1` and flipped `core.bare` to `true`.
 *
 * Observed from outside: a `bun test` child is given the hook's variables
 * pointed at a sacrificial repository this case builds, and what is graded is
 * that repository afterwards. Grading it from inside would ask the damaged
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
 */
async function reads(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, bad] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return ((await proc.exited) === 0 ? out : bad).trim();
}

interface Sacrificial {
  /** What the hook would put in `GIT_DIR`: a linked worktree's git dir, which is where the incident's was. */
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
async function state(repository: Sacrificial): Promise<Record<string, string>> {
  const { main, worktree } = repository;
  return {
    head: await reads(worktree, ["rev-parse", "HEAD"]),
    branch: await reads(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    log: await reads(worktree, ["log", "--oneline"]),
    tracked: await reads(worktree, ["ls-tree", "-r", "--name-only", "HEAD"]),
    index: await reads(worktree, ["status", "--porcelain"]),
    reflog: await reads(worktree, ["reflog", "show", "probe"]),
    bare: await reads(main, ["config", "--get", "core.bare"]),
  };
}

/**
 * A test file that commits through every spawn shape the suite uses: the shared
 * fixture builder, which hands `Bun.spawn` an `env` of its own, and a bare
 * `Bun.spawn` in each of its two call forms, which hand it none. The second
 * group is the half a scrub of `process.env` alone does not reach.
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

describe("a suite run from a git hook", () => {
  test("leaves the repository the hook is acting on untouched", async () => {
    const repository = await sacrificial();
    const before = await state(repository);

    // Exactly what git exports to a `pre-commit` run from a linked worktree,
    // probed against git 2.43: the location absolute, the index beside it.
    const { code, said } = await runs({
      GIT_DIR: repository.gitDir,
      GIT_INDEX_FILE: join(repository.gitDir, "index"),
      GIT_PREFIX: "",
      GIT_EXEC_PATH: "/usr/lib/git-core",
      GIT_EDITOR: ":",
    });

    expect(await state(repository)).toEqual(before);
    expect(code, said).toBe(0);
  });

  test("leaves it untouched when the hook also exports a work tree", async () => {
    const repository = await sacrificial();
    const before = await state(repository);

    // `GIT_WORK_TREE` is not in the set git exports to a hook, and is here
    // because an implementation that removed that set rather than the whole
    // `GIT_` prefix would pass the case above and commit here.
    const { code, said } = await runs({
      GIT_DIR: repository.gitDir,
      GIT_INDEX_FILE: join(repository.gitDir, "index"),
      GIT_WORK_TREE: repository.worktree,
      GIT_PREFIX: "",
    });

    expect(await state(repository)).toEqual(before);
    expect(code, said).toBe(0);
  });
});
