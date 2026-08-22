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
  return { status, output: out + err, reportUid: await ownerOf(join(root, "junit.xml")) };
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
  test("a suite that dials a live host fails where the call is written", async () => {
    const { status, output } = await ran(REACHES);
    expect(output).toContain("Unable to connect");
    expect(status).not.toBe(0);
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
    expect(output).toContain("Unable to connect");
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
