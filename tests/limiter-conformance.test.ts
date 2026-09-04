/**
 * The conformance suite, driven against a correct limiter and against every
 * named way of building a wrong one.
 *
 * A conformance suite is the one kind of export whose own suite cannot just
 * call it: it registers `describe` blocks, so what it does is decide the exit
 * status of a `bun test` run. Grading it therefore means being one — each case
 * writes a test file that hands `conformsAsLimiter` a subject, runs `bun test`
 * over it in a directory of its own, and reads the status and the failures.
 * `mutation-lane.test.ts` and `test-suite.test.ts` are the same argument for
 * their gates: a stubbed run would prove nothing about the tool the export is.
 *
 * The pairing below is the point. Every flaw names the case that has to catch
 * it, so "this test kills this wrong implementation" is machine-checked rather
 * than asserted in a report — and a case that stops catching its flaw fails
 * here rather than going quiet in a consuming repo.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { plainly, required } from "../.github/actions/_lib/gate.ts";
import { containing } from "./matchers.ts";
import { type Flaw, FLAWS } from "./house-limiter.ts";
import { materialise } from "./tree.ts";

/**
 * A throwaway Redis, refused rather than defaulted, for the reason
 * `tests/postgres.ts` now refuses a server too: `localhost` on the box these
 * suites run on is a host address some stack may be publishing, and what this
 * suite does to whatever answers is **flush** it. The two refusals differ only
 * in how loud the damage is — this one wipes a live keyspace, that one drops
 * databases — so neither guesses.
 */
const REDIS_URL = required(
  "TEST_REDIS_URL",
  'the limiter conformance suite flushes the Redis it is given, so it will not guess at one — point it at a throwaway (README\'s "Gating this repo" has the one-liner)',
);

/**
 * Two paths the fixture limiter meters, which is every path it is given. Two,
 * because one caller's budget must not be one budget per URL.
 */
const METERED = ["/api/summoner/anyone", "/api/summoner/someone-else"] as const;

const HERE = import.meta.dir;

/**
 * The fixture's own test file. Absolute imports because it runs from a
 * directory outside this repo, and there is nothing to install: everything it
 * reaches for is either this tree or a Bun built-in.
 */
function fixture(flaw: Flaw | undefined): string {
  const built =
    flaw === undefined ? "houseLimiter(url)" : `houseLimiter(url, ${JSON.stringify(flaw)})`;
  return [
    `import { conformsAsLimiter } from ${JSON.stringify(join(HERE, "..", "limiter-conformance.ts"))};`,
    `import { houseLimiter } from ${JSON.stringify(join(HERE, "house-limiter.ts"))};`,
    "",
    "conformsAsLimiter({",
    `  make: (url) => ${built},`,
    `  redisUrl: ${JSON.stringify(REDIS_URL)},`,
    `  metered: ${JSON.stringify(METERED)},`,
    "});",
    "",
  ].join("\n");
}

interface Run {
  readonly passed: boolean;
  /** The names of the cases that failed, as the runner reported them. */
  readonly failed: string[];
}

/**
 * One `bun test` over one fixture, run by the same binary running this — a
 * `bun` off the child's PATH could be a different install from the one whose
 * behaviour is being graded. The fixture directory carries no bunfig, so the
 * child inherits none of this repo's coverage floor, which is about this repo's
 * code and would fail a fixture run for a reason unrelated to what it grades.
 */
async function conformance(flaw?: Flaw): Promise<Run> {
  const root = await materialise({ "limiter.test.ts": fixture(flaw) });
  const proc = Bun.spawn([process.execPath, "test", "limiter.test.ts"], {
    cwd: root,
    env: plainly(Bun.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const failed = [...`${out}\n${err}`.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(
    ([, name]) => name ?? "",
  );
  return { passed: status === 0, failed };
}

/**
 * Every flaw, and the case that has to be the one to catch it. `Record<Flaw,
 * …>` rather than a list of pairs, so the compiler is what says a flaw has a
 * case: a wrong implementation nobody paired is one nothing here catches.
 *
 * A flaw usually trips more than one case — an in-process bucket is also a
 * bucket a dead Redis cannot empty — so the assertion is that the named case is
 * among the failures, not that it is alone.
 */
const CAUGHT_BY = {
  "admits-everything": "a caller has a budget, and it runs out",
  "refuses-everything": "a second caller has a budget of its own",
  "keeps-the-bucket-in-the-process": "a second instance against the same Redis shares the budget",
  "exempts-an-unkeyed-caller":
    "a caller sending no headers, from a socket nobody named, is metered",
  "exempts-an-empty-header": "an empty cf header is a value, not an exemption",
  "keys-on-every-hop": "junk beyond the first hop of x-forwarded-for buys nothing",
  "trusts-the-forwarded-header-first":
    "a header the caller controls cannot override the one the edge stamps",
  "fails-open": "a limiter whose Redis is gone refuses",
  "reads-then-writes": "attempts racing on one key never over-admit",
  "keys-on-the-path": "one caller's budget is not one per URL",
} satisfies Readonly<Record<Flaw, string>>;

describe("the limiter conformance suite", () => {
  test("passes the house limiter — a Redis token bucket, keyed through the chain, failing closed", async () => {
    const { passed, failed } = await conformance();
    expect(failed).toEqual([]);
    expect(passed).toBe(true);
  }, 30_000);

  test.each([...FLAWS])(
    "refuses a limiter that %s",
    async (flaw) => {
      const { passed, failed } = await conformance(flaw);
      expect(failed).toContainEqual(containing(CAUGHT_BY[flaw]));
      expect(passed).toBe(false);
    },
    30_000,
  );
});
