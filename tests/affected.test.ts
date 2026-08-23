import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

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

async function versionOf(bun: string): Promise<string> {
  const proc = Bun.spawn([bun, "--version"], { stdout: "pipe", stderr: "ignore" });
  const version = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return version;
}

/**
 * Every bun on this machine, so the cases below run the lane under each. What
 * `bun run <script> ""` does with an empty argument changed between 1.3.11 and
 * 1.4.0 — dropped, then forwarded — and a lane graded under one of them only is
 * how that shipped. A runner has one bun and this is then one run, which is why
 * the case above it grades the shell rather than bun.
 */
const BUNS = await (async (): Promise<string[]> => {
  const onPath = (process.env["PATH"] ?? "").split(":").map((entry) => join(entry, "bun"));
  const candidates = [process.execPath, ...onPath];
  const there = await Promise.all(candidates.map((path) => Bun.file(path).exists()));
  const found = candidates.filter((_, at) => there[at] === true);
  const versions = await Promise.all(found.map(versionOf));
  // By version rather than by path: /usr/local/bin/bun and a symlink to it are
  // one bun, and running the cases twice under it proves nothing.
  return [...new Map(versions.map((version, at) => [version, found[at] ?? ""])).values()];
})();

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
    scripts: { typecheck: "bun scripts/argv.ts" },
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
  SEMANTIC_FIXTURES: "",
  PROBE_COMMAND: "",
  PROBE_TIMEOUT: "",
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

  // Without a base turbo can resolve, the flag narrows nothing: the checkout is
  // a detached HEAD with no local branch, turbo says so once and runs the whole
  // graph green. The flag without this is a seam that reports success for work
  // it never skipped.
  test("the base the flag narrows against is the commit, not a branch name", () => {
    expect(record(STATIC["env"])["TURBO_SCM_BASE"]).toBe(
      "${{ github.event.pull_request.base.sha }}",
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

  // Two inputs ride on another input rather than on the job, so each is asked a
  // second question here. Both are the same failure the step exists to prevent
  // from the other side: the job is running, the input was passed, and nothing
  // would have read it.
  test("fixtures without the replay they are written into are refused", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      DATABASE: "true",
      SEMANTIC_FIXTURES: "fixtures",
    });
    expect(output).toContain("::error::semantic-fixtures needs upgrade-gate: true");
    expect(status).not.toBe(0);
  });

  test("a bound with no command under it is refused", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      DATABASE: "true",
      PROBE_TIMEOUT: "300",
    });
    expect(output).toContain("::error::probe-timeout needs probe-command");
    expect(status).not.toBe(0);
  });

  // The clean tree for both: each input beside the one it rides on, with the
  // job that runs them asked for.
  test("each of them beside the input it rides on passes", async () => {
    expect(
      await ran(VALIDATION, MONOREPO, {
        ...NOTHING_SET,
        DATABASE: "true",
        UPGRADE_GATE: "true",
        SEMANTIC_FIXTURES: "fixtures",
        PROBE_COMMAND: "bun run scripts/probe.ts",
        PROBE_TIMEOUT: "300",
      }),
    ).toMatchObject({ status: 0 });
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
