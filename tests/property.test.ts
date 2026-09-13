import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { plainly } from "../.github/actions/_lib/gate.ts";
import { RUNS_FACTOR, TIME_LIMIT } from "../property.ts";
import { materialise } from "./tree.ts";

/**
 * The budget every property test goes through, driven the only way it can
 * honestly be driven: a `bun test` per case, over a suite of its own, under the
 * environment that case is about.
 *
 * In-process there is nothing to grade. What `check` does is hand fast-check a
 * larger `numRuns`, and the only thing that says whether it worked is how many
 * times the predicate ran — so a case is a whole run of a whole test file and
 * the number it prints is the answer. That also puts each case's environment in
 * a process of its own, rather than in a variable this suite would be mutating
 * around itself.
 *
 * The default is graded against `fc.assert` rather than against the number 100:
 * "unset means fast-check's own default" is a claim about fast-check, and a
 * case asserting a literal would keep passing on the day the library changed
 * it — which is the day the claim stopped being true.
 */

// Every case here is a `bun test` of its own over a fixture tree. With the
// machine to itself each takes about 50ms and the one that spends its budget
// takes a second, against a 5s default — so a case is one busy neighbour away
// from reporting a timeout as a fault in the budget. The same 30s the mutation
// lane's suite gives a spawn, for the same reason.
setDefaultTimeout(30_000);

const REPO = dirname(import.meta.dir);

/**
 * This repo's own install, linked into each fixture: `bun test` resolves
 * `fast-check` out of the tree it is pointed at, and what a consumer has is
 * exactly this — the version this lockfile pins. `property.ts` itself is
 * reached by path, since a fixture is not an install of this package and
 * `@gokayo43/dev-config` resolves nowhere from inside one.
 */
const NODE_MODULES = join(REPO, "node_modules");

/** What a driven suite prints, and the whole of what a case reads back off it. */
const COUNTED = "counted=";

interface Ran {
  /** How many times the predicate ran, which is the number every case here is about. */
  readonly counted: number;
  readonly status: number;
  readonly output: string;
}

async function run(body: string, environment: Record<string, string> = {}): Promise<Ran> {
  const root = await materialise({ "budget.test.ts": body });
  await symlink(NODE_MODULES, join(root, "node_modules"));
  const proc = Bun.spawn(["bun", "test"], {
    cwd: root,
    env: { ...plainly(process.env), ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${out}${err}`;
  return { counted: Number(/counted=(\d+)/u.exec(output)?.[1] ?? "-1"), status, output };
}

/**
 * A suite that counts how many times its predicate ran and prints the number.
 * Through `check`, which is the subject — or through the call it wraps, which
 * is the oracle the default is compared against.
 */
function counting(through: "budgeted" | "bare", params = ""): string {
  const call =
    through === "budgeted"
      ? `import { check } from "${REPO}/property.ts";`
      : `import { assert as check } from "fast-check";`;
  return `import { expect, test } from "bun:test";
import { integer, property } from "fast-check";
${call}

test("counts", () => {
  let counted = 0;
  check(
    property(integer(), (value) => {
      counted++;
      expect(typeof value).toBe("number");
    })${params === "" ? "" : `, ${params}`},
  );
  console.log(\`${COUNTED}\${counted}\`);
});
`;
}

/**
 * A property whose single run costs more than any budget the run will give it.
 * Async, because that is where fast-check can interrupt inside a run at all: a
 * sync property is only ever interrupted between them, which leaves a success
 * behind and is the case the flag already covers.
 */
const SLOWER_THAN_ITS_BUDGET = `import { expect, test } from "bun:test";
import { asyncProperty, integer } from "fast-check";
import { check } from "${REPO}/property.ts";

test("outlasts the budget", async () => {
  await check(
    asyncProperty(integer(), async () => {
      await Bun.sleep(400);
      expect(1).toBe(1);
    }),
  );
  console.log("${COUNTED}1");
});
`;

/** A property that fails, so a case can read what fast-check says about a failure. */
function failing(kind: "sync" | "async"): string {
  const built =
    kind === "sync"
      ? `check(property(integer({ min: 0, max: 10 }), (value) => {
    expect(value).toBeLessThan(3);
  }));`
      : `await check(asyncProperty(integer({ min: 0, max: 10 }), async (value) => {
    await Promise.resolve();
    expect(value).toBeLessThan(3);
  }));`;
  return `import { expect, test } from "bun:test";
import { asyncProperty, integer, property } from "fast-check";
import { check } from "${REPO}/property.ts";

test("fails", async () => {
  ${built}
});
`;
}

describe("the house property budget", () => {
  // The claim is "unset is fast-check's default", and the only thing that knows
  // that number is fast-check. Graded as a difference against the library's own
  // `assert`, so the case still holds the day upstream changes it.
  test("with nothing set, a property runs exactly as many times as fast-check runs it", async () => {
    // Sequential, and every pair below is: two `bun test` children of this one,
    // started together, wedged on a machine that had just run the mutation
    // lane — and what a case here is about is a number, never a schedule.
    const budgeted = await run(counting("budgeted"));
    const bare = await run(counting("bare"));
    expect(budgeted.status).toBe(0);
    expect(bare.counted).toBeGreaterThan(0);
    expect(budgeted.counted).toBe(bare.counted);
  });

  // The whole point: the same test file searches further because the run said
  // so. A wrapper that dropped the factor passes every other case here.
  test("a factor multiplies the runs the caller asked for", async () => {
    const ran = await run(counting("budgeted", "{ numRuns: 7 }"), { [RUNS_FACTOR]: "9" });
    expect(ran.status).toBe(0);
    expect(ran.counted).toBe(63);
  });

  test("and multiplies fast-check's own default where the caller asked for nothing", async () => {
    const scaled = await run(counting("budgeted"), { [RUNS_FACTOR]: "3" });
    const bare = await run(counting("bare"));
    expect(scaled.counted).toBe(bare.counted * 3);
  });

  // A budget nothing can read is a budget nobody applied, and a nightly running
  // the developer's search all night while reporting the long one is the
  // failure this module exists to make visible.
  test.each(["0", "-1", "fifty", "1.5", "1e3"])(
    "a factor written %p fails the suite rather than being read as one",
    async (value) => {
      const ran = await run(counting("budgeted"), { [RUNS_FACTOR]: value });
      expect(ran.status).not.toBe(0);
      expect(ran.output).toContain(RUNS_FACTOR);
    },
  );

  // The pair is what makes a large factor safe to set fleet-wide: without the
  // limit, one slow property times fifty is a job that never ends.
  test("a time limit stops a property early, and an interrupted property still passes", async () => {
    const ran = await run(counting("budgeted"), { [RUNS_FACTOR]: "100000", [TIME_LIMIT]: "1000" });
    expect(ran.status).toBe(0);
    expect(ran.counted).toBeGreaterThan(0);
    expect(ran.counted).toBeLessThan(100_000 * 100);
  });

  test.each(["0", "-1", "soon"])(
    "and a time limit written %p is refused the same way",
    async (value) => {
      const ran = await run(counting("budgeted"), { [TIME_LIMIT]: value });
      expect(ran.status).not.toBe(0);
      expect(ran.output).toContain(TIME_LIMIT);
    },
  );

  // Everything that is not the budget is fast-check's, and a failing property
  // arrives with what reproduces it. A wrapper that caught and reworded the
  // failure would stand between a red suite and the line that replays it.
  test("a failing property fails the suite with the seed and the counterexample", async () => {
    const ran = await run(failing("sync"), { [RUNS_FACTOR]: "5" });
    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain("seed:");
    expect(ran.output).toContain("Counterexample:");
  });

  // An async property's `assert` answers a promise, and a wrapper typed `void`
  // would let the case finish before the property had run. What that costs is
  // read here as the report rather than as the status: bun still catches the
  // stray assertion, so a dropped promise is a red suite too — but it is a red
  // suite carrying a bare expect error, with no counterexample and no seed,
  // which is a failure nobody can replay (probed, bun 1.4.0).
  test("an async property is awaited, so its failure is the suite's", async () => {
    const ran = await run(failing("async"));
    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain("Counterexample:");
  });
});

describe("a property the budget could not search at all", () => {
  // The budget is a bound on spending, never a bar to clear — and holding that
  // takes more than `markInterruptAsFailure: false`, which only covers a run
  // interrupted after at least one success. fast-check reads an interruption
  // with no completed run as a failure whatever that flag says, so one async
  // property slower than the nightly's two minutes would have filed "Nightly is
  // red" every night: the exact outcome the budget exists to prevent.
  test("is a pass, not the red nightly the budget exists to prevent", async () => {
    const ran = await run(SLOWER_THAN_ITS_BUDGET, { [TIME_LIMIT]: "100" });
    expect(ran.status).toBe(0);
    expect(ran.output).toContain("property skipped");
    expect(ran.output).toContain("no run of this property finished inside it");
  });

  // And it is said out loud rather than swallowed: a property nobody searched
  // is worth knowing about, and a silent pass is indistinguishable from a
  // property that held.
  test("and says so with the limit and the seed that would replay it", async () => {
    const ran = await run(SLOWER_THAN_ITS_BUDGET, { [TIME_LIMIT]: "100" });
    expect(ran.output).toContain(`${TIME_LIMIT} is 100ms`);
    expect(ran.output).toContain("seed ");
  });

  // The other half: an interruption is only the budget's to forgive where the
  // budget is this module's. A property that failed on its own is a failure
  // however long it took.
  test("while a property that actually failed still fails under the same limit", async () => {
    const ran = await run(failing("sync"), { [TIME_LIMIT]: "60000" });
    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain("Counterexample:");
  });
});

describe("the two names the budget travels under", () => {
  // The variables are a protocol between `property.ts` and the step that sets
  // them, and that step is bash: it cannot import the names. So the one written
  // copy is held to the module's own here, which is the only place the two can
  // be compared at all.
  test("the test-suite action sets exactly the variables property.ts reads", async () => {
    const action = await Bun.file(join(REPO, ".github/actions/test-suite/action.yml")).text();
    expect(action).toContain(`${RUNS_FACTOR}=`);
    expect(action).toContain(`${TIME_LIMIT}=`);
  });
});
