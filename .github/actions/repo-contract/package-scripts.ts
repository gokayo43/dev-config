/**
 * What a command runs, once the package scripts it reaches are followed.
 *
 * Its own module because it is its own subject: nothing here knows what a
 * lifecycle is or which program the caller is looking for — it answers, of a
 * string somebody wrote in a workflow, whether that string ends up running a
 * given program, and it is the half a test can drive with a manifest and two
 * lines of shell. `live.ts` is where the question is asked, and it is long
 * enough already without the reading.
 *
 * Read by words rather than by text, everywhere: what is being asked is which
 * *program* runs with which argument, and a workflow that mentions a binary is
 * the ordinary case — `playwright install --with-deps chromium` installs a
 * browser and runs no suite, a `#` line runs nothing at all, and a script whose
 * NAME carries the word runs whatever its command says.
 */
import { type Manifest, record } from "../_lib/gate.ts";

/** A package script a command runs, and the manifest that has to hold it — any of them, where the runner searches the workspace. */
interface Invocation {
  readonly script: string;
  readonly file: string | undefined;
}

const ROOT_MANIFEST = "package.json";

const CWD = "--cwd";

const BUN = "bun";

const TURBO = "turbo";

/** The manifest a runner pointed at a directory reads its scripts from. */
function manifestIn(directory: string): string {
  return `${directory.replace(/^\.\//, "").replace(/\/$/, "")}/${ROOT_MANIFEST}`;
}

/**
 * Whether this word invokes that program. The trailing segment, so a binary run
 * out of `node_modules/.bin` is the same program as one on the PATH — and whole
 * segments, so `pre-playwright` is not.
 */
function invokes(word: string, program: string): boolean {
  const written = word.replace(/^\.\//, "");
  return written === program || written.endsWith(`/${program}`);
}

/**
 * The words a command runs, comments dropped. Split on what a shell ends a
 * command at, so that a chain is as many commands as it is written as — and a
 * `#` ends its line, because everything after it is prose.
 */
function wordsOf(command: string): string[] {
  return command.split("\n").flatMap((line) => {
    const words = line.split(/[\s;|&]+/).filter((word) => word !== "");
    const comment = words.findIndex((word) => word.startsWith("#"));
    return comment === -1 ? words : words.slice(0, comment);
  });
}

/**
 * The script a runner invocation names: the first word after it that is neither
 * a flag nor its own `run`. `file` is the manifest the runner reads scripts
 * from — the root for `bun`, whatever `--cwd` moved it to, and nothing at all
 * for `turbo`, which runs the task in whichever workspace declares one.
 */
function scriptAfter(rest: readonly string[], from: string | undefined): Invocation | undefined {
  let file = from;
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at] ?? "";
    if (word === CWD || word.startsWith(`${CWD}=`)) {
      file = manifestIn(word === CWD ? (rest[at + 1] ?? "") : word.slice(CWD.length + 1));
      if (word === CWD) at += 1;
      continue;
    }
    if (word === "run" || word.startsWith("-")) continue;
    return { script: word, file };
  }
  return undefined;
}

/** Every package script these words reach, through the two runners this house runs one with. */
function invocationsIn(words: readonly string[]): Invocation[] {
  const found: Invocation[] = [];
  for (const [at, word] of words.entries()) {
    if (!invokes(word, BUN) && !invokes(word, TURBO)) continue;
    const call = scriptAfter(words.slice(at + 1), invokes(word, BUN) ? ROOT_MANIFEST : undefined);
    if (call !== undefined) found.push(call);
  }
  return found;
}

/** One program with the argument that has to follow it, which is what tells `playwright test` from `playwright install`. */
interface Invoked {
  readonly program: string;
  readonly argument: string;
}

function reaches(
  command: string,
  invoked: Invoked,
  all: readonly Manifest[],
  seen: Set<string>,
): boolean {
  const words = wordsOf(command);
  if (
    words.some((word, at) => invokes(word, invoked.program) && words[at + 1] === invoked.argument)
  ) {
    return true;
  }
  return invocationsIn(words).some((call) => scriptReaches(call, invoked, all, seen));
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
    return reaches(command, invoked, all, seen);
  });
}

/**
 * Whether this command runs that program with that argument — directly, or
 * through a package script that reaches it. Scripts chain (`e2e` runs
 * `test:e2e:ci` runs the binary), so the walk follows them across every
 * manifest in the workspace.
 */
export function runsProgram(
  command: string,
  program: string,
  argument: string,
  all: readonly Manifest[],
): boolean {
  return reaches(command, { program, argument }, all, new Set());
}
