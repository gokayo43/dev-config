import { basename } from "node:path";

import { KEEP_CLONE, type Problem, REASON, reasonAfter, repoFiles, SOURCE } from "../_lib/gate.ts";

/**
 * Every directive that silences a check, whoever reads it. Both lint spellings,
 * because oxlint honours both — an `eslint-disable-next-line` silences a rule
 * exactly as an `oxlint-disable-next-line` does, so a gate that knew only the
 * oxlint spelling left the other one unreasoned and unreported — Stryker's
 * `Stryker disable` comment, which takes a mutant out of the mutation lane's
 * run and out of its score, and `duplicate-code-allow`, which keeps a clone the
 * duplicate-code gate would refuse. Four spellings, one rule: a suppression
 * says why.
 *
 * `Stryker restore` is not here. It ends a disabled region rather than opening
 * one, and the reason it is asking for was owed at the `disable` above it.
 */
const DIRECTIVE = new RegExp(
  String.raw`(?:\/\/|\/\*)\s*(?:(?:oxlint|eslint)-disable(?:-next-line|-line)?|Stryker disable|${KEEP_CLONE})\b`,
);

/**
 * Files that park work in the tree. The queue is GitHub issues, in the repo the
 * work belongs to: a list nobody can label, assign or close is deletion that
 * feels responsible.
 */
const REGISTERS = new Set(["TODO.md", "BACKLOG.md", "TASKS.md", "ISSUES.md", "ROADMAP.md"]);

export interface Scope {
  readonly root: string;
  /**
   * Paths whose directives are fixture text rather than suppressions.
   * docs/gates/suppression-hygiene.md says why the answer is a named path.
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
      if (!DIRECTIVE.test(line) || reasonAfter(line) !== "") return;
      problems.push({
        file,
        message: `line ${index + 1}: a directive without a '${REASON.trim()} reason' is a suppressed bug — say what the check cannot know`,
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
