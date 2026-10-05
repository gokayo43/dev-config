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
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { type ConfigObject, record } from "../.github/actions/_lib/gate.ts";
import {
  type Counts,
  fixture,
  type Outcome,
  playwright,
  ROWS,
  serving,
  SOURCE,
} from "./count-budget-fixture.ts";

const WRITE = { COUNT_BUDGET: "write" };

/** How many runs of one page item 5 of the brief grades as identical, quiet and loaded. */
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
    after: [["load", "mutations=3&requests=2"]],
  },
  "a page that stopped being React": {
    before: [["load", "app"]],
    after: [["load", "mutations=3&requests=2"]],
  },
  "not in the file": { after: [["load", "mutations=3&requests=2"]] },
} satisfies Record<string, { before?: [string, string][]; after: [string, string][] }>;

const RATCHET = `import { test } from ${SOURCE};

const stages = ${JSON.stringify(STAGES)};
const stage = process.env.STAGE;

for (const [title, phases] of Object.entries(stages)) {
  test(title, async ({ page, budget }) => {
    test.skip(phases[stage] === undefined, "not marked at this stage");
    for (const [phase, asked] of phases[stage]) {
      await budget.phase(phase, () => page.goto(asked === "app" ? "/app" : "/counted?" + asked));
    }
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

let first: Runs = new Map();
let checked: Runs = new Map();
let lowered: Runs = new Map();
let quiet: Runs = new Map();
let loaded: Runs = new Map();
let consumer: Runs = new Map();
let wrongMode = "";
/** How many cores' worth of CPU the spinning processes took while the loaded runs ran. */
let cores = 0;
/** The ceilings files, by spec and by the moment they were read. */
const files = new Map<string, ConfigObject>();
let stop = async (): Promise<void> => {};

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
    2,
  );
  const at = (name: string): string => join(root, `${name}.spec.counts.json`);
  // The planted lists are left out: the unplanted one writes the ceilings
  // every one of them is checked against.
  first = await playwright(root, { ...WRITE, ...env, STAGE: "before" }, [
    "--grep-invert",
    "planted (rerender|request|heavy)",
  ]);
  for (const name of ["planted", "phases", "refusals", "ratchet"]) {
    files.set(`${name} first`, await json(at(name)));
  }

  const planted = await json(at("planted"));
  const none = record(planted["the list, planted none"]);
  for (const plant of PLANTS) planted[`the list, planted ${plant}`] = none;
  await Bun.write(at("planted"), JSON.stringify(planted, null, 2));

  const ratchet = await json(at("ratchet"));
  edited(ratchet, String(none["browser"]));
  await Bun.write(at("ratchet"), JSON.stringify(ratchet, null, 2));
  files.set("ratchet edited", await json(at("ratchet")));

  checked = await playwright(root, { ...env, STAGE: "after" }, [
    "planted.spec.ts",
    "ratchet.spec.ts",
  ]);
  lowered = await playwright(root, { ...WRITE, ...env, STAGE: "after" }, ["ratchet.spec.ts"]);
  files.set("ratchet lowered", await json(at("ratchet")));

  wrongMode = await playwright(root, { COUNT_BUDGET: "yes", ...env, STAGE: "after" }, [
    "phases.spec.ts",
  ]).then(
    () => "",
    (error: Error) => error.message,
  );

  const installed = await fixture(server.origin, { "consumer.spec.ts": INSTALLED }, 1);
  consumer = await playwright(installed, WRITE);
  files.set("consumer", await json(join(installed, "consumer.spec.counts.json")));

  const steady = await fixture(server.origin, { "steady.spec.ts": STEADY }, 1);
  const repeated = ["--repeat-each", String(RUNS)];
  quiet = await playwright(steady, WRITE, repeated);
  const underCores = await underLoad(async () => await playwright(steady, WRITE, repeated));
  loaded = underCores.answer;
  cores = underCores.cores;
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

function countOf(counts: Counts, count: string): number {
  const found = counts[count];
  if (found === undefined) throw new Error(`no ${count} in ${JSON.stringify(counts)}`);
  return found;
}

function fileOf(name: string): ConfigObject {
  const found = files.get(name);
  if (found === undefined) throw new Error(`no ceilings file was read as ${name}`);
  return found;
}

describe("the counts a phase reports", () => {
  // The tail lands after `load` and after Playwright's network idle, in tasks
  // that never leave the page idle; a phase that ended at either misses it.
  test("a phase is charged with the work that finished after its action returned", () => {
    const tail = phaseOf(first, "work that runs on past load", "load");
    const none = phaseOf(first, "no work past load", "load");
    expect(countOf(tail, "mutationRecords") - countOf(none, "mutationRecords")).toBe(5);
  });

  // The click waits for the tail's button, so a boundary that did not wait for
  // the tail charges its five elements here.
  test("a phase is charged with nothing the phase before it did", () => {
    expect(phaseOf(first, "work that runs on past load", "add")).toEqual({
      mutationRecords: 1,
      requests: 0,
      bodyBytes: 0,
      scriptBytes: 0,
    });
  });

  test("a phase that leaves the page is charged with what the page it left did", () => {
    const go = phaseOf(first, "a click that leaves the page", "go");
    const landing = phaseOf(first, "the page it lands on", "load");
    expect(go).toEqual({ ...landing, mutationRecords: countOf(landing, "mutationRecords") + 1 });
  });

  test("a page with no React renderer reports no commit count", () => {
    for (const title of [
      "work that runs on past load",
      "no work past load",
      "the page it lands on",
    ]) {
      for (const counts of Object.values(only(first, title).counts ?? {})) {
        expect(counts).not.toHaveProperty("reactCommits");
      }
    }
  });

  test("a React phase in which nothing committed reports zero commits", () => {
    expect(phaseOf(first, "the list, planted none", "hover")).toHaveProperty("reactCommits", 0);
  });

  test("every count of the list's load and of its interaction is above zero", () => {
    for (const phase of ["load", "more"]) {
      const counts = phaseOf(first, "the list, planted none", phase);
      for (const count of [
        "reactCommits",
        "mutationRecords",
        "requests",
        "bodyBytes",
        "scriptBytes",
      ]) {
        expect(countOf(counts, count), `${phase} ${count}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("one page, the same counts on every run", () => {
  test.each([
    ["quiet", (): Runs => quiet],
    ["with every core loaded", (): Runs => loaded],
  ])("%s", (_, runs) => {
    const all = runsOf(runs(), "the list");
    const measured = only(runs(), "the list");
    expect(all).toHaveLength(RUNS);
    expect(measured).toMatchObject({ ok: true, said: "" });
    for (const run of all) expect(run).toEqual(measured);
  });

  test("the loaded runs ran under load", () => {
    expect(cores).toBeGreaterThan(0.5);
  });

  test("quiet and loaded runs agree", () => {
    expect(only(loaded, "the list").counts).toEqual(only(quiet, "the list").counts);
  });
});

describe("a planted regression fails the ceiling the unplanted list wrote", () => {
  const none = (phase: string, count: string): number =>
    countOf(phaseOf(checked, "the list, planted none", phase), count);

  test("the unplanted list passes its own ceilings", () => {
    expect(only(checked, "the list, planted none")).toMatchObject({ ok: true, said: "" });
  });

  test("a hover that re-renders every row raises commits and mutation records", () => {
    const { ok, said } = only(checked, "the list, planted rerender");
    const hover = phaseOf(checked, "the list, planted rerender", "hover");
    expect(ok).toBe(false);
    expect(countOf(hover, "reactCommits")).toBeGreaterThan(none("hover", "reactCommits"));
    expect(said).toContain("«the list, planted rerender»");
    for (const count of ["reactCommits", "mutationRecords"]) {
      expect(said).toContain(
        `«hover» ${count}: measured ${countOf(hover, count)}, ceiling ${none("hover", count)}`,
      );
    }
  });

  test("a request per row raises the request count", () => {
    const { ok, said } = only(checked, "the list, planted request");
    expect(ok).toBe(false);
    for (const phase of ["load", "more"]) {
      const ceiling = none(phase, "requests");
      expect(said).toContain(`«${phase}» requests: measured ${ceiling + ROWS}, ceiling ${ceiling}`);
    }
  });

  test("a heavier payload raises body bytes", () => {
    const { ok, said } = only(checked, "the list, planted heavy");
    const heavy = countOf(phaseOf(checked, "the list, planted heavy", "load"), "bodyBytes");
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
    ["raised with a reason", true, ""],
    ["raised by hand", false, "were edited by hand"],
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
    const outcome = only(checked, title);
    expect(outcome.ok).toBe(ok);
    expect(outcome.said).toContain(said);
  });

  test("a count above its ceiling names the test, the phase, the count, the ceiling and the measure", () => {
    const ceiling = ceilingOf(heldIn(fileOf("ratchet first"), "rose", "load", "mutationRecords"));
    const { said } = only(checked, "rose");
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
    countOf(phaseOf(lowered, title, "load"), "mutationRecords");

  test("writes a test it has no ceilings for", () => {
    expect(only(lowered, "not in the file").ok).toBe(true);
    expect(record(phasesIn(fileOf("ratchet lowered"), "not in the file"))["load"]).toEqual(
      phaseOf(lowered, "not in the file", "load"),
    );
  });

  test("never raises a ceiling the page rose above, and fails", () => {
    expect(only(lowered, "rose").ok).toBe(false);
    expect(after("rose")).toEqual(before("rose"));
  });

  test.each([["dropped"], ["raised above what the page does"]])(
    "lowers %s to what the page does, as a plain number",
    (title) => {
      expect(only(lowered, title).ok).toBe(true);
      expect(heldIn(fileOf("ratchet lowered"), title, "load", "mutationRecords")).toBe(
        lowest(title),
      );
    },
  );

  test("keeps a raised ceiling the page meets, with its reason", () => {
    expect(only(lowered, "raised with a reason").ok).toBe(true);
    expect(after("raised with a reason")).toEqual(before("raised with a reason"));
  });

  test.each([["raised by hand"], ["raised with no reason"]])(
    "refuses %s and leaves it",
    (title) => {
      expect(only(lowered, title).ok).toBe(false);
      expect(after(title)).toEqual(before(title));
    },
  );

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
    expect(wrongMode).toContain('COUNT_BUDGET is "yes", and the one value it takes is "write"');
  });

  test("runs from the package as a consumer installs it", () => {
    expect(only(consumer, "a consumer's spec runs")).toMatchObject({ ok: true, said: "" });
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
    ["an aborted origin", "(failed: net::ERR_FAILED)"],
    ["motion that ignores reduced motion", "the page did not go still in 100 idle rounds"],
    ["a request that never finishes", "Still in flight: GET "],
    ["a phase name used twice", "already marked a phase named «load»"],
    ["no phase marked", "marked no phase"],
    ["a retried test", "on retry 1"],
  ])("%s", (title, said) => {
    const outcome = only(first, title);
    expect(outcome.ok).toBe(false);
    expect(outcome.said).toContain(said);
    expect(fileOf("refusals first")).not.toHaveProperty([title]);
  });

  test.each([
    ["a stubbed origin"],
    ["an origin the test serves"],
    ["motion that honours reduced motion"],
    ["a blob the page made itself"],
  ])("%s is counted", (title) => {
    expect(only(first, title)).toMatchObject({ ok: true, said: "" });
    expect(fileOf("refusals first")).toHaveProperty([title]);
  });

  test("the refused origin is named", () => {
    expect(only(first, "an unstubbed origin").said).toMatch(/http:\/\/127\.0\.0\.1:\d+\/data/);
  });

  test("a page that never goes still says what kept moving", () => {
    expect(only(first, "motion that ignores reduced motion").said).toContain("mutationRecords");
  });
});
