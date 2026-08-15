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
 * A message as a workflow command carries it.
 *
 * GitHub reads one command per line, so a newline inside a message ends the
 * annotation and offers whatever follows to the parser as a command in its own
 * right. The messages here quote what the gates read — a row out of a dump, a
 * line of a config, a path — so the text is not the gate author's to trust, and
 * a value holding `\n::add-mask::` would be obeyed rather than shown.
 *
 * Percent first, or the escapes the other two introduce would be escaped again
 * and arrive as `%250A`. Only the three characters GitHub decodes: this is its
 * encoding, and anything else escaped here arrives visibly wrong.
 */
function commanded(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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
        ? `::error::${commanded(problem.message)}`
        : `::error file=${problem.file}::${commanded(problem.message)}`,
    );
  }
  if (problems.length > 0) process.exitCode = 1;
}

/** Says something the log should carry but no build should fail over. */
export function notice(message: string): void {
  console.log(`::notice::${commanded(message)}`);
}

/**
 * The work a `*.main.ts` hands over, so that a gate which throws — an input the
 * action forgot to pass, a database refusing the connection, a file that is not
 * the shape it claims — reaches the log as the annotation GitHub renders on the
 * step rather than as a stack trace in the raw output.
 *
 * It exits rather than returning, because a gate that dies mid-read may be
 * holding something that keeps the runtime alive, and a step waiting on that
 * costs the job's whole timeout to say what it already knows.
 */
export async function entry(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * The inputs the calling action.yml promises to set. A missing one is a wiring
 * bug in the action, and a gate that defaults it silently grades every repo
 * against a contract nobody chose.
 */
export function inputs<const Names extends readonly string[]>(
  ...names: Names
): Record<Names[number], string> {
  const read = names.map((name) => {
    const variable = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    const value = Bun.env[variable];
    if (value === undefined) throw new Error(`${variable} is not set — the action must pass it`);
    return [name, value];
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries answers a string-keyed record; that its keys are exactly `names` is what the signature promises and what no inference can express
  return Object.fromEntries(read) as Record<Names[number], string>;
}

/**
 * An environment variable the calling job owns, refused rather than defaulted.
 * The reason travels with the call because two gates reading one variable are
 * left holding different things when it is missing, and each should say which.
 */
export function required(name: string, why: string): string {
  const value = Bun.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set — ${why}`);
  return value;
}

/** Where a manifest may declare a package. */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * A config file's top level, decoded and no further. Every gate here reads
 * files it does not own — another repo's package.json, compose file,
 * lefthook.yml, bunfig.toml — so the keys are whatever that repo wrote, and
 * each check names and validates the ones it needs where it reads them. A
 * modelled type here would have to be every valid and invalid config in the
 * fleet at once, and would claim about the file exactly what is not checked yet.
 */
// oxlint-disable-next-line typescript/no-restricted-types, anti-slop/no-unsafe-dictionary-type -- the one boundary this alias exists for; every gate reads config through it rather than restating it
export type ConfigObject = Record<string, unknown>;

export function record(value: unknown): ConfigObject {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the check on the left is the evidence: an object that is not null is exactly what the alias claims, and nothing narrower is claimed about its keys
  return typeof value === "object" && value !== null ? (value as ConfigObject) : {};
}

/**
 * Whether there is an object here at all. `record` reads a field off whatever
 * it is handed; this is for the boundary that has to refuse the value instead,
 * because nothing below it can say anything true about a config that is `null`.
 */
export function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What was there instead, for a diagnostic that has to say what it refused. */
export function kindOf(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The value as one of a fixed vocabulary, or nothing. `includes` on a `const`
 * tuple does not narrow the value, and an assertion to make it narrow is the
 * thing worth avoiding — so the find *is* the narrowing, and each caller
 * decides for itself whether absent is a problem to report or an input to
 * refuse outright.
 */
export function oneOf<const Name extends string>(
  names: readonly Name[],
  value: unknown,
): Name | undefined {
  return names.find((name) => name === value);
}

/** A space-separated action input, as a list. */
export function list(value: string): string[] {
  return value.split(/\s+/).filter((item) => item !== "");
}

/** The separator oxlint uses between a suppression and its reason, and every allowlist here follows it. */
export const REASON = " -- ";

/**
 * One entry per line — not space-separated, because an entry contains spaces: a
 * quoted SQL identifier, the method and path of a route, and the reason each of
 * them carries.
 *
 * A newline is the only separator, here and in `capacity-path` — every input
 * whose entries are expected to hold a space. (`list` above splits on
 * whitespace, and serves the inputs written as single words: contract
 * exemptions, fixture paths, the pin gate's extra paths. A path with a space in
 * it cannot be expressed there at all, which is a limit of that form rather
 * than a fact about paths.) The reason
 * is prose, prose contains commas, and an entry that ended at one would be
 * graded as two: a subject stripped of the reason written for it, and half a
 * sentence read as a subject nobody wrote. Two diagnostics, both true of an
 * input nobody typed.
 */
function entriesIn(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * A gate takes one of these whole rather than its `entries`: the reason on each
 * entry is enforced by reporting `problems`, and a signature that accepted the
 * list alone would let a caller typecheck while dropping that half.
 *
 * The rule that an entry standing for nothing is refused belongs to every
 * allowlist here, but only two of them can be handed the subjects whole:
 * `deadEntries` below is those two. route-coverage stays out because its
 * entries are not the thing it compares — they are parsed into a method and a
 * path first, with a diagnostic of its own for one that is not a route at all,
 * and the comparison is against a normalised key, so `options /*` and
 * `OPTIONS /*` are one route and neither is a member of any set of entry
 * spellings. Its classifier is in route-coverage.ts, which is where the parse
 * that makes it different lives.
 */
export interface Allowlist {
  /** Each entry with its reason stripped: the part a gate compares against. */
  readonly entries: string[];
  /**
   * The subjects behind `problems`, so that a gate with a second rule about an
   * entry can leave the ones already refused alone: an entry the reader is
   * being sent back to anyway earns one diagnostic, not two. A set, because
   * every one of those gates asks it the same question — is this entry one of
   * them — and three copies of `new Set(...)` is three chances to forget.
   */
  readonly unreasoned: ReadonlySet<string>;
  /** One per entry that waives something and says nothing about why. */
  readonly problems: Problem[];
}

/**
 * An allowlist input, as the list a gate compares against plus what is wrong
 * with it. Every entry carries `-- why`, the same price a lint directive pays:
 * an exemption whose reason nobody had to write is one nobody has to justify,
 * and a year later it is indistinguishable from a bug someone silenced.
 *
 * A reasonless entry still waives its subject — the gate fails on the missing
 * reason, and reporting the waived subject as well would be two diagnostics for
 * one mistake.
 */
export function allowlistFrom(value: string, input: string): Allowlist {
  const read = entriesIn(value).map((item) => {
    const [subject = "", ...reason] = item.split(REASON);
    return { subject: subject.trim(), reasoned: reason.join(REASON).trim() !== "" };
  });

  const unreasoned = read.filter(({ reasoned }) => !reasoned).map(({ subject }) => subject);

  return {
    entries: read.map(({ subject }) => subject),
    unreasoned: new Set(unreasoned),
    problems: unreasoned.map((subject) => ({
      message: `${input} waives ${subject} without saying why — write '${subject}${REASON}<reason>', the same price a lint directive pays`,
    })),
  };
}

/**
 * The waivers standing for nobody, and which of the two ways each got there.
 *
 * Two gates ask exactly this and in the same order: stack-gate, of a package
 * the denylist has stopped answering for, and the timestamptz gate, of a column
 * that is no longer a wall-clock one. Subtract what the gate still grades,
 * subtract the entries already refused for carrying no reason, then pick
 * between two messages. One decision, so one place.
 *
 * `live` is what the gate still grades: a subject in it is a waiver doing its
 * job. `known` is everything the gate can see at all, and the difference
 * between the two is the difference between an entry to drop and a name to fix
 * — sending the first case name-hunting is how a retired rule costs every
 * consumer an afternoon.
 *
 * An entry with no reason is asked none of this: its author is going back to
 * that line regardless, and one mistake earns one diagnostic.
 */
export function deadEntries(
  allowlist: Allowlist,
  live: ReadonlySet<string>,
  known: ReadonlySet<string>,
  message: (subject: string, stillKnown: boolean) => string,
): Problem[] {
  return [...new Set(allowlist.entries)]
    .filter((subject) => !live.has(subject) && !allowlist.unreasoned.has(subject))
    .map((subject) => ({ message: message(subject, known.has(subject)) }));
}

/** A git invocation's exit status and what it wrote. */
export interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * git, for every gate that reads a tree or a history. Failure comes back rather
 * than thrown, because to most of what is asked here "no" is the answer — a
 * path that is not tracked, a lineage the base ref did not carry — and the one
 * caller that cannot go on without an answer says so itself.
 */
export async function git(cwd: string, args: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, stdout };
}

/** What the run knows about where it came from, which is all a base ref can be derived from. */
export interface Event {
  /** `github.base_ref`: the branch a pull request targets, empty off one. */
  readonly baseRef: string;
  /** `github.event.before`: the tip the branch had before this push, empty or all-zero otherwise. */
  readonly before: string;
}

/**
 * What a checkout could not supply, because the two are not the same kind of
 * problem and callers scope their refusals differently.
 *
 * `history` is what a shallow clone — or a directory that is no repository —
 * does not have. It is a property of how the run checked the repo out, and a
 * gate may reasonably decide that some repos never needed it.
 *
 * `ref` is a commit this run itself names and this checkout does not carry.
 * That is a broken run rather than a fact about the repo, so reading it as
 * "nothing to compare against" is reading a misconfiguration as a verdict.
 */
export type Missing = "history" | "ref";

/**
 * The commit a gate compares this tree against, or why this checkout cannot
 * name one.
 *
 * The two are kept apart because "there is no earlier commit" and "this
 * checkout cannot say" look identical from inside and mean opposite things —
 * the first is an honest pass, the second is a gate that would pass by having
 * been handed nothing. How fatal the second is belongs to the caller, which is
 * what `missing` is for.
 */
export type Base =
  /** The commit; `undefined` where the run genuinely has none before it. */
  | { readonly rev: string | undefined }
  /** The whole diagnostic, and what was missing, for a caller that scopes its refusals. */
  | { readonly refused: string; readonly missing: Missing };

/**
 * The commit this tree's state is compared against.
 *
 * On a pull request the checkout is GitHub's merge commit by default — this
 * branch merged into the base branch's tip — so the merge base with that branch
 * is the tip itself, with whatever the base branch grew meanwhile already in
 * it. A repo that checks out the pull request's head instead gets the fork
 * point from the same command, which is the same statement about the checkout
 * it has. On a push it is the tip the branch had before; where the event names
 * none — a branch's first push, a merge queue — the parent commit is the same
 * statement.
 *
 * `why` travels with the call, for the reason it does on `required`: two gates
 * reading one history are left holding different things when it is missing, and
 * each should say what it wanted it for.
 */
export async function baseRevision(root: string, event: Event, why: string): Promise<Base> {
  // Also what establishes that this is a repository at all: outside one the
  // command fails, and reading its empty output as "not shallow" would let
  // every git question below answer "no" and the whole check pass.
  const shallow = await git(root, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok) {
    return {
      refused: `could not establish whether this checkout has history: \`git rev-parse --is-shallow-repository\` failed in ${root} — ${why}, and a checkout it cannot read is refused rather than read as having none`,
      missing: "history",
    };
  }
  if (shallow.stdout.trim() === "true") {
    return {
      refused: `the checkout is shallow, so the base ref is not in it — ${why}; check out with fetch-depth: 0`,
      missing: "history",
    };
  }

  if (event.baseRef !== "") {
    const base = `refs/remotes/origin/${event.baseRef}`;
    const merged = await git(root, ["merge-base", base, "HEAD"]);
    if (!merged.ok) {
      return {
        refused: `${base} is not in this checkout, so there is nothing to take the merge base with — ${why}; check out with fetch-depth: 0`,
        missing: "ref",
      };
    }
    return { rev: merged.stdout.trim() };
  }

  if (event.before !== "" && (await git(root, ["cat-file", "-e", `${event.before}^{commit}`])).ok) {
    return { rev: event.before };
  }
  const parent = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
  return { rev: parent.ok ? parent.stdout.trim() : undefined };
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
  const listing = await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspecs,
    NEVER,
  ]);
  if (!listing.ok) throw new Error(`git ls-files failed in ${root}`);
  const listed = listing.stdout.split("\0").filter((path) => path !== "");
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

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- `ConfigObject` above is the boundary; this names the file kind that carries it, and resolves to the same one alias
export type Manifest = Parsed<ConfigObject>;

/**
 * Every parsed file as the object a config's top level has to be. `JSON.parse`
 * answers `null`, a number or an array as readily as an object, and every
 * reader downstream goes straight to a field — so the shape is settled here,
 * where the file can still be named, rather than as a TypeError inside whichever
 * check reached the value first. It takes the batch rather than the paths
 * because the dialect differs by file — `package.json` is strict JSON, an
 * oxlint or TypeScript config is JSON with comments — and this answer does not.
 */
export function objectsIn(parsed: Batch<unknown>): Batch<ConfigObject> {
  const read: Manifest[] = [];
  const problems = [...parsed.problems];
  for (const { file, value } of parsed.read) {
    if (isObject(value)) {
      read.push({ file, value });
    } else {
      problems.push({ file, message: `is not a JSON object — the top level is ${kindOf(value)}` });
    }
  }
  return { read, problems };
}

// Every package.json in the repo, root and workspaces alike. A git pathspec
// matches a wildcard across "/", so the second pathspec below reaches any depth
// while still requiring the whole final path segment: "apps/my-package.json"
// does not match, and neither pathspec can return anything but a package.json.
export async function manifests(root: string): Promise<Batch<ConfigObject>> {
  const files = await repoFiles(root, ["package.json", "*/package.json"]);
  return objectsIn(await parseEach(root, files, (text) => JSON.parse(text) as unknown, "JSON"));
}

export async function isTracked(root: string, path: string): Promise<boolean> {
  return (await git(root, ["ls-files", "--error-unmatch", "--", path])).ok;
}

/**
 * Whether .gitignore's patterns cover the path. `--no-index` is what makes this
 * a question about the patterns: without it git answers "no" for anything
 * already tracked, which is precisely the file whose rule nobody has noticed is
 * wrong until the day it is untracked.
 */
export async function isIgnored(root: string, path: string): Promise<boolean> {
  return (await git(root, ["check-ignore", "--no-index", "-q", "--", path])).ok;
}
