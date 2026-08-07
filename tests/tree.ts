import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A repository as a map of path to contents. Absent means the file is not there. */
export type Tree = Record<string, string>;

const live: string[] = [];

// Registered once, here, rather than copied into every suite: a new case cannot
// forget the cleanup, and a forgotten one leaves a git repository per test
// behind in the temp directory.
afterEach(async () => {
  await Promise.all(live.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Materialises a tree as a real git repository, because the gates ask git what
 * is tracked and what is ignored. Nothing is committed: the answer for an
 * untracked-but-not-ignored file is part of what they read, and a scaffolder
 * has just written exactly those.
 */
export async function materialise(tree: Tree, tracked: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gate-"));
  live.push(root);
  for (const [path, contents] of Object.entries(tree)) {
    await Bun.write(join(root, path), contents);
  }
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  if (tracked.length > 0) await git(root, ["add", "--force", "--", ...tracked]);
  return root;
}

/** Tracks a file and then deletes it, which is what a scaffolder that removes itself leaves behind. */
export async function trackThenDelete(root: string, path: string): Promise<void> {
  await git(root, ["add", "--force", "--", path]);
  await rm(join(root, path), { recursive: true, force: true });
}

/** A copy of `tree` with one file removed — one defect per case. */
export function without(tree: Tree, path: string): Tree {
  return Object.fromEntries(Object.entries(tree).filter(([each]) => each !== path));
}

/** A tree written under a directory, the way a monorepo holds a project. */
export function under(prefix: string, tree: Tree): Tree {
  return Object.fromEntries(
    Object.entries(tree).map(([path, contents]) => [`${prefix}/${path}`, contents]),
  );
}

export interface Repo {
  readonly root: string;
  /** Every commit in order, so a case can name the one it expects to be compared against. */
  readonly revs: string[];
}

/** Committer identity, so a fixture does not depend on whatever the machine running it has configured. */
export const IDENTITY = ["-c", "user.email=gate@example.com", "-c", "user.name=gate"];

/**
 * A repository whose history is the trees given, one commit each. A tree
 * replaces the one before it, so a commit that moves or drops a file is written
 * the way it reads: by not mentioning it.
 *
 * `git add --all` stages what .gitignore does not describe, which is the same
 * set the gates read — so a fixture's ignored files stay ignored across the
 * history instead of being committed by the setup.
 *
 * `--allow-empty` because a commit that changes nothing is a real thing to grade
 * against: a case about a field that did not move wants two commits that agree,
 * and making them differ somewhere irrelevant would be the fixture inventing a
 * second variable to get past its own setup.
 */
export async function history(...trees: readonly Tree[]): Promise<Repo> {
  const [first = {}, ...rest] = trees;
  const root = await materialise(first);
  const revs: string[] = [];
  let previous: Tree = first;
  for (const tree of [first, ...rest]) {
    if (tree !== first) {
      for (const path of Object.keys(previous)) {
        if (!(path in tree)) await rm(join(root, path), { force: true });
      }
      for (const [path, contents] of Object.entries(tree)) {
        await Bun.write(join(root, path), contents);
      }
      previous = tree;
    }
    await git(root, ["add", "--all"]);
    await git(root, [
      ...IDENTITY,
      "commit",
      "--quiet",
      "--allow-empty",
      "--message",
      `commit ${revs.length}`,
    ]);
    revs.push((await git(root, ["rev-parse", "HEAD"])).trim());
  }
  return { root, revs };
}

/**
 * git against one of these repositories, refusing rather than reporting: a
 * fixture whose setup half-failed grades the gate against a tree nobody wrote.
 * Exported because a gate that reads history needs fixtures that have one.
 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
  return stdout;
}
