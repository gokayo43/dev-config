import { describe, expect, test } from "bun:test";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The `affected` seam is shipped workflow rather than a module, and it is in two
 * halves: an expression that decides the flag, and shell that consumes it. What
 * it decides — the flag on a pull request, never on a push, and a refusal where
 * there is no turbo to hand it to — is invisible to every other gate here: a
 * seam that quietly stopped setting it is a green build over the packages nobody
 * changed.
 */
const CHECK = new URL("../.github/workflows/check.yml", import.meta.url).pathname;

const STATIC = await (async (): Promise<ConfigObject> => {
  const document = Bun.YAML.parse(await Bun.file(CHECK).text());
  return record(record(record(document)["jobs"])["static"]);
})();

const STEPS = isList(STATIC["steps"]) ? [...STATIC["steps"]] : [];

function scriptOf(step: unknown): string {
  const run = record(step)["run"];
  return typeof run === "string" ? run : "";
}

/**
 * Every lane that takes the flag, found by the expansion rather than by a list
 * here — so a lane added without one, or one that stops reading it, changes the
 * count these cases run over.
 */
const LANES = STEPS.map(scriptOf).filter((script) => script.includes("${TURBO_AFFECTED"));

/** The one step that refuses the inputs a caller cannot have meant, found by what it reads. */
const VALIDATION = await (async (): Promise<string> => {
  const found = STEPS.map(scriptOf).filter((script) => script.includes("turbo.json"));
  const [script, ...rest] = found;
  if (script === undefined || rest.length > 0) {
    throw new Error(`check.yml has ${found.length} steps refusing affected, not one`);
  }
  return script;
})();

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
    scripts: { build: "bun scripts/argv.ts", typecheck: "bun scripts/argv.ts" },
  }),
};

/** Every variable the validation step reads, so `set -u` grades the case and not the harness. */
const NOTHING_SET = {
  DATABASE: "false",
  UPGRADE_GATE: "false",
  CAPACITY_PATH: "",
  CAPACITY_SCRIPT: "",
  DB_GATE_EVIDENCE: "",
  ROUTE_ALLOWLIST: "",
  TIMESTAMP_ALLOWLIST: "",
  BACKFILL_COMMAND: "",
  BACKFILL_SEED: "",
  MUTATION_LANE: "false",
  MUTATION_FLOOR: "",
  AFFECTED: "false",
};

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly output: string;
}

async function ran(script: string, tree: Tree, environment: Record<string, string>): Promise<Ran> {
  const root = await materialise(tree);
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, stdout: out, output: out + err };
}

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

  // Refused rather than passed through: `tsc --noEmit --affected` is an error
  // from a tool that has never heard of the flag, and the run would blame the
  // repo's own script for an argument the workflow added.
  test("a repo with no turbo is told so rather than handed the flag", async () => {
    const { status, output } = await ran(
      VALIDATION,
      { "package.json": '{ "name": "fixture" }\n' },
      { ...NOTHING_SET, AFFECTED: "true" },
    );
    expect(output).toContain("::error::affected: true needs a turbo.json");
    expect(status).not.toBe(0);
  });

  test("a repo with a turbo is not refused", async () => {
    expect(await ran(VALIDATION, MONOREPO, { ...NOTHING_SET, AFFECTED: "true" })).toMatchObject({
      status: 0,
    });
  });

  // The step now reports every wrong input and exits on the tally rather than
  // unconditionally, so the case it must not break is the one it was written
  // for: an input aimed at a job the caller did not ask to run.
  test("an input aimed at a job that is not running is still refused", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      CAPACITY_PATH: "/api/things",
      MUTATION_FLOOR: "0.7",
    });
    expect(output).toContain("::error::capacity-path needs database: true");
    expect(output).toContain("::error::mutation-floor needs mutation-lane: true");
    expect(status).not.toBe(0);
  });
});

describe("the lanes that take the flag", () => {
  test("the suite found both of them", () => {
    expect(LANES).toHaveLength(2);
  });

  // A seam whose value no lane reads is the failure this pair exists for: it
  // passes every check above and changes nothing about the run.
  test.each(LANES)("lane %# hands the flag to the repo's script", async (script) => {
    const { stdout } = await ran(script, MONOREPO, { TURBO_AFFECTED: "--affected" });
    expect(JSON.parse(stdout)).toEqual(["--affected"]);
  });

  // The other half, and what a lane hardcoding the flag would fail: with nothing
  // decided the script is run exactly as it would be without this seam at all —
  // no argument, not an empty one, which turbo would read as a nameless task.
  test.each(LANES)("lane %# hands it nothing at all when it is empty", async (script) => {
    const { stdout } = await ran(script, MONOREPO, { TURBO_AFFECTED: "" });
    expect(JSON.parse(stdout)).toEqual([]);
  });
});
