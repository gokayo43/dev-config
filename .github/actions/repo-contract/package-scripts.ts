/**
 * What a command runs, once the package scripts it reaches are followed.
 *
 * Its own module because it is its own subject: nothing here knows what a
 * lifecycle is or which program the caller is looking for — it answers, of a
 * string somebody wrote in a workflow, whether that string ends up running a
 * given program, and it is the half a test can drive with a manifest and two
 * lines of shell.
 *
 * ## Why a workflow's text is read at all
 *
 * Everything else the repo contract asks of `ci.yml` it reads off the *call*
 * into `check.yml`, deliberately: a repo can write the words of a gate in a
 * comment, and only the call is the fact. The browser suite cannot be read that
 * way, and not for want of an input. `check.yml`'s only app-booting job is the
 * database job, which never runs for the static sites this rule is mostly
 * about, and a browser suite needs *this* repo's app booted with *its* browsers
 * against *its* fixtures. So the run is a job the repo owns, and the only place
 * the fact lives is that job's own steps — which is why the reading below is as
 * careful as it is.
 *
 * A command is read as a shell reads one: as commands, each with a head. The
 * ordinary Playwright job installs a browser and prints advice —
 * `playwright install --with-deps chromium`, `echo "run playwright test to
 * reproduce"` — so a word list flattened across every `&&`, `;`, `|` and
 * newline, or a program matched anywhere in it, answers yes to a job that runs
 * no suite at all.
 */
import { posix } from "node:path";

import { type Manifest, record } from "../_lib/gate.ts";

/** A package script a command runs, and the manifest that has to hold it — any of them, where the runner selects across the workspace. */
interface Invocation {
  readonly script: string;
  readonly file: string | undefined;
}

/**
 * One program with the argument that has to follow it, which is what tells
 * `playwright test` from `playwright install`, and the flags that have to come
 * after that argument, which is what tells `bun check --no-script` from a
 * `bun check` that runs the repo's own `check` script instead.
 */
export interface Invoked {
  readonly program: string;
  readonly argument: string;
  readonly flags: readonly string[];
}

const ROOT_MANIFEST = "package.json";

const BUN = "bun";

const TURBO = "turbo";

/**
 * The flags that take a value, and what the value says about which manifest
 * holds the script. Every one of them has to be consumed with its value, or the
 * value is read as the script name and a real suite is reported missing:
 * `bun run --filter web test:e2e` would be a run of the script `web`.
 *
 * `--cwd` names one directory, relative to the one the command runs in, so the
 * script is that manifest's. `--filter` (bun's `-F`) selects across the
 * workspace, so the script is whichever manifest declares it — the same answer
 * `turbo run` gets, for the same reason.
 */
const VALUE_FLAGS = new Map<string, (value: string, here: string) => string | undefined>([
  ["--cwd", (value, here) => manifestIn(posix.join(here, value))],
  ["--filter", () => undefined],
  ["-F", () => undefined],
]);

/** The manifest a runner pointed at a directory reads its scripts from. */
function manifestIn(directory: string): string {
  const written = directory.replace(/\/+$/, "");
  return written === "" || written === "." ? ROOT_MANIFEST : `${written}/${ROOT_MANIFEST}`;
}

/**
 * Whether this word invokes that program. The trailing segment, so a binary run
 * out of `node_modules/.bin` is the same program as one on the PATH — and whole
 * segments, so `pre-playwright` is not.
 */
function invokes(word: string, program: string): boolean {
  return word === program || word.endsWith(`/${program}`);
}

/**
 * The commands a `run:` block holds, each as its words. A shell ends a command
 * at a newline, a `;`, a pipe and either `&`, and everything after a `#` is
 * prose — so this is the list of things that actually get executed, and the
 * head of each is the program that runs.
 */
function commandsOf(block: string): string[][] {
  return block
    .split(/[\n;|&]+/)
    .map((command) => {
      const words = command.split(/\s+/).filter((word) => word !== "");
      const comment = words.findIndex((word) => word.startsWith("#"));
      return comment === -1 ? words : words.slice(0, comment);
    })
    .filter((words) => words.length > 0);
}

/**
 * The command with its leading environment assignments dropped. `CI=1 playwright
 * test` runs playwright, and the head of that command is the assignment.
 */
function atTheHead(words: readonly string[]): readonly string[] {
  const first = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return first === -1 ? [] : words.slice(first);
}

/**
 * The command past the one wrapper a program is legitimately run behind here:
 * `bunx <program>` and its `bun x` spelling, which resolve a binary and hand it
 * the rest of the line.
 */
function unwrapped(words: readonly string[]): readonly string[] {
  if (words[0] !== undefined && invokes(words[0], "bunx")) return words.slice(1);
  if (words[0] !== undefined && invokes(words[0], BUN) && words[1] === "x") return words.slice(2);
  return words;
}

/**
 * Whether this command runs that program with that argument and those flags, at
 * its head where a program runs.
 */
function runsAtHead(words: readonly string[], { program, argument, flags }: Invoked): boolean {
  const [head, next, ...rest] = unwrapped(words);
  return (
    head !== undefined &&
    invokes(head, program) &&
    next === argument &&
    flags.every((flag) => rest.includes(flag))
  );
}

/**
 * The script a runner invocation names: the first word after it that is neither
 * a flag nor its own `run`, with every value-taking flag consumed along with
 * its value in both the `--flag value` and `--flag=value` spellings. `here` is
 * the directory the command runs in, which a relative `--cwd` starts from.
 */
function scriptAfter(
  after: readonly string[],
  from: string | undefined,
  here: string,
): Invocation | undefined {
  const rest = [...after];
  let file = from;
  for (let word = rest.shift(); word !== undefined; word = rest.shift()) {
    const equals = word.indexOf("=");
    const takes = VALUE_FLAGS.get(equals === -1 ? word : word.slice(0, equals));
    if (takes !== undefined) {
      const value = equals === -1 ? rest.shift() : word.slice(equals + 1);
      if (value !== undefined) file = takes(value, here);
      continue;
    }
    if (word === "run" || word.startsWith("-")) continue;
    return { script: word, file };
  }
  return undefined;
}

/**
 * The package script this command runs, where its head is one of the two
 * runners this house runs one with. `bun` reads the scripts of the manifest the
 * command was read from, since a package script runs in its own package's
 * directory, unless a flag moves it; `turbo` runs the task in whichever
 * workspace declares one.
 */
function invocationAt(words: readonly string[], from: string): Invocation | undefined {
  const [head, ...after] = words;
  if (head === undefined) return undefined;
  const here = posix.dirname(from);
  if (invokes(head, BUN)) return scriptAfter(after, from, here);
  if (invokes(head, TURBO)) return scriptAfter(after, undefined, here);
  return undefined;
}

/** `from` is the manifest whose directory the block runs in. */
function reaches(
  block: string,
  invoked: Invoked,
  all: readonly Manifest[],
  seen: Set<string>,
  from: string,
): boolean {
  return commandsOf(block).some((command) => {
    const words = atTheHead(command);
    if (runsAtHead(words, invoked)) return true;
    const call = invocationAt(words, from);
    return call !== undefined && scriptReaches(call, invoked, all, seen);
  });
}

/**
 * The same question of a script, in the manifest that has to declare it. `seen`
 * is what makes a script calling itself terminate here rather than as the stack
 * overflow the run it describes would have been.
 */
function scriptReaches(
  { script, file }: Invocation,
  invoked: Invoked,
  all: readonly Manifest[],
  seen: Set<string>,
): boolean {
  return all.some(({ file: where, value }) => {
    if (file !== undefined && where !== file) return false;
    const command = record(value["scripts"])[script];
    const key = `${where} ${script}`;
    if (typeof command !== "string" || seen.has(key)) return false;
    seen.add(key);
    return reaches(command, invoked, all, seen, where);
  });
}

/**
 * Whether this command runs that program with that argument and those flags —
 * directly, or through a package script that reaches it. Scripts chain (`e2e`
 * runs `test:e2e:ci` runs the binary), so the walk follows them across every
 * manifest in the workspace. The command itself runs at the repository root,
 * where a workflow step and check.yml's lanes run.
 */
export function runsProgram(command: string, invoked: Invoked, all: readonly Manifest[]): boolean {
  return reaches(command, invoked, all, new Set(), ROOT_MANIFEST);
}
