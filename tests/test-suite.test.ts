import { describe, expect, test } from "bun:test";

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
  if (scripts.length !== 1) throw new Error(`test-suite has ${scripts.length} run steps, not one`);
  return scripts[0] ?? "";
})();

interface Run {
  readonly status: number;
  readonly output: string;
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
    env: { ...process.env, RUNNER_TEMP: root, NETWORK: network },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: await proc.exited, output: out + err };
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
    expect(await ran(CLEAN)).toMatchObject({ status: 0 });
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
