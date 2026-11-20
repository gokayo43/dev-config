import { describe, expect, test } from "bun:test";
import { chmod, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { record } from "../.github/actions/_lib/gate.ts";
import { BUNS } from "./buns.ts";
import { materialise, scratch, SPAWNED_CASE_MS, type Tree } from "./tree.ts";

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
  /** The junit the run wrote, or nothing when it never got that far. */
  readonly report: string | undefined;
  /** The fixture the step ran in, which is also its `RUNNER_TEMP`. */
  readonly root: string;
}

const PATH = process.env["PATH"] ?? "";

/** How both of the step's refusals to seal begin. */
const CANNOT_SEAL = "::error::the suite is run sealed in a network namespace";

/**
 * The step against a suite of its own, with the runner's temp directory pointed
 * at the fixture — the junit report the step reads is per-run, and two cases
 * sharing one would grade each other's. The step calls `bun` and `bwrap` by
 * name, so which ones it gets is a fact about `path`.
 */
async function stepped(tree: Tree, network: string, path: string, nightly: string): Promise<Run> {
  const root = await materialise(tree);
  const proc = Bun.spawn(["bash", "-c", STEP], {
    cwd: root,
    env: { ...process.env, PATH: path, RUNNER_TEMP: root, TEST_NETWORK: network, NIGHTLY: nightly },
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
    report: (await report.exists()) ? await report.text() : undefined,
    root,
  };
}

/**
 * The step on a machine that can seal a run, which every case but the two
 * about the refusal needs. A refusal throws with the step's own words: most
 * cases here grade a run that fails, and would pass over one that never
 * started.
 */
async function ran(tree: Tree, network = "", path = PATH, nightly = "false"): Promise<Run> {
  const run = await stepped(tree, network, path, nightly);
  if (run.output.includes(CANNOT_SEAL)) {
    throw new Error(`this machine cannot seal a run, which this suite needs:\n${run.output}`);
  }
  return run;
}

/**
 * A suite that calls a live host. Its case names its limit for the reason
 * `GRANDCHILD`'s does: a call cut short by a limit fails the suite as a sealed
 * one would, and an unsealed step would pass for sealed.
 */
const REACHES: Tree = {
  "reaches.test.ts": `import { expect, test } from "bun:test";

test("reaches a live host", async () => {
  const response = await fetch("https://example.com");
  expect(response.status).toBe(200);
}, ${SPAWNED_CASE_MS});
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
 * The command line of every process whose working directory is `root`, which
 * is every process of a suite the step started there, at whatever depth, and
 * the step itself. A process that exits while it is being read, and another
 * user's, whose directory is not ours to read, are not this suite's.
 */
async function processesIn(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if ((await readlink(`/proc/${name}/cwd`)) !== root) continue;
      found.push((await Bun.file(`/proc/${name}/cmdline`).text()).replaceAll("\0", " ").trim());
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES") continue;
      throw error;
    }
  }
  return found;
}

/**
 * Polls until the list settles where the case needs it, or gives up and
 * returns what it last saw so the assertion reads the real list.
 *
 * Real time on purpose: what is being measured is a signal crossing several
 * processes, which no clock this suite could inject has any part in.
 */
async function settles(root: string, wanted: (seen: string[]) => boolean): Promise<string[]> {
  let seen = await processesIn(root);
  for (let attempt = 0; attempt < 100 && !wanted(seen); attempt += 1) {
    // oxlint-disable-next-line anti-slop/no-real-timers -- the subject is a real signal reaching a real process tree; there is no virtual clock a signal is delivered on
    await Bun.sleep(50);
    seen = await processesIn(root);
  }
  return seen;
}

/**
 * A suite run through its `test` script that leaves a grandchild running,
 * which is the tree a signal to the step does not reach on its own: bwrap
 * passes none on, and `bun run` sits between the step and `bun test`. Its case
 * names a limit past its sleep rather than taking the one the step gives,
 * because a suite that timed itself out would leave the cases below passing on
 * a step that ends nothing.
 */
const GRANDCHILD: Tree = {
  "package.json": JSON.stringify({ name: "spawns", scripts: { test: "bun test" } }),
  "spawns.test.ts": `import { expect, test } from "bun:test";

test("leaves a grandchild running", async () => {
  Bun.spawn(["bash", "-c", "sleep 300; true"]);
  await Bun.sleep(30000);
  expect(1).toBe(1);
}, ${SPAWNED_CASE_MS});
`,
};

/** A suite that says who ran it, where, and with what environment. */
const WHERE: Tree = {
  "where.test.ts": `import { expect, test } from "bun:test";

test("says where it ran", () => {
  const where = { uid: process.getuid(), cwd: process.cwd(), path: process.env.PATH, marker: process.env.RUNNER_TEMP };
  console.log(\`where=\${JSON.stringify(where)}\`);
  expect(1).toBe(1);
});
`,
};

/** A suite that looks its own child up in `/proc` by the pid it was handed. */
const OWN_PROC: Tree = {
  "proc.test.ts": `import { expect, test } from "bun:test";

test("finds its child", async () => {
  const child = Bun.spawn(["sleep", "5"]);
  const line = await Bun.file(\`/proc/\${child.pid}/cmdline\`).text();
  child.kill();
  expect(line.replaceAll("\\0", " ").trim()).toBe("sleep 5");
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
    expect(await ran(CLEAN)).toMatchObject({ status: 0 });
  });

  // The seal changes the network and nothing else the suite can be told
  // apart by. A seal taken as root would write the suite's files root-owned
  // into a workspace the steps after it still write to, and one that reset the
  // environment would drop the runner's variables, its PATH, and with it the
  // runner's bun, which the step finds there. RUNNER_TEMP is the marker: the
  // runner sets it and nothing in the seal does.
  test("a sealed suite runs as the step's user, where the step is, with its environment", async () => {
    const { status, output, root } = await ran(WHERE);
    expect(status).toBe(0);
    const said = /^where=(.*)$/m.exec(output)?.[1];
    expect(said).toBeString();
    expect(JSON.parse(said ?? "")).toEqual({
      uid: process.getuid?.(),
      cwd: await realpath(root),
      path: PATH,
      marker: root,
    });
  });

  // The suite's pids are its process namespace's, so its `/proc` has to be that
  // namespace's too: under the host's, the pid a suite is handed for its own
  // child names some other process of the machine, or none.
  test("a pid the sealed suite is handed names that process in its /proc", async () => {
    expect(await ran(OWN_PROC)).toMatchObject({ status: 0 });
  });

  // Nothing here may need more of the runner than the user it already is: a
  // grant that lets one job's command run as root is one every job on that
  // runner can use for anything (dev-config#168).
  test("no command of the step runs as anyone else", async () => {
    expect(await Bun.file(ACTION).text()).not.toMatch(/\b(sudo|su|doas|pkexec|runuser|setpriv)\b/);
  });

  test("a reason made of whitespace is no reason, and the seal holds", async () => {
    const { status, output } = await ran(REACHES, "   ");
    expect(output).not.toContain("::notice::the suite reaches a real network");
    expect(status).not.toBe(0);
  });

  // Both terminators the runner honours, because it reads a child's stdout with
  // StreamReader.ReadLine — a carriage return, a line feed, or the pair. A guard
  // testing for the line feed alone takes the carriage-return spelling for a
  // one-line reason and echoes it, and the runner reads the second half as a
  // command of its own.
  test.each([
    ["a line feed", "the sandbox API\n::error::not a reason at all"],
    ["a carriage return", "the sandbox API\r::error::not a reason at all"],
    ["the pair", "the sandbox API\r\n::error::not a reason at all"],
  ])(
    "a reason written across lines by %s is refused, not truncated into the log",
    async (_terminator, reason) => {
      const { status, output } = await ran(REACHES, reason);
      expect(output).toContain("::error::test-network must be one line");
      expect(output).not.toContain("::error::not a reason at all");
      expect(status).not.toBe(0);
    },
  );
  // The runner ends a step by signalling the process it started and nothing
  // else: SIGINT, then SIGTERM, then SIGKILL, whether the run was cancelled or
  // ran out of its time. So each signal, sent alone, has to take the suite's
  // whole tree with it, grandchild included, wherever in the sequence the
  // step dies.
  test.each([
    ["SIGINT, which begins both a cancel and a run out of its time", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
    ["SIGKILL", "SIGKILL"],
  ] as const)("a step ended by %s leaves nothing of its suite running", async (_how, signal) => {
    const root = await realpath(await materialise(GRANDCHILD));
    const proc = Bun.spawn(["bash", "-c", STEP], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: root, TEST_NETWORK: "", NIGHTLY: "false" },
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(await settles(root, (seen) => seen.includes("sleep 300"))).toContain("sleep 300");
    proc.kill(signal);
    await proc.exited;
    expect(await settles(root, (seen) => seen.length === 0)).toEqual([]);
  });
});

/**
 * A runner whose PATH holds no bwrap: every directory on this one that holds
 * one, stood in for by a directory of links to all it holds but that.
 */
async function withoutBwrap(): Promise<string> {
  const entries: string[] = [];
  for (const entry of PATH.split(":")) {
    if (!(await Bun.file(join(entry, "bwrap")).exists())) {
      entries.push(entry);
      continue;
    }
    const shadow = await scratch();
    for (const name of await readdir(entry)) {
      if (name !== "bwrap") await symlink(join(entry, name), join(shadow, name));
    }
    entries.push(shadow);
  }
  return entries.join(":");
}

/**
 * A bwrap the kernel refuses a user namespace, as it answers: a copy of
 * bubblewrap 0.9.0 outside the AppArmor profile that lets `/usr/bin/bwrap`
 * create one, on Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns
 * at 1, said exactly this and exited 1 (tcs-hetzner, 2026-11-20).
 */
async function refusedBwrap(): Promise<string> {
  const dir = await scratch();
  await Bun.write(
    join(dir, "bwrap"),
    "#!/bin/sh\necho 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2\nexit 1\n",
  );
  await chmod(join(dir, "bwrap"), 0o755);
  return `${dir}:${PATH}`;
}

// What the runner lacks is named before the suite starts, rather than read
// off a suite that failed for a reason it never wrote.
describe("a runner that cannot seal", () => {
  test("with no bubblewrap is told to install it, and the suite never runs", async () => {
    const { status, output, report } = await stepped(CLEAN, "", await withoutBwrap(), "false");
    expect(output).toContain(`${CANNOT_SEAL}, which needs bubblewrap on the runner`);
    expect(report).toBeUndefined();
    expect(status).not.toBe(0);
  });

  test("whose bubblewrap is refused a namespace says so in bwrap's words, and the suite never runs", async () => {
    const { status, output, report } = await stepped(CLEAN, "", await refusedBwrap(), "false");
    expect(output).toContain("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    expect(output).toContain("bwrap has to be allowed to create a user namespace");
    expect(report).toBeUndefined();
    expect(status).not.toBe(0);
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

describe("the budget a nightly gets", () => {
  /** A suite that reports what the run gave it, which is the whole of what the budget is. */
  const BUDGETED: Tree = {
    "budget.test.ts": `import { expect, test } from "bun:test";

test("reads its budget", () => {
  console.log(\`factor=\${process.env.PROPERTY_RUNS_FACTOR ?? ""}\`);
  console.log(\`limit=\${process.env.PROPERTY_TIME_LIMIT_MS ?? ""}\`);
  expect(1).toBe(1);
});
`,
  };

  // A run where they were dropped is a nightly that searched exactly as far as
  // an ordinary run and said it had searched fifty times further.
  test("reaches the suite through the seal", async () => {
    const { status, output } = await ran(BUDGETED, "", PATH, "true");
    expect(status).toBe(0);
    expect(output).toContain("factor=50");
    expect(output).toContain("limit=120000");
  });

  test("and no other run is given one at all", async () => {
    const { status, output } = await ran(BUDGETED);
    expect(status).toBe(0);
    expect(output).toContain("factor=");
    expect(output).not.toContain("factor=50");
    expect(output).not.toContain("limit=120000");
  });

  // A spelling nobody defined would otherwise read as "not nightly", and the
  // long search would quietly never have happened.
  test("a spelling that is neither true nor false is refused", async () => {
    const { status, output } = await ran(CLEAN, "", PATH, "yes");
    expect(status).not.toBe(0);
    expect(output).toContain("it takes true or false");
  });
});

/**
 * How long a test outlasts bun's own five seconds by, in ms: what a correct
 * test takes on a runner host whose share of a core is 3%. A sleep stands in
 * for the starved CPU, because what the step decides is the wall time a test
 * may take, whatever it was spent on.
 */
const PAST_BUNS_DEFAULT = 5_500;

/** A limit a repo states for itself, in ms, and what a test that outlasts it sleeps. */
const STATED = 300;
const PAST_STATED = 2 * STATED;

/** A suite whose command is `bun test` itself, with its one case. */
function plain(name: string, prelude: string, body: string, limit = ""): Tree {
  return {
    [`${name}.test.ts`]: `import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";

${prelude}

test("${name}", async () => {
  ${body}
  expect(1).toBe(1);
}${limit});
`,
  };
}

/**
 * A suite that prints every --timeout on the command line of the `bun test`
 * that ran it, which is what the step gave it once its script had been run.
 */
const LIMITS: Tree = {
  "limits.test.ts": `import { expect, test } from "bun:test";

test("reads its limits", async () => {
  const argv = (await Bun.file("/proc/self/cmdline").text()).split("\\0");
  const timeouts = argv.flatMap((arg, at) => (arg === "--timeout" ? [argv[at + 1]] : []));
  console.log(\`timeouts=\${JSON.stringify(timeouts)}\`);
  expect(1).toBe(1);
});
`,
};

/** A manifest whose `test` script is `bun test` stating its own limit. */
const STATING = JSON.stringify({
  name: "states",
  scripts: { test: `bun test --timeout ${STATED}` },
});

/**
 * `LIMITS` behind a suite command its repo designed, which hands the
 * arguments the step gave it to the `bun test` it ends in, as the gate requires.
 */
const WRAPPED: Tree = {
  ...LIMITS,
  "package.json": JSON.stringify({ name: "wrapped", scripts: { test: "bun wrapper.ts" } }),
  "wrapper.ts": `const suite = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await suite.exited);
`,
};

describe("the limit a test is given", () => {
  // Both shapes whose command is `bun test` itself, no script and a script of
  // exactly that, one per fixture, side by side so the suite waits out bun's
  // five seconds once. A step that appended nothing fails both at five.
  test("a test and a hook that outlast bun's five seconds pass", async () => {
    const [hook, slow] = await Promise.all([
      ran(plain("hook", `beforeAll(() => Bun.sleep(${PAST_BUNS_DEFAULT}));`, "")),
      ran({
        ...plain("slow", "", `await Bun.sleep(${PAST_BUNS_DEFAULT});`),
        "package.json": JSON.stringify({ name: "plain", scripts: { test: "bun test" } }),
      }),
    ]);
    expect(hook).toMatchObject({ status: 0 });
    expect(slow).toMatchObject({ status: 0 });
  });

  // One row per place a repo can state its own limit. bun keeps the last
  // --timeout it is given, so a step appending its minute to every script
  // passes the first row; the other two are bun's precedence over the flag,
  // which is what the gate's page tells a repo to rely on.
  test.each([
    [
      "its test script",
      {
        ...plain("stated", "", `await Bun.sleep(${PAST_STATED});`),
        "package.json": STATING,
      },
    ],
    [
      "a file's setDefaultTimeout",
      plain("stated", `setDefaultTimeout(${STATED});`, `await Bun.sleep(${PAST_STATED});`),
    ],
    ["the test itself", plain("stated", "", `await Bun.sleep(${PAST_STATED});`, `, ${STATED}`)],
  ])("a limit stated in %s is the one its test fails at", async (_place, tree) => {
    const { status, output } = await ran(tree);
    expect(output).toContain(`timed out after ${STATED}ms`);
    expect(status).not.toBe(0);
  });

  // A designed suite command is left alone off the nightly, and the nightly's
  // ten minutes reach every shape, last on the line so that bun keeps them over
  // a limit the script states. A step that judged the shape on the nightly too
  // would drop them from the last two rows.
  test.each([
    ["off the nightly, a script that is not bun test is given none", WRAPPED, "false", []],
    ["on the nightly, no test script is given ten minutes", LIMITS, "true", ["600000"]],
    [
      "on the nightly, a script stating its own limit is given ten minutes after it",
      { ...LIMITS, "package.json": STATING },
      "true",
      [`${STATED}`, "600000"],
    ],
    [
      "on the nightly, a script that is not bun test is given ten minutes",
      WRAPPED,
      "true",
      ["600000"],
    ],
  ])("%s", async (_shape, tree, nightly, timeouts) => {
    const { status, output } = await ran(tree, "", PATH, nightly);
    expect(output).toContain(`timeouts=${JSON.stringify(timeouts)}`);
    expect(status).toBe(0);
  });
});

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

  // Under EVERY bun on the machine, because which script the step finds is a
  // question bun answers and the two versions in this fleet answered it
  // differently. Asking `require("./package.json")` and letting the absent file
  // throw worked on 1.4.0 and printed the word `undefined` on 1.3.11 — a
  // non-empty answer, so every fixture with no manifest went to `bun run test`,
  // which is `/usr/bin/test` and dies on the first flag. That shipped green
  // here and red on the runner, whose bun is the one `packageManager` names.
  test("the suite found more than one bun to run the step under", () => {
    expect(BUNS.length).toBeGreaterThan(0);
  });

  // One shape per bun rather than both: what differs across versions is how the
  // ABSENT manifest is read, and a sealed run costs a process tree and a
  // namespace apiece. The declared-script path is graded above under this
  // process's own bun, and nothing about it was ever version-dependent.
  test.each(BUNS)("under %s a tree with no manifest still runs bun test itself", async (bun) => {
    expect(await ran(CLEAN, "", `${dirname(bun)}:${PATH}`)).toMatchObject({ status: 0 });
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
