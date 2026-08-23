import { isList, isObject, type Problem, record, repoFiles } from "../_lib/gate.ts";

/**
 * Every shell script the repository has, at any depth. A git pathspec matches a
 * wildcard across "/", so this one reaches `scripts/backup.sh` and a `deploy.sh`
 * at the root alike.
 *
 * Named by extension rather than by a directory, and taking no input for it:
 * what makes a script worth reading is what is in it, not where somebody put
 * it, and an input naming paths is a gate that stops covering a file the day it
 * moves — silently, which is the failure this gate exists to end.
 */
const SCRIPTS = "*.sh";

/** One finding, as `--format=json1` writes it. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: number;
  readonly message: string;
}

/**
 * The report, refused rather than read past when it is not the shape this was
 * written against. shellcheck writes JSON on a clean run and on a dirty one, so
 * a report that will not parse is the tool having died — a binary that is not
 * there, a file it could not open — and reading that as "no findings" is a gate
 * that passes by having been handed nothing.
 */
function findingsIn(text: string, wrote: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`shellcheck wrote no report: ${wrote.trim() || "nothing at all"}`);
  }
  const comments = record(isObject(parsed) ? parsed : {})["comments"];
  if (!isList(comments)) throw new Error(`shellcheck's report has no comments list: ${text}`);

  return comments.map((comment) => {
    const { file, line, code, message } = record(isObject(comment) ? comment : {});
    if (
      typeof file !== "string" ||
      typeof line !== "number" ||
      typeof code !== "number" ||
      typeof message !== "string"
    ) {
      throw new Error(`shellcheck reported something this cannot read: ${JSON.stringify(comment)}`);
    }
    return { file, line, code, message };
  });
}

/**
 * Every shell script in the repository, through the shellcheck the caller
 * pinned. Nothing else in the pipeline reads one: actionlint shellchecks the
 * `run:` blocks inside a workflow and stops there, so a repo's own scripts —
 * the one that pipes a dump into a bucket, the one that drops a database and
 * carries the guard keeping it off production — were covered by no gate at all.
 *
 * The binary is an argument rather than a name looked up on PATH, so that what
 * graded a run is the pin the action fetched and not whichever version the
 * machine happened to have: shellcheck adds checks between releases, and two
 * runs only agree when they were the same one.
 */
export async function shellScripts(root: string, shellcheck: string): Promise<Problem[]> {
  const files = await repoFiles(root, [SCRIPTS]);
  // Handed no file at all, shellcheck reads stdin — which in a runner is a step
  // that hangs until the job's timeout rather than a repo that has no scripts.
  if (files.length === 0) return [];

  const proc = Bun.spawn([shellcheck, "--norc", "--format=json1", "--", ...files], {
    cwd: root,
    // Empty on purpose, both halves. shellcheck reads its own options out of
    // SHELLCHECK_OPTS, and every .shellcheckrc from the script's directory
    // upwards — including the reader's home. A gate whose answer depends on the
    // reader's shell has no answer, and the escape hatch stays what it already
    // is: a `# shellcheck disable=` beside the line, in the diff, where a
    // reviewer sees it.
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // The exit status says nothing this does not already know: shellcheck answers
  // 1 for a finding and 1 for a file it could not open, and the report is what
  // tells the two apart.
  await proc.exited;

  return findingsIn(out, err).map(({ file, line, code, message }) => ({
    file,
    message: `line ${line}: ${message} (SC${code} — https://www.shellcheck.net/wiki/SC${code})`,
  }));
}
