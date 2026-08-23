import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { isList, record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The `affected` seam is shell in the shipped workflow rather than a module, so
 * the suite runs that shell. What it decides — the flag on a pull request, never
 * on a push, and a refusal where there is no turbo to hand it to — is invisible
 * to every other gate here: a run that quietly stopped setting it is a green
 * build over the packages nobody changed.
 */
const CHECK = new URL("../.github/workflows/check.yml", import.meta.url).pathname;

const STEPS = await (async (): Promise<unknown[]> => {
  const document = Bun.YAML.parse(await Bun.file(CHECK).text());
  const steps = record(record(record(document)["jobs"])["static"])["steps"];
  return isList(steps) ? [...steps] : [];
})();

function scriptOf(step: unknown): string {
  const run = record(step)["run"];
  return typeof run === "string" ? run : "";
}

/** The one step that decides the flag, found by the input it is keyed to. */
const DECIDES = await (async (): Promise<string> => {
  const found = STEPS.filter((step) => record(step)["if"] === "inputs.affected");
  const [step, ...rest] = found;
  if (step === undefined || rest.length > 0) {
    throw new Error(`check.yml has ${found.length} steps keyed to inputs.affected, not one`);
  }
  return scriptOf(step);
})();

/**
 * Every lane that takes the flag, found by the expansion rather than by a list
 * here — the step above writes the variable and is not one of them.
 */
const LANES = STEPS.map(scriptOf).filter((script) => script.includes("${TURBO_AFFECTED"));

const MONOREPO: Tree = {
  "turbo.json": '{ "tasks": {} }\n',
  "package.json": JSON.stringify({
    name: "fixture",
    scripts: { build: "echo lane", typecheck: "echo lane" },
  }),
};

interface Ran {
  readonly status: number;
  readonly output: string;
  /** What the step exported for the lanes after it, which is the whole of what it decides. */
  readonly exported: string;
}

async function decided(tree: Tree, event: string): Promise<Ran> {
  const root = await materialise(tree);
  const exported = join(root, "github-env");
  await Bun.write(exported, "");
  const proc = Bun.spawn(["bash", "-c", DECIDES], {
    cwd: root,
    env: { ...process.env, EVENT: event, GITHUB_ENV: exported },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    status: await proc.exited,
    output: out + err,
    exported: await Bun.file(exported).text(),
  };
}

async function lane(script: string, affected: string | undefined): Promise<string> {
  const root = await materialise(MONOREPO);
  const environment = { ...process.env };
  if (affected === undefined) delete environment["TURBO_AFFECTED"];
  else environment["TURBO_AFFECTED"] = affected;
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

describe("which packages a run is held to", () => {
  test("a pull request asks turbo for the packages it changed", async () => {
    const { status, exported } = await decided(MONOREPO, "pull_request");
    expect(status).toBe(0);
    expect(exported).toContain("TURBO_AFFECTED=--affected");
  });

  // The whole reason the flag is keyed to the event: on a push to main
  // --affected diffs main against itself and selects zero packages, so a step
  // that set it here would take every lane green over nothing — and it would
  // look exactly like a run that passed.
  test.each(["push", "workflow_dispatch", "merge_group"])(
    "a %s run is the full graph",
    async (event) => {
      const { status, exported } = await decided(MONOREPO, event);
      expect(status).toBe(0);
      expect(exported).toBe("");
    },
  );

  // Refused rather than passed through: `tsc --noEmit --affected` is an error
  // from a tool that has never heard of the flag, and the run would blame the
  // repo's own script for an argument the workflow added.
  test("a repo with no turbo is told so rather than handed the flag", async () => {
    const { status, output, exported } = await decided(
      { "package.json": '{ "name": "fixture" }\n' },
      "pull_request",
    );
    expect(status).not.toBe(0);
    expect(output).toContain("::error::affected: true needs a turbo.json");
    expect(exported).toBe("");
  });
});

describe("the lanes that take the flag", () => {
  test("the suite found both of them", () => {
    expect(LANES).toHaveLength(2);
  });

  // A seam that exports a variable no lane reads is the failure this pair
  // exists for: it passes every check above and changes nothing about the run.
  test.each(LANES)("lane %# forwards the flag to the repo's script", async (script) => {
    expect(await lane(script, "--affected")).toContain("--affected");
  });

  // Unquoted, so that unset is no argument at all. Quoted, the lane would hand
  // the script an empty argument, which turbo reads as a task with no name.
  test.each(LANES)("lane %# passes nothing at all when it is unset", async (script) => {
    expect(await lane(script, undefined)).not.toContain("--");
  });
});
