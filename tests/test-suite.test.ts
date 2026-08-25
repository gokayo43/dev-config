import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The gate is a shell script in a composite action, so the suite runs that
 * script rather than a transcription of it: the one thing a copy could not
 * grade is whether the namespace the shipped YAML names actually holds, which
 * is the whole of what this gate claims.
 */
const ACTION = new URL("../.github/actions/test-suite/action.yml", import.meta.url).pathname;

const STEP = await (async (): Promise<string> => {
  const document = Bun.YAML.parse(await Bun.file(ACTION).text());
  const steps = record(record(document)["runs"])["steps"];
  const scripts = (Array.isArray(steps) ? steps : [])
    .map((step) => record(step)["run"])
    .filter((run): run is string => typeof run === "string");
  const [script, ...rest] = scripts;
  if (script === undefined || rest.length > 0) {
    throw new Error(`test-suite has ${scripts.length} run steps, not one`);
  }
  return script;
})();

interface Run {
  readonly status: number;
  readonly output: string;
  /**
   * Who owns the report the run wrote. The suite is taken into a namespace as
   * root and handed straight back to the invoking user, and that second hop is
   * one line: without it every file the run touches — coverage, snapshots, this
   * report — lands root-owned in a workspace the steps after it still have to
   * write to, and the suite is green either way.
   */
  readonly reportUid: number | undefined;
  /** The junit the run wrote, or nothing when it never got that far. */
  readonly report: string | undefined;
}

/** What the run left at that path, or nothing when it never got that far. */
async function ownerOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).uid;
  } catch {
    return undefined;
  }
}

/**
 * The step against a suite of its own, with the runner's temp directory pointed
 * at the fixture — the junit report the step reads is per-run, and two cases
 * sharing one would grade each other's.
 */
async function ran(tree: Tree, network = ""): Promise<Run> {
  const root = await materialise(tree);
  const proc = Bun.spawn(["bash", "-c", STEP], {
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: root, TEST_NETWORK: network },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  const report = Bun.file(join(root, "junit.xml"));
  return {
    status,
    output: out + err,
    reportUid: await ownerOf(join(root, "junit.xml")),
    report: (await report.exists()) ? await report.text() : undefined,
  };
}

const REACHES: Tree = {
  "reaches.test.ts": `import { expect, test } from "bun:test";

test("reaches a live host", async () => {
  const response = await fetch("https://example.com");
  expect(response.status).toBe(200);
});
`,
};

/**
 * A server the test starts and calls on 127.0.0.1, which is not a network call
 * and must survive the seal — a namespace's loopback is created down, and a
 * gate that left it there would refuse the in-process integration test as
 * though it had dialled somebody else's host.
 */
const LOOPBACK: Tree = {
  "loopback.test.ts": `import { expect, test } from "bun:test";

test("calls itself", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("here") });
  const answered = await fetch(server.url);
  expect(await answered.text()).toBe("here");
  await server.stop(true);
});
`,
};

/**
 * How many processes are still running this fixture's suite. The junit path is
 * in `bun test`'s own argv and is unique to the fixture, so it names this run's
 * tree and no other suite's — including the one asking the question.
 */
async function running(marker: string): Promise<number> {
  const found = Bun.spawn(["pgrep", "-f", marker], { stdout: "pipe", stderr: "ignore" });
  const listed = await new Response(found.stdout).text();
  await found.exited;
  return listed.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Polls until the count settles where the case needs it, or gives up and
 * returns what it last saw so the assertion reads the real number.
 *
 * Real time on purpose, and the one place in this repo that has to spend it:
 * what is being measured is a signal crossing three processes, which no clock
 * this suite could inject has any part in.
 */
async function settles(marker: string, wanted: (count: number) => boolean): Promise<number> {
  let count = await running(marker);
  for (let attempt = 0; attempt < 100 && !wanted(count); attempt += 1) {
    // oxlint-disable-next-line anti-slop/no-real-timers -- the subject is a real SIGTERM reaching a real process tree; there is no virtual clock a signal is delivered on
    await Bun.sleep(50);
    count = await running(marker);
  }
  return count;
}

/** A suite that outlives the step unless something takes it down with it. */
const SLOW: Tree = {
  "slow.test.ts": `import { expect, test } from "bun:test";

test("takes its time", async () => {
  await Bun.sleep(30000);
  expect(1).toBe(1);
});
`,
};

const CLEAN: Tree = {
  "clean.test.ts": `import { expect, test } from "bun:test";

test("adds", () => {
  expect(1 + 1).toBe(2);
});
`,
};

describe("the sealed lane", () => {
  // Graded by the exit status and by the case below it, never by the text of
  // the failure: which errno a blocked connection produces is Bun's business
  // and changes with it — `Unable to connect` became `getaddrinfo ETIMEOUT`
  // between two patch releases. What this gate claims is the difference between
  // these two runs over one tree, and that is what is asserted.
  test("a suite that dials a live host fails where the call is written", async () => {
    expect((await ran(REACHES)).status).not.toBe(0);
  });

  test("and passes once the caller has said why it has to", async () => {
    const { status, output } = await ran(
      REACHES,
      "the contract suite runs against the sandbox API",
    );
    expect(output).toContain(
      "::notice::the suite reaches a real network: the contract suite runs against the sandbox API",
    );
    expect(status).toBe(0);
  });

  // The seal is around the host, not around the process: a rule that dropped
  // loopback with the rest would be indistinguishable here from one that works,
  // until the first repo whose suite boots its own app.
  test("a suite that calls a server it started itself is untouched", async () => {
    expect(await ran(LOOPBACK)).toMatchObject({ status: 0 });
  });

  test("a suite that reaches nothing passes sealed", async () => {
    const { status, reportUid } = await ran(CLEAN);
    expect(status).toBe(0);
    // And comes back out as the user who started it. The hop that does this is
    // one line of the step, and dropping it leaves a run that still passes.
    const self = process.getuid?.();
    expect(self).toBeNumber();
    expect(reportUid).toBe(self);
  });

  test("a reason made of whitespace is no reason, and the seal holds", async () => {
    const { status, output } = await ran(REACHES, "   ");
    expect(output).not.toContain("::notice::the suite reaches a real network");
    expect(status).not.toBe(0);
  });

  test("a reason written across lines is refused, not truncated into the log", async () => {
    const { status, output } = await ran(REACHES, "the sandbox API\n::error::not a reason at all");
    expect(output).toContain("::error::test-network must be one line");
    expect(output).not.toContain("::error::not a reason at all");
    expect(status).not.toBe(0);
  });
  // The runner cancels a step by signalling the process it started and nothing
  // else, so what the step does with that signal decides whether the suite goes
  // with it. Left in the foreground, `bun test` outlives the shell that started
  // it — inside a namespace nothing can see into, on a machine about to be
  // reclaimed.
  test("a cancelled step takes the suite down with it", async () => {
    const root = await materialise(SLOW);
    const marker = join(root, "junit.xml");
    const proc = Bun.spawn(["bash", "-c", STEP], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: root, TEST_NETWORK: "" },
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(await settles(marker, (count) => count > 0)).toBeGreaterThan(0);
    proc.kill("SIGTERM");
    await proc.exited;
    expect(await settles(marker, (count) => count === 0)).toBe(0);
  });
});

/**
 * A repo's coverage floor and a module the suite barely touches. The floor is
 * per-file, so this one file decides the run; the bunfig is the fixture's own
 * because a tree with none is a tree bun collects over and floors at nothing.
 */
function floored(covered: boolean, collection = ""): Tree {
  return {
    "bunfig.toml": `[test]\n${collection}coverageThreshold = { lines = 0.9, functions = 0.9 }\ncoverageSkipTestFiles = true\n`,
    "lib.ts": `export function reached(): number {
  return 1;
}

export function unreached(n: number): number {
  const doubled = n * 2;
  const shifted = doubled - 3;
  return shifted;
}
`,
    "lib.test.ts": `import { expect, test } from "bun:test";
import { reached, unreached } from "./lib.ts";

test("reached", () => {
  expect(reached()).toBe(1);
});
${
  covered
    ? `
test("unreached", () => {
  expect(unreached(2)).toBe(1);
});
`
    : ""
}`,
  };
}

// The step is what applies a repo's declared floor — the argument is in
// docs/gates/test-suite.md — so the wrong implementation is the one that runs
// the suite without --coverage, which the under-covered tree below passes with
// every test green. Graded through the report the run wrote rather than the
// console: what makes the first case the coverage floor and not some other
// failure is that the run's own record says nothing in it failed.
describe("the coverage floor the repo declares", () => {
  test("a suite under the floor fails, with nothing failing", async () => {
    const { status, report } = await ran(floored(false));
    // Anchored on the root element, the way the step's own greps are: a
    // per-file <testsuite> line carries its own failure count.
    expect(report).toMatch(/<testsuites [^>]* failures="0"/);
    expect(status).not.toBe(0);
  });

  test("and the same tree passes once the floor is met", async () => {
    expect(await ran(floored(true))).toMatchObject({ status: 0 });
  });

  // Why the repo contract refuses `[test] coverage` outright rather than only
  // the `true` spelling. bun takes the bunfig key over the command line, so
  // `false` beats the --coverage above it: the tree the first case fails comes
  // back green here, under the same floor, over the same uncovered function.
  // Nothing in this step can see that — the argv is identical and the run is
  // honestly green — so the gate is the contract's refusal, and this case is
  // what proves that refusal is load-bearing rather than tidiness.
  test("a bunfig that vetoes collection takes the floor with it", async () => {
    const { status, report } = await ran(floored(false, "coverage = false\n"));
    expect(report).toMatch(/<testsuites [^>]* failures="0"/);
    expect(status).toBe(0);
  });
});

/**
 * A suite that only runs through its own bootstrap. The sentinel is an
 * environment variable the `test` script sets, which is the smallest honest
 * stand-in for what the real ones do — start containers, refuse a stray env
 * file, build fixtures — and it makes the two runs tell each other apart: bare
 * `bun test` over this tree fails at the assertion, and the declared script
 * passes.
 */
const BOOTSTRAPPED: Tree = {
  "package.json": JSON.stringify({ name: "wrapped", scripts: { test: "BOOTSTRAP=1 bun test" } }),
  "bootstrap.test.ts": `import { expect, test } from "bun:test";

test("ran through the repo's own bootstrap", () => {
  expect(process.env.BOOTSTRAP).toBe("1");
});
`,
};

// The lane is what the repo runs, not a command this gate picked for it. A repo
// whose suite needs a bootstrap declares it in `test` — nfp-elysia's starts
// testcontainers, and bare `bun test` there is designed to die on a dead-port
// sentinel — so the gate that ran `bun test` regardless was grading a command
// the repo had never asked anyone to run.
describe("the suite the repo declares", () => {
  test("a scripted suite is run through its script", async () => {
    expect(await ran(BOOTSTRAPPED)).toMatchObject({ status: 0 });
  });

  // The wrong implementation is the one that reads the script and replaces the
  // flags with it: the suite then runs, passes, and writes no report — so the
  // coverage floor is applied to nothing and both checks below it have nothing
  // to read. Graded on the report rather than the exit status, because a run
  // that lost the flags is honestly green.
  test("and the coverage and reporter flags reach it", async () => {
    const { report } = await ran(BOOTSTRAPPED);
    expect(report).toMatch(/<testsuites [^>]* skipped="0"/);
  });

  // The repo's own script is what runs, so a script that keeps the trailing
  // arguments to itself is a wrapper this gate cannot grade — and it says so by
  // name rather than letting the greps report a missing file as the fault they
  // were looking for.
  test("a script that swallows the flags is named, not read as a skipped test", async () => {
    const { status, output } = await ran({
      ...BOOTSTRAPPED,
      "package.json": JSON.stringify({
        name: "swallows",
        scripts: { test: "bash -c 'BOOTSTRAP=1 bun test'" },
      }),
    });
    expect(output).toContain("::error::the suite passed and wrote no junit report");
    expect(output).not.toContain("::error::skipped tests");
    expect(status).not.toBe(0);
  });

  // The fallback, and the reason it cannot be `bun run test` unconditionally:
  // with no script of that name bun runs the `test` on PATH — /usr/bin/test —
  // which fails on the first flag with a message about a binary operator.
  test.each([
    ["a manifest that declares no test script", { "package.json": '{ "name": "bare" }' }],
    ["no manifest at all", {}],
  ])("%s runs bun test itself", async (_what, manifest) => {
    expect(await ran({ ...CLEAN, ...manifest })).toMatchObject({ status: 0 });
  });
});

describe("the run the report proves happened", () => {
  test("a skipped test is a suite that ran over nothing", async () => {
    const { status, output } = await ran({
      ...CLEAN,
      "skipped.test.ts": `import { test } from "bun:test";

test.skip("needs a database", () => undefined);
`,
    });
    expect(output).toContain(
      "::error::skipped tests: a suite whose infrastructure is absent must fail, never skip",
    );
    expect(status).not.toBe(0);
  });

  test("a test that asserts nothing is a test that never ran", async () => {
    const { status, output } = await ran({
      ...CLEAN,
      "silent.test.ts": `import { test } from "bun:test";

test("does the thing", () => undefined);
`,
    });
    expect(output).toContain("the tests listed above asserted nothing");
    expect(status).not.toBe(0);
  });
});
