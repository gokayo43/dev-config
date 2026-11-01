/**
 * Every line a branch wrote, per file — what "this branch" means to every gate
 * that holds a branch to its own lines rather than to the whole tree.
 *
 * Here rather than beside either of them, because a second action reads it.
 * The mutation lane fails on a mutant only where every line it spans is one the
 * branch wrote; the duplicate-code gate fails on a clone only where the branch
 * wrote one of its lines. Two readings of one diff would be two answers to what
 * the branch did, and the day they disagreed one gate would hold a pull request
 * to lines the other said it never touched.
 */
import {
  baseRevision,
  type Event,
  git,
  NOT_A_DEPENDENCY,
  type Problem,
  type Verdict,
} from "./gate.ts";

/** Where a hunk header says the lines it added start, and how many there are. */
const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

/**
 * The line that opens a file's section, and the one that names it. Read in that
 * order because only the first is safe on its own: every line of diff content
 * carries a `+`, `-` or space in column one, so nothing in a file's body can
 * begin `diff --git ` — while an added line reading `++ b/x` renders exactly as
 * a `+++ b/` header does.
 */
const OPENS = "diff --git ";
const NAMES = "+++ b/";

interface Changed {
  /** Every line this branch wrote, per file the caller keeps. */
  readonly changed: Map<string, Set<number>>;
  /** One per section whose file could not be named. */
  readonly problems: Problem[];
}

/**
 * Every line this branch wrote, per file under `pathspecs` that `keeps` accepts
 * — one diff, which is the whole of what "changed" means. The same map answers
 * both questions a gate asks of it: its keys are the files the gate grades, and
 * its values are what a finding is measured against, so the two cannot disagree
 * about what the change was.
 *
 * `--unified=0` is what makes the answer lines rather than neighbourhoods: with
 * context the hunk header covers untouched lines either side, and a finding
 * sitting in one of them would be reported as something this branch introduced.
 * `--diff-filter=d` drops what the branch deleted, since a gate is handed paths
 * to read. `--relative` makes both the pathspec and the reported paths the
 * working directory's rather than the repository root's, which is the same
 * statement the repo contract and the upgrade gate make with `<rev>:./path`: a
 * monorepo's project sits below the root, and a path measured from the root
 * would be one the gate cannot resolve from the project.
 */
async function changeSet(
  root: string,
  rev: string,
  pathspecs: readonly string[],
  keeps: (path: string) => boolean,
): Promise<Changed> {
  const diff = await git(root, [
    // Every setting below shapes the text this function then reads back, and
    // each of them is one a developer sets for themselves and forgets. A gate
    // whose answer depends on the reader's `~/.gitconfig` has no answer.
    //
    // `core.quotepath` off, so a path outside ASCII arrives as itself rather
    // than inside quotes with escapes in it — the name is matched against what
    // a tool reports back. `color.ui` off, because escape codes around every
    // header stop `diff --git ` and `@@` from starting a line, which reads as a
    // branch that changed nothing: a gate's way of passing. The prefixes fixed,
    // because `diff.noprefix` and `diff.mnemonicPrefix` rewrite the `a/` and
    // `b/` the header check below is written against. `diff.renames` at git's
    // own default — renames, never copies: under `copies` a file the branch
    // copied arrives as a copy with no lines written, which is the one change
    // the duplicate-code gate exists to see, and under `false` a file the
    // branch only moved arrives with every line written.
    //
    // And the file's own text, whatever the repo or the reader says about it:
    // `--text` past a `-diff` attribute and past a NUL byte, either of which
    // makes git print "Binary files differ" and no hunk; `--no-ext-diff` and an
    // empty `diff.external` past an external driver, which prints what it
    // likes; `--no-textconv` past a converter; and no attributes file of the
    // reader's. Each of them otherwise turns a file the branch wrote into one
    // with no line written, which reads as a branch that changed nothing.
    "-c",
    "core.quotepath=false",
    "-c",
    "color.ui=never",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.renames=true",
    "-c",
    "diff.external=",
    "-c",
    "core.attributesFile=/dev/null",
    "diff",
    "--no-color",
    "--text",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--relative",
    "--unified=0",
    "--diff-filter=d",
    rev,
    "--",
    ...pathspecs,
    NOT_A_DEPENDENCY,
  ]);
  if (!diff.ok) throw new Error(`git diff against ${rev} failed in ${root}`);

  const changed = new Map<string, Set<number>>();
  const problems: Problem[] = [];
  let unnamed: string | undefined;
  let lines: Set<number> | undefined;

  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith(OPENS)) {
      unnamed = line;
      lines = undefined;
      continue;
    }
    if (unnamed !== undefined && line.startsWith(NAMES)) {
      // git delimits the name with a tab when it holds a space.
      const named = line.slice(NAMES.length);
      const tab = named.indexOf("\t");
      const file = tab === -1 ? named : named.slice(0, tab);
      unnamed = undefined;
      if (keeps(file)) {
        lines = new Set();
        changed.set(file, lines);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;
    if (unnamed !== undefined) {
      // Content changed under a name this parser could not read: git C-quotes a
      // path holding a quote, a backslash or a control character, and its
      // header then reads `+++ "b/…"`. Refused rather than skipped, because a
      // file the gate cannot see is a file the gate cannot grade while
      // reporting that it did.
      problems.push({ message: unnamedProblem(unnamed) });
      unnamed = undefined;
      continue;
    }
    if (lines === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let at = start; at < start + count; at += 1) lines.add(at);
  }
  return { changed, problems };
}

function unnamedProblem(header: string): string {
  return `rename the file this branch changed so git can name it plainly — \`${header}\` is quoted because the path holds a quote, a backslash or a control character, and a gate cannot tell whether a file it cannot name is one it grades`;
}

/** Which files a gate holds a branch to, and the gate's own words for them. */
export interface Scope {
  /** What the gate wants the base ref for, which a checkout without it is told. */
  readonly why: string;
  readonly pathspecs: readonly string[];
  /** Of what the pathspecs reach, the files the gate grades. */
  readonly keeps: (path: string) => boolean;
  /** One of those files in the gate's words, as in "no domain file changed". */
  readonly noun: string;
  /** What a run with nothing to grade did not do, as in "nothing to mutate". */
  readonly nothing: string;
}

/**
 * The lines this branch wrote against its base ref, or the verdict a gate
 * answers with instead: a checkout that cannot name a base is refused, a run
 * with no earlier commit or no changed file passes saying so, and a changed
 * file git could not name plainly is refused. Every gate that holds a branch to
 * its own lines opens the same way, so the opening is here once.
 */
export async function branchChange(
  root: string,
  event: Event,
  scope: Scope,
): Promise<{ readonly rev: string; readonly changed: Map<string, Set<number>> } | Verdict> {
  const base = await baseRevision(root, event, scope.why);
  if ("refused" in base) {
    return { note: "the base ref could not be read", problems: [{ message: base.refused }] };
  }
  if (base.rev === undefined) {
    return {
      note: `there is no earlier commit to compare against — ${scope.nothing}`,
      problems: [],
    };
  }
  const { changed, problems } = await changeSet(root, base.rev, scope.pathspecs, scope.keeps);
  if (problems.length > 0) return { note: "a changed file could not be named", problems };
  if (changed.size === 0) {
    return {
      note: `no ${scope.noun} changed against ${base.rev.slice(0, 12)} — ${scope.nothing}`,
      problems: [],
    };
  }
  return { rev: base.rev, changed };
}
