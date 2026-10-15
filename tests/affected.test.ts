import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isList, record } from "../.github/actions/_lib/gate.ts";
import { BUNS } from "./buns.ts";
import { ran, scriptOf, STATIC } from "./check-workflow.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The `affected` seam is shipped workflow rather than a module, and it is in two
 * halves: an expression that decides the flag, and shell that consumes it. What
 * it decides — the flag on a pull request, never on a push — is invisible to
 * every other gate here: a seam that quietly stopped setting it is a green
 * build over the packages nobody changed. The refusal where there is no turbo
 * to hand it to is the input check's, in check-inputs.test.ts.
 */

const STEPS = isList(STATIC["steps"]) ? [...STATIC["steps"]] : [];

/**
 * Every lane that takes the flag, found by the expansion rather than by a list
 * here — so a lane added without one, or one that stops reading it, changes the
 * count these cases run over.
 */
const LANES = STEPS.map(scriptOf).filter((script) => script.includes("${TURBO_AFFECTED"));

/**
 * Both lanes pointed at a script that prints its argv back. The argv rather than
 * the output of a real tool, because what a lane is graded on here is exactly
 * what it forwards: an empty argument and no argument are the same to `echo`
 * and different to turbo.
 */
const MONOREPO: Tree = {
  "turbo.json": '{ "tasks": {} }\n',
  "scripts/argv.ts": "console.log(JSON.stringify(Bun.argv.slice(2)));\n",
  "package.json": JSON.stringify({
    name: "fixture",
    scripts: { typecheck: "bun scripts/argv.ts" },
  }),
};

describe("which packages a run is held to", () => {
  /**
   * A golden rather than an evaluation: nothing in this suite can evaluate a
   * GitHub expression, so what it pins is the expression's shape — that the flag
   * is gated on the caller's input AND on the event being a pull request, and
   * that anything else yields the empty string the lanes read as "no argument".
   * Dropping either half is what this catches; that GitHub then evaluates it the
   * way the docs say is the first real CI run's to prove.
   */
  test("the flag is decided by the input and the event, and by nothing else", () => {
    expect(record(STATIC["env"])["TURBO_AFFECTED"]).toBe(
      "${{ inputs.affected && github.event_name == 'pull_request' && '--affected' || '' }}",
    );
  });

  // Without a base turbo can resolve, the flag narrows nothing: the checkout is
  // a detached HEAD with no local branch, turbo says so once and runs the whole
  // graph green. The flag without this is a seam that reports success for work
  // it never skipped.
  test("the base the flag narrows against is the commit, not a branch name", () => {
    expect(record(STATIC["env"])["TURBO_SCM_BASE"]).toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
  });
});

describe("the lanes that take the flag", () => {
  // One: the build lane is deliberately not narrowed, because it writes the
  // generated sources the whole-repo lanes then read.
  test("the suite found the lane", () => {
    expect(LANES).toHaveLength(1);
  });

  /**
   * The words the lane's shell produces, read off a `bun` that records its argv
   * instead of running. This is the version-independent half: what the lane
   * controls is the argument vector it builds, and grading that catches a
   * re-quoted expansion on any machine — where grading what bun then does with
   * it catches nothing on a bun that drops the empty word.
   */
  async function words(script: string, affected: string): Promise<string[]> {
    const root = await materialise(MONOREPO);
    const bin = join(root, "bin");
    const recorded = join(root, "argv.json");
    // NUL-delimited, because the word this has to see is the empty one: a
    // newline-delimited record cannot tell "no arguments" from "one empty
    // argument", which is exactly the pair being graded.
    await Bun.write(
      join(bin, "bun"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(recorded)}\n`,
    );
    await chmod(join(bin, "bun"), 0o755);
    const proc = Bun.spawn(["bash", "-c", script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        TURBO_AFFECTED: affected,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    const written = await Bun.file(recorded).text();
    return written === "" ? [] : written.split("\0").slice(0, -1);
  }

  test.each(LANES)("lane %# builds the argument vector with the flag", async (script) => {
    expect(await words(script, "--affected")).toEqual(["run", "typecheck", "--affected"]);
  });

  // The bug this pair exists for. Empty, the lane has to invoke the script
  // exactly as it would without this seam at all: `run typecheck`, three words
  // becoming two — never a fourth empty one, which `turbo run typecheck ""`
  // refuses as a task with no name and every non-turbo script takes as a stray
  // argument. It fires on `affected: false`, which is every repo's default.
  test.each(LANES)("lane %# builds it with nothing at all when empty", async (script) => {
    expect(await words(script, "")).toEqual(["run", "typecheck"]);
  });

  test("the suite found a bun to run the lane with", () => {
    expect(BUNS.length).toBeGreaterThan(0);
  });

  // And end to end, under every bun this machine has: what the script finally
  // receives is the same argv under each.
  test.each(BUNS)("under %s the script is handed the flag", async (bun) => {
    const { stdout } = await ran(LANES[0] ?? "", MONOREPO, {
      TURBO_AFFECTED: "--affected",
      PATH: `${dirname(bun)}:${process.env["PATH"] ?? ""}`,
    });
    expect(JSON.parse(stdout)).toEqual(["--affected"]);
  });

  test.each(BUNS)("under %s an empty flag reaches the script as no argument", async (bun) => {
    const { stdout } = await ran(LANES[0] ?? "", MONOREPO, {
      TURBO_AFFECTED: "",
      PATH: `${dirname(bun)}:${process.env["PATH"] ?? ""}`,
    });
    expect(JSON.parse(stdout)).toEqual([]);
  });
});
