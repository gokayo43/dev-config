import { basename } from "node:path";

import { type Problem, REASON, repoFiles } from "../_lib/gate.ts";

const SOURCE = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/**
 * Both spellings, because oxlint honours both: an `eslint-disable-next-line`
 * silences a rule exactly as an `oxlint-disable-next-line` does, so a gate that
 * knew only the oxlint spelling left the other one unreasoned and unreported.
 */
const DIRECTIVE = /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/;

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
      if (!DIRECTIVE.test(line) || line.includes(REASON)) return;
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
