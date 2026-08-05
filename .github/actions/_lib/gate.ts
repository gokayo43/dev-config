// oxlint-disable no-console -- stdout is the protocol: GitHub reads ::error and ::notice lines off it
//
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

/** Says something the log should carry but no build should fail over. */
export function notice(message: string): void {
  console.log(`::notice::${message}`);
}

/**
 * The inputs the calling action.yml promises to set. A missing one is a wiring
 * bug in the action, and a gate that defaults it silently grades every repo
 * against a contract nobody chose.
 */
export function inputs<const Names extends readonly string[]>(
  ...names: Names
): Record<Names[number], string> {
  const read = {} as Record<Names[number], string>;
  for (const name of names) {
    const variable = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    const value = Bun.env[variable];
    if (value === undefined) throw new Error(`${variable} is not set — the action must pass it`);
    read[name as Names[number]] = value;
  }
  return read;
}

/** Where a manifest may declare a package. */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** A space-separated action input, as a list. */
export function list(value: string): string[] {
  return value.split(/\s+/).filter((entry) => entry !== "");
}

async function git(cwd: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return await proc.exited;
}

/**
 * Never a repo's own code, whatever its .gitignore says. `--others` lists
 * anything git would keep, so a repo whose .gitignore forgets node_modules
 * hands every gate tens of thousands of third-party files — and a gate that
 * denounces a dependency's dependency is worse than no gate. Excluded here, at
 * the one place every walking gate goes through, rather than in each of them.
 */
const NEVER = ":(exclude,glob)**/node_modules/**";

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
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...pathspecs,
      NEVER,
    ],
    { cwd: root, stdout: "pipe", stderr: "ignore" },
  );
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ls-files failed in ${root}`);
  const listed = stdout.split("\0").filter((path) => path !== "");
  const present = await Promise.all(listed.map((path) => Bun.file(`${root}/${path}`).exists()));
  return listed.filter((_, index) => present[index] === true);
}

interface Parsed<T> {
  readonly file: string;
  readonly value: T;
}

export interface Batch<T> {
  readonly read: Parsed<T>[];
  /** One per file that would not parse, naming it. */
  readonly problems: Problem[];
}

/**
 * Parses every file, each rescued on its own. A batch that threw would take
 * every finding the other files had already produced with it, and report a
 * parse error naming no file at all — which is the least useful diagnostic a
 * gate can emit.
 */
export async function parseEach<T>(
  root: string,
  files: readonly string[],
  parse: (text: string) => T,
  language: string,
): Promise<Batch<T>> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, value: parse(await Bun.file(`${root}/${file}`).text()) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { file, problem: { file, message: `is not valid ${language}: ${detail}` } };
      }
    }),
  );
  return {
    read: results.filter((result): result is Parsed<T> => "value" in result),
    problems: results.flatMap((result) => ("problem" in result ? [result.problem] : [])),
  };
}

export type Manifest = Parsed<Record<string, unknown>>;

// Every package.json in the repo, root and workspaces alike. A git pathspec
// matches a wildcard across "/", so the second pathspec below reaches any depth
// while still requiring the whole final path segment: "apps/my-package.json"
// does not match, and neither pathspec can return anything but a package.json.
export async function manifests(root: string): Promise<Batch<Record<string, unknown>>> {
  const files = await repoFiles(root, ["package.json", "*/package.json"]);
  return await parseEach(
    root,
    files,
    (text) => JSON.parse(text) as Record<string, unknown>,
    "JSON",
  );
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
