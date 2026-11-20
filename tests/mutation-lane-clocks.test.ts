import { describe, expect, test } from "bun:test";

import { GRACE_MS } from "../.github/actions/mutation-lane/child.ts";
import {
  endedProblem,
  LONGEST_CASE_LIMIT_MS,
} from "../.github/actions/mutation-lane/mutation-lane.ts";
import { procStat } from "../file-lock.ts";
import { containing } from "./matchers.ts";
import {
  BEFORE,
  FEE_TEST,
  lane,
  laneIn,
  messages,
  PRICING,
  repo,
  TOTAL_TEST,
  WITH_FEE,
} from "./mutation-lane-fixture.ts";

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

/**
 * A loop one of whose mutants never ends. Stryker counts how often a mutant
 * runs and ends that one as a timeout at its hit limit, which the runner
 * honours since 1.6.0, before any clock fires.
 */
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
      "src/domain/pause.ts: write the case that fails on `waiting <= 0` (EqualityOperator) at line 2: this branch wrote that line and the suite passes either way",
      "src/domain/pause.ts: write the case that fails on `waiting >= 0` (EqualityOperator) at line 2: this branch wrote that line and the suite passes either way",
    ]);
    expect(verdict.table).toEqual(containing("| Caught by timing out | 0 |"));
  });

  // A mutant that hangs is caught by timing out, which the score counts as
  // caught and the note says it did: a score that rests on timeouts is one a
  // reader can see resting on them. The case limit given is what Stryker's
  // deadline is built from, so a hang its hit limit missed would cost about a
  // second here rather than the default minute.
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
      "tests/slow.test.ts: make tests/slow.test.ts pass as a plain `bun test` of the files `mutation-tests` names, with every case allowed 1000 ms and no `.env` file read, or take it out of the patterns: run unmutated it failed, so no mutant can be graded against it",
    ]);
  });

  // The upper bound is bun's: past it bun refuses the run before it writes a
  // report, and the lane would read that as every named file failing.
  // The cap is the run's deadline: a case allowed longer than the whole run is
  // allowed nothing more, and it keeps Stryker's timers inside Node's.
  test.each([
    "0",
    "-5",
    "1.5",
    "a minute",
    String(LONGEST_CASE_LIMIT_MS + 1),
    "2147483648",
    "0x10",
    "1e3",
    " 60000",
    "60000\n",
  ])("a case limit written as %p is refused rather than guessed at", async (caseTimeout) => {
    await expect(
      lane([BEFORE, repo({ ...BEFORE, "tests/pricing.test.ts": TOTAL_TEST })], {
        caseTimeout,
        installed: false,
      }),
    ).rejects.toThrow("write it as a whole number of milliseconds");
  });

  // Stryker waits on its deadline for a mutant with Node's setTimeout, which
  // fires any delay above 2147483647 ms after 1 ms: at a case limit that large
  // every covered mutant came back caught by timing out, and this branch's
  // survivor passed. At the cap it is graded by its tests.
  test("a run at the longest case limit the lane takes grades a survivor as survived", async () => {
    const WEAK_FEE_TEST = FEE_TEST.replace(
      "expect(withFee(100)).toBe(150);",
      "expect(withFee(100) > 0).toBe(true);",
    );
    const verdict = await lane(
      [
        BEFORE,
        repo({
          "src/domain/pricing.ts": PRICING + WITH_FEE,
          "tests/pricing.test.ts": WEAK_FEE_TEST,
        }),
      ],
      { caseTimeout: String(LONGEST_CASE_LIMIT_MS), floor: "0.9" },
    );

    expect(messages(verdict)).toEqual([
      "src/domain/pricing.ts: write the case that fails on `cents - 50` (ArithmeticOperator) at line 6: this branch wrote that line and the suite passes either way",
      ": kill the mutants listed in the run summary: 75.0% of the mutants in 1 changed domain file were caught, under the 90.0% floor this repo declares",
    ]);
    expect(verdict.table).toEqual(containing("| Caught by timing out | 0 |"));
  });

  // bun's case limit cannot end a case that never yields, so without a clock
  // of the lane's own the step ran until GitHub killed it, with no note.
  test("named tests that never finish unmutated are ended at the run's deadline, and said so", async () => {
    const HANGING_TEST = `import { test } from "bun:test";

test("never yields", () => {
  for (;;) {}
});
`;
    const verdict = await lane([BEFORE, repo({ ...BEFORE, "tests/hangs.test.ts": HANGING_TEST })], {
      tests: "tests/*.test.ts",
      installed: false,
      runDeadline: 3_000,
    });

    expect(messages(verdict)).toEqual([
      containing(
        "make the named tests finish as a plain `bun test` inside the lane's 3000 ms: run unmutated they were still running when the lane ended them",
      ),
    ]);
    expect(verdict.note).toBe("the named tests did not finish unmutated");
  });

  // A slow mutant holds a worker for up to one case limit, so a file of them
  // can outlast the step; the lane ends the run at its own deadline and says
  // what to lower, rather than leaving GitHub to kill the step. The pause's
  // slow branch outlasts this deadline and loops nowhere a hit limit counts.
  test("a mutation run that outlasts the run's deadline is ended and refused, naming the case limit", async () => {
    const verdict = await lane(
      [
        BEFORE,
        repo({
          ...BEFORE,
          "src/domain/pause.ts": PAUSE,
          "tests/pause.test.ts": PAUSE_TEST,
        }),
      ],
      { runDeadline: 8_000 },
    );

    expect(messages(verdict)).toEqual([
      containing("the lane ended the mutation run at its deadline of 8000 ms"),
    ]);
    expect(verdict.note).toBe("the mutation run did not finish before the lane's deadline");
  });

  // A named test's own child that inherits the pipes held the lane until it
  // exited, past the deadline. At the deadline the lane asks the group to
  // stop, which ends `bun test` and the first grandchild; the second ignores
  // the request, and the kill the lane sends the group once `bun test` has
  // exited ends it. `mutation-lane-child.test.ts` drives the kill at the grace.
  test.each([
    ["a grandchild that inherits the pipes", "sleep 60"],
    ["a grandchild that ignores the request to stop", "trap '' TERM; sleep 60"],
  ])("%s has ended when the lane returns, inside the deadline and the grace", async (_, script) => {
    const SPAWNS = `import { test } from "bun:test";

test("waits on a child of its own", async () => {
  const child = Bun.spawn(["sh", "-c", ${JSON.stringify(script)}], { stdout: "inherit", stderr: "inherit" });
  await Bun.write("grandchild.pid", String(child.pid));
  await child.exited;
});
`;
    const runDeadline = 3_000;
    const started = performance.now();
    const { verdict, root } = await laneIn(
      [BEFORE, repo({ ...BEFORE, "tests/spawns.test.ts": SPAWNS })],
      { tests: "tests/*.test.ts", installed: false, runDeadline },
    );
    const took = performance.now() - started;

    expect(verdict.note).toBe("the named tests did not finish unmutated");
    // The deadline counts from the lane's start, so the grace and a second of
    // the lane's own work bound the rest.
    expect(took).toBeLessThan(runDeadline + GRACE_MS + 1_000);
    // Whatever adopted the grandchild reaps it on its own time, so it may still
    // be listed, dead.
    const pid = Number(await Bun.file(`${root}/grandchild.pid`).text());
    expect((await procStat(pid))?.alive === true).toBe(false);
  });

  // What the refusal of a run the deadline ended advises turns on Stryker's own
  // count, in the line its progress reporter writes (`render()` in
  // progress-append-only-reporter.js): mutants that timed out held it; none
  // timed out, it was long.
  test.each([
    [
      "with mutants that timed out",
      "Mutation testing 40% (elapsed: ~8m, remaining: ~12m) 40/100 tested (3 survived, 2 timed out)\n",
      ["lower `mutation-case-timeout`", "`40/100 tested (3 survived, 2 timed out)`"],
    ],
    [
      "with none that timed out",
      "Mutation testing 40% (elapsed: ~8m, remaining: ~12m) 40/100 tested (3 survived, 0 timed out)\n",
      ["change fewer domain files in one branch", "the run was long rather than stuck"],
    ],
    [
      "before any progress line",
      "INFO ProjectReader Found 1 of 4 file(s) to be mutated.\n",
      [
        "whether mutants hung cannot be told",
        "lower `mutation-case-timeout`",
        "change fewer domain files",
      ],
    ],
  ])("a run the deadline ended %s is advised by what Stryker counted", (_, wrote, said) => {
    const { message } = endedProblem(wrote, "9 minutes", 60_000);
    for (const part of said) expect(message).toEqual(containing(part));
    expect(message).not.toEqual(containing("%"));
  });
});
