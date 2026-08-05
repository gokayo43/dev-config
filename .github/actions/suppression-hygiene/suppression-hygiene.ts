import { basename } from "node:path";

import { type Problem, report, repoFiles } from "../_lib/gate.ts";

const SOURCE = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

/** oxlint's own separator between the rules a directive suppresses and the reason it exists. */
const REASON = " -- ";

const DIRECTIVE = /(?:\/\/|\/\*)\s*oxlint-disable(?:-next-line|-line)?\b/;

/**
 * Files that park work in the tree. The queue is GitHub issues, in the repo the
 * work belongs to: a list nobody can label, assign or close is deletion that
 * feels responsible.
 */
const REGISTERS = new Set(["TODO.md", "BACKLOG.md", "TASKS.md", "ISSUES.md", "ROADMAP.md"]);

export async function suppressionHygiene(root: string): Promise<Problem[]> {
  const problems: Problem[] = [];

  for (const file of await repoFiles(root, SOURCE)) {
    const lines = (await Bun.file(`${root}/${file}`).text()).split("\n");
    lines.forEach((line, index) => {
      if (!DIRECTIVE.test(line) || line.includes(REASON)) return;
      problems.push({
        file,
        message: `line ${index + 1}: an oxlint-disable without a '${REASON.trim()} reason' is a suppressed bug — say what the rule cannot know`,
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

if (import.meta.main) {
  report(await suppressionHygiene(process.cwd()));
}
