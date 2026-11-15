import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { containing } from "./matchers.ts";
import { BEFORE, lane, messages, repo, TOTAL_TEST } from "./mutation-lane-fixture.ts";

// Real Stryker runs, timed out as the lane's other suites time them, and for
// the reason given there.
setDefaultTimeout(30_000);

/**
 * A domain function whose one branch takes eleven seconds to wait out: past
 * bun's five-second case limit, past Stryker's own deadline of five seconds
 * beyond what the unmutated run took, and past the runner's ten-second clock on
 * a `bun test` child. A mutant that takes the slow branch is slow and finishes.
 */
const PAUSE = `export function pause(waiting: number): number {
  return waiting > 0 ? 11_000 : 0;
}
`;

const PAUSE_TEST = `import { expect, test } from "bun:test";
import { pause } from "../src/domain/pause.ts";

test("nobody waiting is a pause over before a minute is", async () => {
  const started = performance.now();
  await Bun.sleep(pause(0));
  expect(performance.now() - started).toBeLessThan(60_000);
});
`;

/** A loop one of whose mutants never ends, and never yields for a clock inside bun to fire. */
const COUNTDOWN = `export function countdown(from: number): number {
  let left = from;
  while (left > 0) left -= 1;
  return left;
}
`;

const COUNTDOWN_TEST = `import { expect, test } from "bun:test";
import { countdown } from "../src/domain/countdown.ts";

test("counts down to nothing", () => {
  expect(countdown(3)).toBe(0);
});
`;

describe("the clocks a mutation run keeps", () => {
  // Each of the three clocks, left at its default, ends the slow mutant's run
  // before the test does: bun's fails the case, which reads as a kill, and the
  // other two report a timeout, which counts as caught. Either way a survivor on
  // the branch's own line passed. Under the lane's clocks it finishes, and is
  // what it is.
  test("a mutant that is slow and finishes is graded by its tests, not by a clock", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        ...BEFORE,
        "src/domain/pause.ts": PAUSE,
        "tests/pause.test.ts": PAUSE_TEST,
      }),
    ]);

    // Three of the four take the slow branch, and the fourth is the fast one
    // nothing pins either.
    expect(messages(verdict)).toEqual([
      "src/domain/pause.ts: write the case that fails on `false` (ConditionalExpression) at line 2: this branch wrote that line and the suite passes either way",
      "src/domain/pause.ts: write the case that fails on `true` (ConditionalExpression) at line 2: this branch wrote that line and the suite passes either way",
      "src/domain/pause.ts: write the case that fails on `waiting >= 0` (EqualityOperator) at line 2: this branch wrote that line and the suite passes either way",
      "src/domain/pause.ts: write the case that fails on `waiting <= 0` (EqualityOperator) at line 2: this branch wrote that line and the suite passes either way",
    ]);
    expect(verdict.table).toEqual(containing("| Caught by timing out | 0 |"));
  }, 90_000);

  // A mutant that hangs is caught by the clock, which the score counts as
  // caught and the note says it did: a score that rests on timeouts is one a
  // reader can see resting on them. The case limit given is what Stryker's
  // deadline is built from, so a hang costs about a second here rather than
  // the default minute.
  test("a mutant that hangs is caught by timing out, and the note says how many were", async () => {
    const verdict = await lane(
      [
        BEFORE,
        repo({
          ...BEFORE,
          "src/domain/countdown.ts": COUNTDOWN,
          "tests/countdown.test.ts": COUNTDOWN_TEST,
        }),
      ],
      { caseTimeout: "1000" },
    );

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe(
      "mutation score 100.0% over 1 changed domain file, 1 of the 5 caught by timing out",
    );
    expect(verdict.table).toEqual(containing("| Caught by timing out | 1 |"));
  });

  test("the case limit reaches every named test the run makes", async () => {
    const SLOW_TEST = `import { expect, test } from "bun:test";
import { total } from "../src/domain/pricing.ts";

test("charges for every unit, slowly", async () => {
  await Bun.sleep(1_500);
  expect(total(100, 3)).toBe(300);
});
`;
    const verdict = await lane([BEFORE, repo({ ...BEFORE, "tests/slow.test.ts": SLOW_TEST })], {
      tests: "tests/*.test.ts",
      caseTimeout: "1000",
      installed: false,
    });

    expect(messages(verdict)).toEqual([
      "tests/slow.test.ts: make tests/slow.test.ts pass as a plain `bun test` of the files `mutation-tests` names, with every case allowed 1000 ms, or take it out of the patterns: run unmutated it failed, so no mutant can be graded against it",
    ]);
  });

  test.each(["0", "-5", "1.5", "a minute"])(
    "a case limit written as %p is refused rather than guessed at",
    async (caseTimeout) => {
      await expect(
        lane([BEFORE, repo({ ...BEFORE, "tests/pricing.test.ts": TOTAL_TEST })], {
          caseTimeout,
          installed: false,
        }),
      ).rejects.toThrow("write it as a whole number of milliseconds");
    },
  );
});
