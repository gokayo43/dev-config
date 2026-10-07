/**
 * The count budget, driven over a real browser against fixture pages: a React
 * list with three regressions planted in it, plain pages whose counts a test
 * can predict, and pages that break each precondition of a steady count.
 *
 * Every Playwright run happens up front, because a run costs more than the
 * cases graded on it, and the cases below read what the runs reported and what
 * they left in the ceilings files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { type ConfigObject, record } from "../.github/actions/_lib/gate.ts";
import { bootId } from "../file-lock.ts";
import { type Count, COUNTS, type Counts } from "../count-ceilings.ts";
import {
  fixture,
  type Outcome,
  playwright,
  ROWS,
  serving,
  SOURCE,
} from "./count-budget-fixture.ts";

const WRITE = { COUNT_BUDGET: "write" };

/** How many runs of one page are graded as identical, quiet and with every core loaded: dev-config#142 measured 20 to 25. */
const RUNS = 20;

const LIST = `async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/app?plant=" + plant));
  await budget.phase("hover", async () => {
    for (let row = 0; row < 5; row++) await page.locator("li").nth(row).hover();
  });
  await budget.phase("more", () => page.getByRole("button", { name: "more" }).click());
}`;

const PLANTS = ["none", "rerender", "request", "heavy"] as const;

const PLANTED = `import { test } from ${SOURCE};

for (const plant of ${JSON.stringify(PLANTS)}) {
  test("the list, planted " + plant, ${LIST});
}
`;

const STEADY = `import { test } from ${SOURCE};

test("the list", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/app"));
  await budget.phase("more", () => page.getByRole("button", { name: "more" }).click());
});
`;

const PHASES = `import { test } from ${SOURCE};

test("work that runs on past load", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/tail?tail"));
  await budget.phase("add", () => page.click("#late"));
});

test("no work past load", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/tail"));
});

test("a click that leaves the page", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/leaving"));
  await budget.phase("go", () => page.click("#go"));
});

test("the page it lands on", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
});
`;

const REFUSALS = `import { test } from ${SOURCE};

const other = process.env.OTHER;

test("an unstubbed origin", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/external"));
});

test("a stubbed origin", async ({ page, budget }) => {
  await page.route(other + "/data", (route) =>
    route.fulfill({ body: "stubbed", headers: { "access-control-allow-origin": "*" } }),
  );
  await budget.phase("load", () => page.goto("/external"));
});

test("an aborted origin", async ({ page, budget }) => {
  await page.route(other + "/data", (route) => route.abort());
  await budget.phase("load", () => page.goto("/external"));
});

test.describe(() => {
  test.use({ servedOrigins: [other] });
  test("an origin the test serves", async ({ page, budget }) => {
    await budget.phase("load", () => page.goto("/external"));
  });
});

test("motion that ignores reduced motion", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/restless"));
});

test("motion that honours reduced motion", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/motion"));
});

test("a blob the page made itself", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/blob"));
});

test("a request that never finishes", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/hanging"));
});

test("a phase name used twice", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
  await budget.phase("load", () => page.goto("/landing"));
});

test("no phase marked", async ({ page, budget }) => {
  await page.goto("/landing");
});

test("an unstubbed WebSocket", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/socket"));
});

test("a stubbed WebSocket", async ({ page, budget }) => {
  await page.routeWebSocket(other.replace(/^http/, "ws") + "/", (socket) => socket.send("stubbed"));
  await budget.phase("load", () => page.goto("/socket"));
});

test("a service worker that reaches out", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/worker"));
});

test("a page that turns React's hook off", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/hardened"));
});

test("a page that overwrites React's hook", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/neutered"));
});

test("a service worker's fetch that outlives the load", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/slow-worker"));
});

test("a stub the page gave up on", async ({ page, budget }) => {
  await page.route(other + "/data", async (route) => {
    await new Promise((done) => setTimeout(done, 100));
    await route.fulfill({ body: "stubbed", headers: { "access-control-allow-origin": "*" } });
  });
  await budget.phase("load", () => page.goto("/impatient"));
});

test("frames the page did not start with", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/framed"));
});

test("a click that sends a beacon as it leaves", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/beacon"));
  await budget.phase("go", () => page.click("#go"));
});

test.describe(() => {
  test.use({ servedOrigins: [other + "/"] });
  test("an origin the test serves, written as a URL", async ({ page, budget }) => {
    await budget.phase("load", () => page.goto("/external"));
  });
});

test("a test skipped after a phase", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
  test.skip(true, "skipped at run time");
});

test("a phase whose failure the test caught", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
  await budget.phase("boom", async () => { throw new Error("boom"); }).catch(() => {});
});

test("a refusal the test caught", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/restless")).catch(() => {});
});

test("phases named after what every object has", async ({ page, budget }) => {
  for (const phase of ["constructor", "__proto__", "toString"]) {
    await budget.phase(phase, () => page.goto("/landing"));
  }
});

test("toString", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
});

test("zeal", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
});

test("ärlig", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/landing"));
});

test.describe(() => {
  test.describe.configure({ retries: 1 });
  test("a retried test", async ({ page, budget }, testInfo) => {
    if (testInfo.retry === 0) throw new Error("the first attempt fails");
    await budget.phase("load", () => page.goto("/landing"));
  });
});
`;

/**
 * The ratchet's cases: per test, the phases it marks at each stage, each a page
 * on `/counted` that appends `mutations` elements and fetches `requests` times.
 * Between the stages the suite edits the file the first stage wrote, as the
 * test's name says.
 */
interface Stage {
  readonly before?: [string, string][];
  readonly after: [string, string][];
}

/** A stage typed where it is written, for the one key `Object.prototype` also has. */
const staged = (stage: Stage): Stage => stage;

const STAGES = {
  unchanged: {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=3&requests=2"]],
  },
  rose: {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=5&requests=2"]],
  },
  dropped: {
    before: [["load", "mutations=5&requests=2"]],
    after: [["load", "mutations=3&requests=2"]],
  },
  "raised with a reason": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=5&requests=2"]],
  },
  "raised by hand": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=5&requests=2"]],
  },
  "raised with no reason": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=5&requests=2"]],
  },
  "raised above what the page does": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=3&requests=2"]],
  },
  "a phase added": {
    before: [["load", "mutations=3&requests=2"]],
    after: [
      ["load", "mutations=3&requests=2"],
      ["again", "mutations=1&requests=0"],
    ],
  },
  "a phase dropped": {
    before: [
      ["load", "mutations=3&requests=2"],
      ["again", "mutations=1&requests=0"],
    ],
    after: [["load", "mutations=3&requests=2"]],
  },
  "a new browser": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=4&requests=2"]],
  },
  "a page that stopped being React": {
    before: [["load", "app"]],
    after: [["load", "mutations=3&requests=2"]],
  },
  "not in the file": { after: [["load", "mutations=3&requests=2"]] },
  "raised by hand, then the page drops": {
    before: [["load", "mutations=3&requests=2"]],
    after: [["load", "mutations=4&requests=2"]],
  },
  "skipped after a phase": {
    before: [
      ["load", "mutations=3&requests=2"],
      ["again", "mutations=1&requests=0"],
    ],
    after: [
      ["load", "mutations=3&requests=2"],
      ["skip", ""],
    ],
  },
  valueOf: staged({
    before: [
      ["constructor", "mutations=3&requests=2"],
      ["__proto__", "mutations=1&requests=0"],
    ],
    after: [
      ["constructor", "mutations=3&requests=2"],
      ["__proto__", "mutations=1&requests=0"],
    ],
  }),
} satisfies Record<string, Stage>;

const RATCHET = `import { test } from ${SOURCE};

const stages = ${JSON.stringify(STAGES)};
const stage = process.env.STAGE;

for (const [title, phases] of Object.entries(stages)) {
  test(title, async ({ page, budget }) => {
    test.skip(phases[stage] === undefined, "not marked at this stage");
    for (const [phase, asked] of phases[stage]) {
      if (phase === "skip") test.skip(true, "skipped at run time");
      await budget.phase(phase, () => page.goto(asked === "app" ? "/app" : "/counted?" + asked));
    }
  });
}
`;

/** Sixteen tests of one file, which a fully parallel config spreads over four workers writing one ceilings file. */
const PARALLEL = `import { test } from ${SOURCE};

for (let each = 0; each < 16; each++) {
  test("writer " + each, async ({ page, budget }) => {
    await budget.phase("load", () => page.goto("/landing"));
  });
}
`;

/** A spec exactly as a consumer writes one, by the package's own specifier, under the runner Playwright brings. */
const INSTALLED = `import { expect } from "@playwright/test";
import { test } from "@gokayo43/dev-config/count-budget";

test("a consumer's spec runs", async ({ page, budget }) => {
  expect(process.versions.bun).toBeUndefined();
  await budget.phase("load", () => page.goto("/tail?tail"));
  await budget.phase("add", () => page.click("#late"));
});
`;

type Runs = Map<string, Outcome[]>;

/** The moments a ceilings file is read at, by spec and by stage. */
type Moment =
  | "planted first"
  | "phases first"
  | "refusals first"
  | "ratchet first"
  | "ratchet edited"
  | "ratchet lowered"
  | "parallel"
  | "consumer";

/** Everything the runs up front reported and left behind, which the cases below read. */
interface Ran {
  readonly first: Runs;
  readonly checked: Runs;
  readonly lowered: Runs;
  readonly rechecked: Runs;
  readonly quiet: Runs;
  readonly loaded: Runs;
  readonly consumer: Runs;
  readonly parallel: Runs;
  /** What the write command said under `CI`, and under a mode it does not take. */
  readonly inCi: string;
  readonly wrongMode: string;
  /** What the parallel tree held beside its spec after the run that found a dead worker's lock. */
  readonly leftBeside: readonly string[];
  /** How many cores' worth of CPU the spinning processes took while the loaded runs ran. */
  readonly cores: number;
  readonly files: Readonly<Record<Moment, ConfigObject>>;
}

let ran: Ran | undefined;
let stop = async (): Promise<void> => {};

function results(): Ran {
  if (ran === undefined) throw new Error("the runs up front did not finish");
  return ran;
}

async function json(path: string): Promise<ConfigObject> {
  const parsed: unknown = await Bun.file(path).json();
  return record(parsed);
}

function phasesIn(file: ConfigObject, title: string): ConfigObject {
  return record(record(file[title])["phases"]);
}

/** A count's ceiling as the file holds it: a number, a raised ceiling, or nothing. */
type Held = number | ConfigObject | undefined;

function heldIn(file: ConfigObject, title: string, phase: string, count: string): Held {
  const held = record(phasesIn(file, title)[phase])[count];
  if (held === undefined || typeof held === "number") return held;
  return record(held);
}

/** A ceiling as the check reads it: the number, or a raised ceiling's `ceiling`. */
function ceilingOf(held: Held): number {
  return typeof held === "number" ? held : Number(record(held)["ceiling"]);
}

/** How many cores' worth of CPU a process has taken so far, over `seconds` of wall time. */
async function coresTaken(pid: number, seconds: number): Promise<number> {
  const fields = (await Bun.file(`/proc/${pid}/stat`).text()).split(") ")[1]?.split(" ") ?? [];
  const ticks = Number(fields[11]) + Number(fields[12]);
  return ticks / 100 / seconds;
}

/** One process per core spinning for as long as `during` runs, stopped by the PIDs it was started with. */
async function underLoad<Answer>(
  during: () => Promise<Answer>,
): Promise<{ answer: Answer; cores: number }> {
  const spinners = Array.from({ length: availableParallelism() }, () =>
    Bun.spawn([process.execPath, "-e", "for (;;) {}"], { stdout: "ignore", stderr: "ignore" }),
  );
  const began = performance.now();
  try {
    const answer = await during();
    const seconds = (performance.now() - began) / 1000;
    const taken = await Promise.all(
      spinners.map(async (spinner) => await coresTaken(spinner.pid, seconds)),
    );
    return { answer, cores: taken.reduce((sum, each) => sum + each, 0) };
  } finally {
    for (const spinner of spinners) spinner.kill();
    await Promise.all(spinners.map(async (spinner) => await spinner.exited));
  }
}

/** The stage between the two runs of the ratchet: each case's entry edited as its title says. */
function edited(file: ConfigObject, browser: string): void {
  const load = (title: string): ConfigObject => record(phasesIn(file, title)["load"]);
  const plain = (title: string): number => {
    const held = load(title)["mutationRecords"];
    if (typeof held !== "number") {
      throw new Error(`the first run wrote no plain mutationRecords for ${title}`);
    }
    return held;
  };
  const raise = (title: string, by: number, reason: string): void => {
    const was = plain(title);
    load(title)["mutationRecords"] = { ceiling: was + by, was, reason };
  };
  raise("raised with a reason", 2, "the list now shows two more rows");
  raise("raised with no reason", 2, " ");
  raise("raised above what the page does", 4, "headroom nobody should have asked for");
  load("raised by hand")["mutationRecords"] = plain("raised by hand") + 2;
  load("raised by hand, then the page drops")["mutationRecords"] =
    plain("raised by hand, then the page drops") + 2;
  record(file["a new browser"])["browser"] = `${browser.split(" ")[0]} 1.0.0.0`;
}

beforeAll(async () => {
  const server = await serving();
  stop = server.stop;
  const env = { OTHER: server.other };

  const root = await fixture(
    server.origin,
    {
      "planted.spec.ts": PLANTED,
      "phases.spec.ts": PHASES,
      "refusals.spec.ts": REFUSALS,
      "ratchet.spec.ts": RATCHET,
    },
    { workers: 2 },
  );
  const at = (name: string): string => join(root, `${name}.spec.counts.json`);
  // The planted lists are left out: the unplanted one writes the ceilings
  // every one of them is checked against.
  const first = await playwright(root, { ...WRITE, ...env, STAGE: "before" }, [
    "--grep-invert",
    "planted (rerender|request|heavy)",
  ]);
  const plantedFirst = await json(at("planted"));
  const phasesFirst = await json(at("phases"));
  const refusalsFirst = await json(at("refusals"));
  const ratchetFirst = await json(at("ratchet"));

  const planted = await json(at("planted"));
  const none = record(planted["the list, planted none"]);
  for (const plant of PLANTS) planted[`the list, planted ${plant}`] = none;
  await Bun.write(at("planted"), JSON.stringify(planted, null, 2));

  const ratchet = await json(at("ratchet"));
  edited(ratchet, String(none["browser"]));
  await Bun.write(at("ratchet"), JSON.stringify(ratchet, null, 2));
  const ratchetEdited = await json(at("ratchet"));

  const checked = await playwright(root, { ...env, STAGE: "after" }, [
    "planted.spec.ts",
    "ratchet.spec.ts",
  ]);
  const lowered = await playwright(root, { ...WRITE, ...env, STAGE: "after" }, ["ratchet.spec.ts"]);
  const ratchetLowered = await json(at("ratchet"));

  // The raise the command just kept, raised again in place under its old reason.
  const kept = await json(at("ratchet"));
  const again = record(record(phasesIn(kept, "raised with a reason")["load"])["mutationRecords"]);
  again["ceiling"] = Number(again["ceiling"]) + 500;
  await Bun.write(at("ratchet"), JSON.stringify(kept, null, 2));
  const rechecked = await playwright(root, { ...env, STAGE: "after" }, [
    "ratchet.spec.ts",
    "--grep",
    "raised with a reason",
  ]);

  const inCi = await playwright(root, { ...WRITE, CI: "true", ...env, STAGE: "after" }, [
    "phases.spec.ts",
  ]).then(
    () => "",
    (error: Error) => error.message,
  );

  const wrongMode = await playwright(root, { COUNT_BUDGET: "yes", ...env, STAGE: "after" }, [
    "phases.spec.ts",
  ]).then(
    () => "",
    (error: Error) => error.message,
  );

  const writers = await fixture(
    server.origin,
    { "parallel.spec.ts": PARALLEL },
    { workers: 4, fullyParallel: true },
  );
  const parallelCeilings = join(writers, "parallel.spec.counts.json");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const gone = JSON.stringify({ pid: dead.pid, bootId: await bootId(), startTicks: 0 });
  // A worker killed while writing: its lock, the file it was staging, and the
  // file another worker killed while waiting for that lock wrote its holder to.
  await Bun.write(`${parallelCeilings}.lock`, gone);
  await Bun.write(`${parallelCeilings}.${dead.pid}.writing`, "what a writer killed mid-write left");
  await Bun.write(`${parallelCeilings}.lock.${dead.pid}-0a0a0a0a`, gone);
  const parallel = await playwright(writers, WRITE);
  const parallelFile = (await Bun.file(parallelCeilings).exists())
    ? await json(parallelCeilings)
    : {};
  const leftBeside = (await readdir(writers)).filter((name) =>
    name.startsWith("parallel.spec.counts"),
  );

  const installed = await fixture(server.origin, { "consumer.spec.ts": INSTALLED }, { workers: 1 });
  const consumer = await playwright(installed, WRITE);
  const consumerFile = await json(join(installed, "consumer.spec.counts.json"));

  const steady = await fixture(server.origin, { "steady.spec.ts": STEADY }, { workers: 1 });
  const repeated = ["--repeat-each", String(RUNS)];
  const quiet = await playwright(steady, WRITE, repeated);
  const underCores = await underLoad(async () => await playwright(steady, WRITE, repeated));

  ran = {
    first,
    checked,
    lowered,
    rechecked,
    quiet,
    loaded: underCores.answer,
    consumer,
    parallel,
    inCi,
    wrongMode,
    leftBeside,
    cores: underCores.cores,
    files: {
      "planted first": plantedFirst,
      "phases first": phasesFirst,
      "refusals first": refusalsFirst,
      "ratchet first": ratchetFirst,
      "ratchet edited": ratchetEdited,
      "ratchet lowered": ratchetLowered,
      parallel: parallelFile,
      consumer: consumerFile,
    },
  };
}, 600_000);

afterAll(async () => {
  await stop();
});

function runsOf(runs: Runs, title: string): Outcome[] {
  const found = runs.get(title);
  if (found === undefined) {
    throw new Error(
      `the Playwright run reported nothing for ${title}; it reported ${[...runs.keys()].join(", ")}`,
    );
  }
  return found;
}

/** A test's last result, which is the retry where there was one. */
function only(runs: Runs, title: string): Outcome {
  const [outcome] = runsOf(runs, title).slice(-1);
  if (outcome === undefined) throw new Error(`the Playwright run has no result for ${title}`);
  return outcome;
}

function phaseOf(runs: Runs, title: string, phase: string): Counts {
  const { counts, said } = only(runs, title);
  const found = counts?.[phase];
  if (found === undefined)
    throw new Error(`${title} measured no ${phase} phase; it said:\n${said}`);
  return found;
}

function countOf(counts: Counts, count: Count): number {
  const found = counts[count];
  if (found === undefined) throw new Error(`no ${count} in ${JSON.stringify(counts)}`);
  return found;
}

function fileOf(moment: Moment): ConfigObject {
  return results().files[moment];
}

describe("the counts a phase reports", () => {
  // The tail lands after `load` and after Playwright's network idle, in tasks
  // that never leave the page idle; a phase that ended at either misses it.
  test("a phase is charged with the work that finished after its action returned", () => {
    const tail = phaseOf(results().first, "work that runs on past load", "load");
    const none = phaseOf(results().first, "no work past load", "load");
    expect(countOf(tail, "mutationRecords") - countOf(none, "mutationRecords")).toBe(5);
  });

  // The click waits for the tail's button, so a boundary that did not wait for
  // the tail charges its five elements here.
  test("a phase is charged with nothing the phase before it did", () => {
    expect(phaseOf(results().first, "work that runs on past load", "add")).toEqual({
      mutationRecords: 1,
      requests: 0,
      bodyBytes: 0,
      scriptBytes: 0,
    });
  });

  test("a phase that leaves the page is charged with what the page it left did", () => {
    const go = phaseOf(results().first, "a click that leaves the page", "go");
    const landing = phaseOf(results().first, "the page it lands on", "load");
    expect(go).toEqual({ ...landing, mutationRecords: countOf(landing, "mutationRecords") + 1 });
  });

  test("a page with no React renderer reports no commit count", () => {
    for (const title of [
      "work that runs on past load",
      "no work past load",
      "the page it lands on",
    ]) {
      for (const counts of Object.values(only(results().first, title).counts ?? {})) {
        expect(counts).not.toHaveProperty("reactCommits");
      }
    }
  });

  test("a React phase in which nothing committed reports zero commits", () => {
    expect(phaseOf(results().first, "the list, planted none", "hover")).toHaveProperty(
      "reactCommits",
      0,
    );
  });

  test("every count of the list's load and of its interaction is above zero", () => {
    for (const phase of ["load", "more"]) {
      const counts = phaseOf(results().first, "the list, planted none", phase);
      for (const count of COUNTS) {
        expect(countOf(counts, count), `${phase} ${count}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("one page, the same counts on every run", () => {
  test.each([
    ["quiet", (): Runs => results().quiet],
    ["with every core loaded", (): Runs => results().loaded],
  ])("%s", (_, runs) => {
    const all = runsOf(runs(), "the list");
    const measured = only(runs(), "the list");
    expect(all).toHaveLength(RUNS);
    expect(measured).toMatchObject({ ok: true, said: "" });
    for (const run of all) expect(run).toEqual(measured);
  });

  // The bar is half a core, not every core: a CI runner's cgroup caps the
  // whole job at two cores, where the spinners compete with the browser and
  // the runner for the same quota, and half a core is what they can be relied
  // on to take there. Under the three-core cap of a session on this box they
  // took 2.46.
  test("the loaded runs ran with the spinners taking more than half a core", () => {
    expect(results().cores).toBeGreaterThan(0.5);
  });

  test("quiet and loaded runs agree", () => {
    expect(only(results().loaded, "the list").counts).toEqual(
      only(results().quiet, "the list").counts,
    );
  });
});

describe("a planted regression fails the ceiling the unplanted list wrote", () => {
  const none = (phase: string, count: Count): number =>
    countOf(phaseOf(results().checked, "the list, planted none", phase), count);

  test("the unplanted list passes its own ceilings", () => {
    expect(only(results().checked, "the list, planted none")).toMatchObject({ ok: true, said: "" });
  });

  test("a hover that re-renders every row raises commits and mutation records", () => {
    const { ok, said } = only(results().checked, "the list, planted rerender");
    const hover = phaseOf(results().checked, "the list, planted rerender", "hover");
    expect(ok).toBe(false);
    expect(countOf(hover, "reactCommits")).toBeGreaterThan(none("hover", "reactCommits"));
    expect(said).toContain("«the list, planted rerender»");
    for (const count of ["reactCommits", "mutationRecords"] as const) {
      expect(said).toContain(
        `«hover» ${count}: measured ${countOf(hover, count)}, ceiling ${none("hover", count)}`,
      );
    }
  });

  test("a request per row raises the request count", () => {
    const { ok, said } = only(results().checked, "the list, planted request");
    expect(ok).toBe(false);
    for (const phase of ["load", "more"]) {
      const ceiling = none(phase, "requests");
      expect(said).toContain(`«${phase}» requests: measured ${ceiling + ROWS}, ceiling ${ceiling}`);
    }
  });

  test("a heavier payload raises body bytes", () => {
    const { ok, said } = only(results().checked, "the list, planted heavy");
    const heavy = countOf(
      phaseOf(results().checked, "the list, planted heavy", "load"),
      "bodyBytes",
    );
    expect(ok).toBe(false);
    expect(heavy).toBeGreaterThan(none("load", "bodyBytes"));
    expect(said).toContain(
      `«load» bodyBytes: measured ${heavy}, ceiling ${none("load", "bodyBytes")}`,
    );
  });
});

describe("the check", () => {
  test.each([
    ["unchanged", true, ""],
    ["rose", false, "The page does more of this work than its ceiling allows"],
    [
      "dropped",
      false,
      "The page does less than its ceiling, so the ceiling comes down to match: run COUNT_BUDGET=write bunx playwright test ratchet.spec.ts",
    ],
    ["raised with a reason", false, "the command has not kept the raise yet"],
    ["raised by hand", false, "were edited by hand"],
    ["raised by hand, then the page drops", false, "were edited by hand"],
    ["valueOf", true, ""],
    ["raised with no reason", false, "with no reason"],
    ["raised above what the page does", false, "The page does less than its ceiling"],
    ["a phase added", false, "«again» has no ceilings"],
    [
      "a phase dropped",
      false,
      "«again» has ceilings, and this test no longer marks a phase of that name",
    ],
    ["a new browser", false, "were measured on chromium 1.0.0.0, and this run is chromium"],
    ["a page that stopped being React", false, "no React renderer ran in this phase"],
    ["not in the file", false, "no ceilings for this test in ratchet.spec.counts.json"],
  ])("%s", (title, ok, said) => {
    const outcome = only(results().checked, title);
    expect(outcome.ok).toBe(ok);
    expect(outcome.said).toContain(said);
  });

  test("a new browser build is all a check says, since counts measured on another build compare with nothing", () => {
    expect(only(results().checked, "a new browser").said).not.toContain("«load» mutationRecords");
  });

  test("a count above its ceiling names the test, the phase, the count, the ceiling and the measure", () => {
    const ceiling = ceilingOf(heldIn(fileOf("ratchet first"), "rose", "load", "mutationRecords"));
    const { said } = only(results().checked, "rose");
    expect(said).toContain("«rose»");
    expect(said).toContain(`«load» mutationRecords: measured ${ceiling + 2}, ceiling ${ceiling}`);
    expect(said).toContain(
      `{ "ceiling": ${ceiling + 2}, "was": ${ceiling}, "reason": "<why the page does more>" }`,
    );
  });
});

describe("the command", () => {
  const before = (title: string): ConfigObject => record(fileOf("ratchet edited")[title]);
  const after = (title: string): ConfigObject => record(fileOf("ratchet lowered")[title]);
  const lowest = (title: string): number =>
    countOf(phaseOf(results().lowered, title, "load"), "mutationRecords");

  test("writes a test it has no ceilings for", () => {
    expect(only(results().lowered, "not in the file").ok).toBe(true);
    expect(record(phasesIn(fileOf("ratchet lowered"), "not in the file"))["load"]).toEqual(
      phaseOf(results().lowered, "not in the file", "load"),
    );
  });

  test("never raises a ceiling the page rose above, and fails", () => {
    expect(only(results().lowered, "rose").ok).toBe(false);
    expect(after("rose")).toEqual(before("rose"));
  });

  test.each([["dropped"], ["raised above what the page does"]])(
    "lowers %s to what the page does, as a plain number",
    (title) => {
      expect(only(results().lowered, title).ok).toBe(true);
      expect(heldIn(fileOf("ratchet lowered"), title, "load", "mutationRecords")).toBe(
        lowest(title),
      );
    },
  );

  test("keeps a raised ceiling the page meets, with its reason, and seals it", () => {
    expect(only(results().lowered, "raised with a reason").ok).toBe(true);
    expect(after("raised with a reason")["phases"]).toEqual(
      before("raised with a reason")["phases"],
    );
    expect(after("raised with a reason")["seal"]).not.toBe(before("raised with a reason")["seal"]);
  });

  test("refuses a kept raise raised again in place", () => {
    const { ok, said } = only(results().rechecked, "raised with a reason");
    expect(ok).toBe(false);
    expect(said).toContain("were edited by hand");
  });

  test("leaves a test skipped after a phase as it was, and reports it skipped", () => {
    expect(only(results().lowered, "skipped after a phase").status).toBe("skipped");
    expect(only(results().checked, "skipped after a phase").status).toBe("skipped");
    expect(after("skipped after a phase")).toEqual(before("skipped after a phase"));
  });

  test("reads and writes an entry and phases named after what every object has", () => {
    expect(only(results().lowered, "valueOf").ok).toBe(true);
    expect(Object.keys(phasesIn(fileOf("ratchet lowered"), "valueOf"))).toEqual([
      "constructor",
      "__proto__",
    ]);
  });

  test("refuses to run in CI", () => {
    expect(results().inCi).toContain("COUNT_BUDGET=write");
    expect(results().inCi).toContain("CI");
  });

  test.each([
    ["raised by hand"],
    ["raised with no reason"],
    ["raised by hand, then the page drops"],
  ])("refuses %s and leaves it", (title) => {
    expect(only(results().lowered, title).ok).toBe(false);
    expect(after(title)).toEqual(before(title));
  });

  test("records the browser it ran on, and drops what the test no longer measures", () => {
    const now = fileOf("ratchet lowered");
    expect(record(now["a new browser"])["browser"]).toBe(
      record(fileOf("ratchet first")["unchanged"])["browser"],
    );
    expect(Object.keys(phasesIn(now, "a phase dropped"))).toEqual(["load"]);
    expect(Object.keys(phasesIn(now, "a phase added"))).toEqual(["load", "again"]);
    expect(record(phasesIn(now, "a page that stopped being React")["load"])).not.toHaveProperty(
      "reactCommits",
    );
  });

  test("moves no ceiling it held up", () => {
    const now = fileOf("ratchet lowered");
    for (const [title, entry] of Object.entries(fileOf("ratchet edited"))) {
      for (const [phase, counts] of Object.entries(record(record(entry)["phases"]))) {
        for (const count of Object.keys(record(counts))) {
          const kept = heldIn(now, title, phase, count);
          if (kept === undefined) continue;
          expect(ceilingOf(kept), `${title} ${phase} ${count}`).toBeLessThanOrEqual(
            ceilingOf(heldIn(fileOf("ratchet edited"), title, phase, count)),
          );
        }
      }
    }
  });

  test("an unknown mode refuses the run", () => {
    expect(results().wrongMode).toContain(
      'COUNT_BUDGET is "yes", and the one value it takes is "write"',
    );
  });

  test("runs from the package as a consumer installs it", () => {
    expect(only(results().consumer, "a consumer's spec runs")).toMatchObject({
      ok: true,
      said: "",
    });
    expect(record(phasesIn(fileOf("consumer"), "a consumer's spec runs")["add"])).toEqual({
      mutationRecords: 1,
      requests: 0,
      bodyBytes: 0,
      scriptBytes: 0,
    });
  });
});

describe("a precondition that does not hold refuses the test and records nothing", () => {
  test.each([
    ["an unstubbed origin", "the page reached an origin the test neither serves nor stubs"],
    ["an aborted origin", "ended before any answer reached the page:\n  http"],
    ["an aborted origin", "(net::ERR_FAILED)"],
    ["motion that ignores reduced motion", "the page did not go still in 100 idle rounds"],
    ["a request that never finishes", "Still in flight: GET "],
    ["a phase name used twice", "already marked a phase named «load»"],
    ["no phase marked", "marked no phase"],
    ["a retried test", "on retry 1"],
    ["an unstubbed WebSocket", "(WebSocket)"],
    ["a service worker that reaches out", "/data"],
    ["a page that turns React's hook off", "turned React's DevTools hook off"],
    ["a page that overwrites React's hook", "React's DevTools hook"],
    ["a service worker's fetch that outlives the load", "/slow"],
    ["a stub the page gave up on", "before any answer reached the page"],
    ["a phase whose failure the test caught", "«boom» did not finish"],
    ["a refusal the test caught", "«load» did not finish"],
  ])("%s", (title, said) => {
    const outcome = only(results().first, title);
    expect(outcome.ok).toBe(false);
    expect(outcome.said).toContain(said);
    expect(fileOf("refusals first")).not.toHaveProperty([title]);
  });

  test.each([
    ["a stubbed origin"],
    ["an origin the test serves"],
    ["motion that honours reduced motion"],
    ["a blob the page made itself"],
    ["a stubbed WebSocket"],
    ["a click that sends a beacon as it leaves"],
    ["frames the page did not start with"],
    ["an origin the test serves, written as a URL"],
    ["phases named after what every object has"],
    ["toString"],
  ])("%s is counted", (title) => {
    expect(only(results().first, title)).toMatchObject({ ok: true, said: "" });
    expect(fileOf("refusals first")).toHaveProperty([title]);
  });

  test("the refused origin is named", () => {
    expect(only(results().first, "an unstubbed origin").said).toMatch(
      /http:\/\/127\.0\.0\.1:\d+\/data/,
    );
  });

  test("a page that never goes still says what kept moving", () => {
    expect(only(results().first, "motion that ignores reduced motion").said).toContain(
      "mutationRecords",
    );
  });
});

describe("a test that does not pass records nothing", () => {
  test("a test skipped at run time is skipped, not failed", () => {
    expect(only(results().first, "a test skipped after a phase").status).toBe("skipped");
    expect(fileOf("refusals first")).not.toHaveProperty(["a test skipped after a phase"]);
  });

  test("phases named after what every object has are written under their own names", () => {
    expect(
      Object.keys(phasesIn(fileOf("refusals first"), "phases named after what every object has")),
    ).toEqual(["constructor", "__proto__", "toString"]);
  });
});

describe("the ceilings file", () => {
  test("lists its tests in code-point order, whatever the writer's locale", () => {
    const keys = Object.keys(fileOf("refusals first"));
    expect(keys).toEqual(keys.toSorted());
    expect(keys.indexOf("zeal")).toBeLessThan(keys.indexOf("ärlig"));
  });

  test("takes sixteen writers in four parallel workers without losing one", () => {
    expect([...results().parallel.values()].flat().every((run) => run.ok)).toBe(true);
    expect(Object.keys(fileOf("parallel"))).toHaveLength(16);
  });

  test("takes over a lock a dead worker left, and clears the files dead workers left beside it", () => {
    expect(results().leftBeside).toEqual(["parallel.spec.counts.json"]);
  });
});
