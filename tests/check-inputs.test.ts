import { describe, expect, test } from "bun:test";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { DATABASE_JOB, INPUTS, ran, scriptOf, STATIC, textAt } from "./check-workflow.ts";
import type { Tree } from "./tree.ts";

/**
 * The step of check.yml that refuses the inputs a caller cannot have meant:
 * an input aimed at a job or a step the caller did not ask to run, which would
 * otherwise be read by nothing and said by nobody. Beside it, the goldens for
 * what the jobs do with an input once it passes, since nothing here can
 * evaluate a GitHub expression.
 */
const PAGE = await Bun.file(new URL("../README.md", import.meta.url)).text();

const STEPS = isList(STATIC["steps"]) ? [...STATIC["steps"]] : [];

/** What the database job hands db-gate, found by the action it names rather than by position. */
const DB_GATE = ((): ConfigObject => {
  const steps = isList(DATABASE_JOB["steps"]) ? [...DATABASE_JOB["steps"]] : [];
  const found = steps.filter((step) => textAt(record(step), "uses").includes("/db-gate@"));
  const [step, ...rest] = found;
  if (step === undefined || rest.length > 0) {
    throw new Error(`check.yml's database job calls db-gate ${found.length} times, not once`);
  }
  return record(record(step)["with"]);
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
 * The inputs that step refuses by emptiness, named by the calls themselves. The
 * helper is what makes the set readable from here — a hand-written `if` block
 * per input was a set only a person could enumerate, and enumerating it here is
 * the second copy that goes stale.
 */
const REFUSED_WHEN_EMPTY = [...VALIDATION.matchAll(/^\s*needs_postgres (\S+) /gmu)].map(
  ([, name]) => name ?? "",
);

/** A repository with a turbo, which is what `affected: true` needs beside it. */
const MONOREPO: Tree = { "turbo.json": '{ "tasks": {} }\n' };

/** Every variable the validation step reads, so `set -u` grades the case and not the harness. */
const NOTHING_SET = {
  DATABASE: "none",
  UPGRADE_GATE: "false",
  CAPACITY_PATH: "",
  CAPACITY_SCRIPT: "",
  DB_GATE_EVIDENCE: "",
  ROUTE_ALLOWLIST: "",
  ROUTE_RETIRE: "",
  FUZZ_SEED: "",
  TIMESTAMP_ALLOWLIST: "",
  BACKFILL_COMMAND: "",
  BACKFILL_SEED: "",
  SEMANTIC_FIXTURES: "",
  START_COMMAND: "",
  HEALTH_URL: "",
  PROBE_COMMAND: "",
  PROBE_TIMEOUT: "",
  MUTATION_LANE: "false",
  MUTATION_FLOOR: "",
  BUILD: "false",
  BUILD_CACHE: "",
  AFFECTED: "false",
};

/** The rows of README's input table, by the input each names. */
const DOCUMENTED = ((): Map<string, string> => {
  const rows = new Map<string, string>();
  for (const line of PAGE.split("\n")) {
    const named = /^\| `([a-z-]+)`\s+\|/u.exec(line);
    if (named?.[1] !== undefined) rows.set(named[1], line);
  }
  return rows;
})();

describe("the inputs that need the database job", () => {
  // The paragraph under that table used to enumerate these by hand, and had
  // already gone stale — `fuzz-seed` was refused by the step and absent from the
  // list. The row is where the fact belongs, since that is what a caller reads
  // before passing an input, and this is what keeps the next one from being
  // missing from it.
  test.each(REFUSED_WHEN_EMPTY)("%s says so in its own row of the README", (input) => {
    expect(DOCUMENTED.get(input) ?? `${input}: no row`).toContain("Needs `database: postgres`");
  });
});

describe("what a caller may pass, and what the jobs do with it", () => {
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

  // The rule the two goldens below are instances of, held over the whole set
  // rather than over the pair that broke it. Read off the step instead of
  // listed here: a list is a second statement of the set, and the copy that
  // goes stale is the one nobody runs. Another input added to that guard is
  // covered by this the moment it is written.
  test("the suite found the inputs the guard refuses by emptiness", () => {
    expect(REFUSED_WHEN_EMPTY.length).toBeGreaterThan(0);
  });

  // `needs_postgres` reads "the caller passed this" as "the value is non-empty",
  // and a workflow cannot tell an unset input from one set to its default —
  // `github.event.inputs` is not populated for `workflow_call`. So an input in
  // that set carrying any other default is one the guard can never see: it
  // would refuse every caller or none, and it refuses none. That is exactly
  // what `start-command` and `health-url` did.
  test.each(REFUSED_WHEN_EMPTY)("%s is declared with an empty default", (name) => {
    expect(INPUTS[name]).toBeDefined();
    expect(record(INPUTS[name])["default"]).toBe("");
  });

  // ...and the refusal itself over that same set, rather than over the pair of
  // goldens below. The helper takes the input's name and its value as separate
  // arguments, so a call that transposes them, or names an input the step does
  // not read, refuses nothing while reading as wired — and the input added last
  // is the one nobody has a golden for.
  test.each(REFUSED_WHEN_EMPTY)("%s is refused where that job is not running", async (name) => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      [name.toUpperCase().replaceAll("-", "_")]: "what the caller meant by it",
    });
    expect(output).toContain(`::error::${name} needs database: postgres`);
    expect(status).not.toBe(0);
  });

  // The one input in the set graded on its value rather than on its emptiness,
  // because it is the one boolean: `-n` is true of `false`, so an emptiness
  // reading would refuse every caller that names it at all.
  test("the boolean of the set is graded on the word, not on emptiness", () => {
    expect(record(INPUTS["upgrade-gate"])["type"]).toBe("boolean");
    expect(VALIDATION).toContain('[ "$UPGRADE_GATE" = true ]');
    expect(REFUSED_WHEN_EMPTY).not.toContain("upgrade-gate");
  });

  // These two carried YAML defaults, so "the caller passed this" — which every
  // check in that step spells as "the value is non-empty" — was true of every
  // caller and so of none: the step would have refused all of them or none, and
  // it refused none. A repo passing them with `database: none` went green with
  // both read by nothing, which is the class the rest of the step kills.
  test("the two inputs that used to carry a default are refused too", async () => {
    const { status, output } = await ran(VALIDATION, MONOREPO, {
      ...NOTHING_SET,
      START_COMMAND: "bun run serve",
      HEALTH_URL: "http://localhost:8080/health",
    });

    expect(output).toContain("::error::start-command needs database: postgres");
    expect(output).toContain("::error::health-url needs database: postgres");
    expect(status).not.toBe(0);
  });

  // A golden, because nothing here evaluates a GitHub expression, and what an
  // empty input has to keep meaning is the value it meant before. The wrong
  // implementation is the one that took the defaults off the inputs to let the
  // guard see them and stopped there, leaving every repo that never named a
  // start command booting `""`.
  test("the defaults the guard cannot see are applied by the job that reads them", () => {
    expect(DB_GATE["start-command"]).toBe("${{ inputs.start-command || 'bun run start' }}");
    expect(DB_GATE["health-url"]).toBe(
      "${{ inputs.health-url || format('http://localhost:{0}/api/health', env.PORT) }}",
    );
  });

  // Wrong implementation: no guard, so a caller that names a cache and never
  // asked for the build is green with nothing cached and nothing said.
  test("a build cache with no build under it is refused, and passes beside one", async () => {
    const without = await ran(VALIDATION, MONOREPO, { ...NOTHING_SET, BUILD_CACHE: ".next/cache" });
    expect(without.output).toContain("::error::build-cache needs build: true");
    expect(without.status).not.toBe(0);

    expect(
      await ran(VALIDATION, MONOREPO, {
        ...NOTHING_SET,
        BUILD: "true",
        BUILD_CACHE: ".next/cache",
      }),
    ).toMatchObject({ status: 0 });
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

  // A golden for the same reason as the defaults above: nothing here evaluates
  // a GitHub expression, and what this pins is that the job asks for the one
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

    const health = textAt(DB_GATE, "health-url");
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
        START_COMMAND: "bun run serve",
        HEALTH_URL: "http://localhost:8080/health",
        PROBE_COMMAND: "bun run scripts/probe.ts",
        PROBE_TIMEOUT: "300",
      }),
    ).toMatchObject({ status: 0 });
  });
});

describe("what the build steps are handed", () => {
  /** Every step, in either job, that runs the build action, found by what it calls. */
  const BUILDS = [STATIC, DATABASE_JOB]
    .flatMap((job) => (isList(job["steps"]) ? [...job["steps"]] : []))
    .map((step) => record(step))
    .filter((step) =>
      textAt(step, "uses").startsWith("gokayo43/dev-config/.github/actions/build@"),
    );

  // A golden, for the reason the database job's are: what the step passes is an
  // expression nothing here evaluates. The wrong implementations are a job
  // whose build step never names the cache, which builds cold forever with
  // every case of the action green, and one that builds when nobody asked.
  test("both jobs build through the action, on the caller's word, with the caller's paths", () => {
    expect(BUILDS).toHaveLength(2);
    for (const step of BUILDS) {
      expect(step["if"]).toBe("inputs.build");
      expect(record(step["with"])).toEqual({ cache: "${{ inputs['build-cache'] }}" });
    }
  });
});
