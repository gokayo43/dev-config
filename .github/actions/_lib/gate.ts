// Shared by every gate script under .github/actions. GitHub checks the whole
// repository out to run an action, so a script may import across action
// directories; only the directory named in `uses:` is the action itself.

/** One violation, addressed to the file that has to change. */
export interface Problem {
  readonly file?: string;
  readonly message: string;
}

/**
 * Annotates every problem and fails the step once. A gate that exits at the
 * first violation costs a full CI round-trip per fix, and a bare non-zero exit
 * points at the workflow rather than at the line that has to change.
 */
export function report(problems: readonly Problem[]): void {
  for (const problem of problems) {
    console.log(
      problem.file === undefined
        ? `::error::${problem.message}`
        : `::error file=${problem.file}::${problem.message}`,
    );
  }
  if (problems.length > 0) process.exitCode = 1;
}

async function git(cwd: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return await proc.exited;
}

/**
 * The files a gate looks at: what is on disk, minus what .gitignore describes.
 * Gates run against trees a scaffolder has just written into, where the new
 * files are untracked, and beside build output that must stay out — so the
 * listing is git's rather than a walk of the filesystem.
 *
 * The existence filter is the other half of that: `--cached` still lists a file
 * deleted from the worktree, which is precisely what a scaffolder that removes
 * itself leaves behind.
 */
export async function repoFiles(root: string, pathspecs: readonly string[]): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
    { cwd: root, stdout: "pipe", stderr: "ignore" },
  );
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ls-files failed in ${root}`);
  const listed = stdout.split("\0").filter((path) => path !== "");
  const present = await Promise.all(listed.map((path) => Bun.file(`${root}/${path}`).exists()));
  return listed.filter((_, index) => present[index] === true);
}

export async function isTracked(root: string, path: string): Promise<boolean> {
  return (await git(root, ["ls-files", "--error-unmatch", "--", path])) === 0;
}

/**
 * Whether .gitignore's patterns cover the path. `--no-index` is what makes this
 * a question about the patterns: without it git answers "no" for anything
 * already tracked, which is precisely the file whose rule nobody has noticed is
 * wrong until the day it is untracked.
 */
export async function isIgnored(root: string, path: string): Promise<boolean> {
  return (await git(root, ["check-ignore", "--no-index", "-q", "--", path])) === 0;
}
