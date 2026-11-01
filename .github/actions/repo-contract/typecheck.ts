/**
 * What CI type-checks with: the script check.yml's typecheck lane reaches, and
 * the Bun `packageManager` names, which setup-bun installs and which is the
 * only place `bun check` comes from.
 *
 * Its own module beside the contract because the two halves are one fact seen
 * from both ends — a script naming a command, and the runtime that has it — and
 * neither is about the files the rest of the contract reads.
 */
import type { Manifest, Problem } from "../_lib/gate.ts";
import { type Invoked, runsProgram } from "./package-scripts.ts";

/** check.yml's typecheck lane; `tests/check-inputs.test.ts` holds the workflow to it. */
export const TYPECHECK_LANE = "bun run typecheck";

/**
 * The type checker. Without `--no-script`, `bun check` runs the repo's own
 * `check` script when it has one, and in this fleet that script runs
 * `typecheck`: a lane that recurses instead of type-checking.
 */
const BUN_CHECK: Invoked = { program: "bun", argument: "check", flags: ["--no-script"] };

/**
 * The first Bun whose `bun check` takes `--no-script`. 1.4.3 has the command
 * but not the flag, and hands the flag to the repo's `check` script.
 */
const BUN_CHECK_SINCE = "1.4.4";

/**
 * `bun` is the exact version `packageManager` pins, or nothing where it pins
 * none — a fault the contract reports on its own, which leaves no version here
 * to hold to the floor.
 */
export function checkTypecheck(bun: string | undefined, all: readonly Manifest[]): Problem[] {
  const problems: Problem[] = [];
  if (bun !== undefined && Bun.semver.order(bun, BUN_CHECK_SINCE) < 0) {
    problems.push({
      file: "package.json",
      message: `packageManager names bun@${bun} — name bun@${BUN_CHECK_SINCE} or later, since the typecheck runs \`bun check --no-script\`, no older Bun has the flag, and setup-bun installs the Bun named here`,
    });
  }
  if (!runsProgram(TYPECHECK_LANE, BUN_CHECK, all)) {
    problems.push({
      file: "package.json",
      message: `the typecheck script must run \`bun check --no-script\` (directly or through a package script) — check.yml type-checks through \`${TYPECHECK_LANE}\`, bun check is the type checker, and without the flag it runs the repo's own check script instead`,
    });
  }
  return problems;
}
