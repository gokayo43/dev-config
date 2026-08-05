import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A repository as a map of path to contents. Absent means the file is not there. */
export type Tree = Record<string, string>;

/**
 * Materialises a tree as a real git repository, because the gates ask git what
 * is tracked and what is ignored. Nothing is committed: the answer for an
 * untracked-but-not-ignored file is part of what they read, and a scaffolder
 * has just written exactly those.
 */
export async function materialise(tree: Tree, tracked: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gate-"));
  for (const [path, contents] of Object.entries(tree)) {
    await Bun.write(join(root, path), contents);
  }
  await run(root, ["init", "--quiet", "--initial-branch=main"]);
  if (tracked.length > 0) {
    await run(root, ["add", "--force", "--", ...tracked]);
  }
  return root;
}

export async function discard(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Tracks a file and then deletes it, which is what a scaffolder that removes itself leaves behind. */
export async function trackThenDelete(root: string, path: string): Promise<void> {
  await run(root, ["add", "--force", "--", path]);
  await rm(join(root, path), { recursive: true, force: true });
}

async function run(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

/** A copy of `tree` with one file removed — one defect per case. */
export function without(tree: Tree, path: string): Tree {
  return Object.fromEntries(Object.entries(tree).filter(([each]) => each !== path));
}
