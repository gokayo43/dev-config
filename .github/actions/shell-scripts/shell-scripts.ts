import { isList, type Problem, record, repoFiles } from "../_lib/gate.ts";

/**
 * Every shell script the repository has, at any depth: a git pathspec matches a
 * wildcard across "/", so this one reaches `scripts/backup.sh` and a `deploy.sh`
 * at the root alike. Why by extension rather than by directory, and why there is
 * no input for it: docs/gates/shell-scripts.md.
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
  const comments = record(parsed)["comments"];
  if (!isList(comments)) throw new Error(`shellcheck's report has no comments list: ${text}`);

  return comments.map((comment) => {
    const { file, line, code, message } = record(comment);
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
 * pinned — docs/gates/shell-scripts.md is what this gate is for and what it
 * cannot see. The binary is an argument rather than a name looked up on PATH so
 * that a caller cannot be handed a different gate by the machine it runs on.
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
  // 0 is a clean run, 1 is a run with findings, and anything above that is
  // shellcheck refusing to do the job — a file it could not open, an option it
  // does not have. It answers 2 with a VALID and EMPTY report on stdout, which
  // is byte for byte what a clean tree looks like, so the status is the only
  // thing that tells them apart and a gate that ignored it would pass a run that
  // read nothing.
  const status = await proc.exited;
  if (status >= 2) {
    throw new Error(`shellcheck exited ${status} without reading the scripts: ${err.trim()}`);
  }

  return findingsIn(out, err).map(({ file, line, code, message }) => ({
    file,
    message: `line ${line}: ${message} (SC${code} — https://www.shellcheck.net/wiki/SC${code})`,
  }));
}
