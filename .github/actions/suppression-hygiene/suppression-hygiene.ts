import { basename } from "node:path";

import { type Problem, REASON, repoFiles } from "../_lib/gate.ts";

const SOURCE = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/**
 * Every directive that silences a check, whoever reads it. Both lint spellings,
 * because oxlint honours both — an `eslint-disable-next-line` silences a rule
 * exactly as an `oxlint-disable-next-line` does, so a gate that knew only the
 * oxlint spelling left the other one unreasoned and unreported — and Stryker's
 * `Stryker disable` comment, which takes a mutant out of the mutation lane's
 * run and out of its score. Three tools, one rule: a suppression says why.
 *
 * `Stryker restore` is not here. It ends a disabled region rather than opening
 * one, and the reason it is asking for was owed at the `disable` above it.
 */
const DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:(?:oxlint|eslint)-disable(?:-next-line|-line)?|Stryker disable)\b/;

/**
 * Whether the directive on this line actually says why. The separator alone is
 * not a reason: a line ending `-- ` satisfies a test for the marker and tells
 * the next reader exactly what no comment at all would. The same bar
 * `allowlistFrom` holds a waiver to, in the other dialect a suppression is
 * written in.
 */
function saysWhy(line: string): boolean {
  const [, ...reason] = line.split(REASON);
  return reason.join(REASON).trim() !== "";
}

/**
 * Files that park work in the tree. The queue is GitHub issues, in the repo the
 * work belongs to: a list nobody can label, assign or close is deletion that
 * feels responsible.
 */
const REGISTERS = new Set(["TODO.md", "BACKLOG.md", "TASKS.md", "ISSUES.md", "ROADMAP.md"]);

export interface Scope {
  readonly root: string;
  /**
   * Paths whose directives are fixture text rather than suppressions — this
   * gate's own suite is the case that exists. Naming the file is narrower than
   * teaching the scan enough TypeScript to tell a comment from a string
   * literal, and it is visible: an exempt path sits in the caller's diff.
   */
  readonly fixtures: readonly string[];
}

export async function suppressionHygiene({ root, fixtures }: Scope): Promise<Problem[]> {
  const exempt = new Set(fixtures);
  const problems: Problem[] = [];

  for (const file of await repoFiles(root, SOURCE)) {
    if (exempt.has(file)) continue;
    const lines = (await Bun.file(`${root}/${file}`).text()).split("\n");
    lines.forEach((line, index) => {
      if (!DIRECTIVE.test(line) || saysWhy(line)) return;
      problems.push({
        file,
        message: `line ${index + 1}: a lint directive without a '${REASON.trim()} reason' is a suppressed bug — say what the rule cannot know`,
      });
    });
  }

  for (const file of await repoFiles(root, ["*.md"])) {
    if (!REGISTERS.has(basename(file))) continue;
    problems.push({
      file,
      message: `${basename(file)} is a second register — file the work as a needs-triage issue in this repo instead`,
    });
  }

  return problems;
}
