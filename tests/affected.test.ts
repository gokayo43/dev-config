import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { BUNS } from "./buns.ts";
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

const DATABASE_JOB = await (async (): Promise<ConfigObject> => {
  const document = Bun.YAML.parse(await Bun.file(CHECK).text());
  return record(record(record(document)["jobs"])["database"]);
})();

function scriptOf(step: unknown): string {
  const run = record(step)["run"];
  return typeof run === "string" ? run : "";
}

/** One string field of a mapping, or the empty string — a key absent reads as unset. */
function textAt(held: ConfigObject, key: string): string {
  const value = held[key];
  return typeof value === "string" ? value : "";
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
    scripts: { typecheck: "bun scripts/argv.ts" },
  }),
};

/** Every variable the validation step reads, so `set -u` grades the case and not the harness. */
const NOTHING_SET = {
  DATABASE: "none",
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
    expect(output).toContain("::error::capacity-path needs database: postgres");
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
      DATABASE: "postgres",
      SEMANTIC_FIXTURES: "fixtures",
    });
    expect(output).toContain("::error::semantic-fixtures needs upgrade-gate: true");
    expect(status).not.toBe(0);
  });

  test("a bound with no command under it is refused", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      DATABASE: "postgres",
      PROBE_TIMEOUT: "300",
    });
    expect(output).toContain("::error::probe-timeout needs probe-command");
    expect(status).not.toBe(0);
  });

  // A golden for the same reason the two above are: nothing here evaluates a
  // GitHub expression, and what this pins is that the job asks for the one
  // value that means it. `if: inputs.database` was the condition while the
  // input was a boolean, and left as it stood it is truthy for every string —
  // so `none` and `external` would both start a Postgres nobody asked for, and
  // `external` would run the job the wrapper exists to replace.
  test("the database job runs on the one value that names it", () => {
    expect(DATABASE_JOB["if"]).toBe("inputs.database == 'postgres'");
  });

  // Every address this job hands out is a port the daemon assigned, never a
  // number written here. A fixed one is two failures at once on a self-hosted
  // runner: `5432:5432` binds 0.0.0.0, which Docker's DNAT then answers on the
  // box's public address, and no two overlapping jobs can both hold it. The
  // wrong implementation is the readable one — a service published on its own
  // port and a URL naming it — so the case reads both halves rather than the
  // service alone, which would pass on a job that published ephemerally and
  // then built its URL from 5432 anyway.
  test("the services publish on loopback, on ports nothing else can be holding", () => {
    const services = record(DATABASE_JOB["services"]);
    for (const [name, port] of [
      ["postgres", "5432"],
      ["redis", "6379"],
    ]) {
      const published = record(services[name ?? ""])["ports"];
      expect(isList(published) ? published : []).toEqual([`127.0.0.1::${port}`]);
    }
    // Read off the step that writes them, not the job's `env:` — the `job`
    // context is out of reach there, and a workflow reading it there is
    // refused whole before any job starts (v0.55.1 shipped that way).
    const steps = DATABASE_JOB["steps"];
    const naming = (isList(steps) ? steps : [])
      .map((step) => record(step))
      .find(
        (step) => typeof step["name"] === "string" && step["name"].startsWith("Allocate a port"),
      );
    const environment = record(naming?.["env"]);
    expect(environment["DATABASE_URL"]).toContain("job.services.postgres.ports['5432']");
    expect(environment["REDIS_URL"]).toContain("job.services.redis.ports['6379']");
    expect(String(naming?.["run"])).toContain("DATABASE_URL=%s");
  });

  // The boot gate's app gets a port picked by the kernel, for the second half
  // of the same reason: 3000 is the framework default, so it is exactly the
  // port a shared box has already given to something else — on this one, to a
  // deployed API — and two of these jobs would collide on it as surely as on a
  // fixed 5432. The wrong implementation is the one that shipped: a health-url
  // default that still says 3000. Read through `format(...)` rather than by
  // searching for the absence of "3000", since a case that only asserted the
  // absence would pass on a default that had been deleted rather than moved.
  test("the boot gate polls the port the job allocated, not a default 3000", () => {
    const steps = isList(DATABASE_JOB["steps"]) ? [...DATABASE_JOB["steps"]] : [];
    const allocation = steps.map(scriptOf).filter((script) => script.includes("PORT="));
    expect(allocation).toHaveLength(1);
    expect(allocation[0] ?? "").toContain("$GITHUB_ENV");
    // Bound to port 0 rather than probed for a free one: asking whether a port
    // is free and then binding it is a race the kernel already answers.
    expect(allocation[0] ?? "").toContain("port: 0");

    const gate = steps.find((step) => textAt(record(step), "uses").includes("db-gate"));
    const health = textAt(record(record(gate)["with"]), "health-url");
    expect(health).toContain("env.PORT");
    expect(health).not.toContain("3000");
  });

  // `external` says a wrapper workflow runs the database gates in this job's
  // place, so every input aimed at the job here is aimed at nothing — the same
  // state `none` is in, and the wrong implementation is the one that reads the
  // input as a truthy string and lets the whole set through unread.
  test("an input aimed at the job a wrapper took over is refused too", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      DATABASE: "external",
      CAPACITY_PATH: "/api/things",
      UPGRADE_GATE: "true",
    });
    expect(output).toContain("::error::capacity-path needs database: postgres");
    expect(output).toContain("::error::upgrade-gate: true needs database: postgres");
    expect(status).not.toBe(0);
  });

  // A wrapper's call with nothing else on it is the shape this input exists
  // for, and it has to be as clean a run as `none` is.
  test("and the wrapper's own call, with none of them, passes", async () => {
    expect(await ran(VALIDATION, MONOREPO, { ...NOTHING_SET, DATABASE: "external" })).toMatchObject(
      { status: 0 },
    );
  });

  // `none` is the value that switches every database rule off, here and in the
  // repo contract, so a value nobody defined must not fall through to it: an
  // implementation testing only for `postgres` reads every typo as "no
  // database" and sheds the rules in silence.
  test.each(["true", "false", "Postgres", "mariadb", ""])(
    "a database value nobody defined (%j) is refused rather than read as none",
    async (value) => {
      const { status, output } = await ran(VALIDATION, MONOREPO, {
        ...NOTHING_SET,
        DATABASE: value,
      });
      expect(output).toContain(`::error::database reads "${value}"`);
      expect(status).not.toBe(0);
    },
  );

  // The clean tree for both: each input beside the one it rides on, with the
  // job that runs them asked for.
  test("each of them beside the input it rides on passes", async () => {
    expect(
      await ran(VALIDATION, MONOREPO, {
        ...NOTHING_SET,
        DATABASE: "postgres",
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
