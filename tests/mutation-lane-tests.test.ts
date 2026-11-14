import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { containing } from "./matchers.ts";
import {
  BEFORE,
  BROWSER_SPEC,
  FEE_TEST,
  lane,
  messages,
  PRICING,
  repo,
  TOTAL_TEST,
  WITH_FEE,
} from "./mutation-lane-fixture.ts";

// Real Stryker runs, timed out as the lane's other suite times them, and for
// the reason given there.
setDefaultTimeout(30_000);

describe("the tests a repo names in mutation-tests", () => {
  // A failing file whose path contains the named file's path: `bun test`
  // reads a bare relative path as a substring filter, so naming
  // `tests/pricing.test.ts` that way also runs this one. It throws on load,
  // which the runner reports as a baseline nothing can be read off.
  const TRAP = { "other/tests/pricing.test.ts": BROWSER_SPEC };

  test("the run takes exactly the named file, not the neighbour its path is a substring of", async () => {
    const trees = [
      repo({ ...TRAP, "src/domain/pricing.ts": PRICING, "tests/pricing.test.ts": TOTAL_TEST }),
      repo({
        ...TRAP,
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ];

    // The newline a YAML block scalar ends with is the scalar's, not a blank
    // line of the repo's.
    const named = await lane(trees, { tests: "tests/pricing.test.ts\n" });
    expect(messages(named)).toEqual([]);
    expect(named.note).toBe(
      "mutation score 100.0% over 1 changed domain file; mutation-tests names 1 test file",
    );

    // The same repo walked: the neighbour runs, and the baseline is refused.
    const walked = await lane(trees);
    expect(messages(walked)).toEqual([containing("other/tests/pricing.test.ts")]);
    expect(walked.note).toBe("the suite this run mutated does not pass unmutated");
  });

  test("a dirty baseline among the named files says the named files are what ran", async () => {
    const verdict = await lane(
      [
        repo({ "src/domain/pricing.ts": PRICING, "tests/pricing.test.ts": TOTAL_TEST }),
        repo({
          "src/domain/pricing.ts": PRICING + WITH_FEE,
          "tests/pricing.test.ts": FEE_TEST,
          "tests/browser.test.ts": BROWSER_SPEC,
        }),
      ],
      { tests: "tests/*.test.ts" },
    );

    expect(messages(verdict)).toEqual([
      containing("The run loads exactly the 2 test files `mutation-tests` names"),
    ]);
  });

  // Narrowing the tests never turns "no test noticed" into a pass. The only
  // test that pins `withFee` sits outside the pattern, so under the pattern
  // its lines are lines nothing runs.
  test("a mutant only an unnamed test kills still fails the branch", async () => {
    const trees = [
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": TOTAL_TEST,
        "tests/fee.test.ts": FEE_TEST,
      }),
    ];

    expect(messages(await lane(trees, { tests: "tests/pricing.test.ts" }))).toEqual([
      "src/domain/pricing.ts: write the test that reaches line 5: this branch wrote it and nothing runs it, so `{}` (BlockStatement) in its place goes unnoticed",
      "src/domain/pricing.ts: write the test that reaches line 6: this branch wrote it and nothing runs it, so `cents - 50` (ArithmeticOperator) in its place goes unnoticed",
    ]);
    // And walked, the test outside the pattern is the one that catches them.
    expect(messages(await lane(trees))).toEqual([]);
  });

  // A pattern written from `./` scans to paths that keep the prefix, so a
  // file named both ways would be counted, and handed to bun, twice.
  test("one file named in two spellings is one named file", async () => {
    const verdict = await lane(
      [
        BEFORE,
        repo({ "src/domain/pricing.ts": PRICING + WITH_FEE, "tests/pricing.test.ts": FEE_TEST }),
      ],
      { tests: "tests/pricing.test.ts\n./tests/pricing.test.ts" },
    );

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe(
      "mutation score 100.0% over 1 changed domain file; mutation-tests names 1 test file",
    );
  });

  test("a branch that changes no domain file still says how many tests are named", async () => {
    const verdict = await lane([BEFORE, { ...BEFORE, "README.md": "# a repo\n" }], {
      tests: "tests/pricing.test.ts",
      installed: false,
    });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("nothing to mutate; mutation-tests names 1 test file"));
  });

  // Each of these would leave a test the repo meant to run out of the run,
  // with a score published over the rest. Refused before Stryker starts,
  // which is why none of these runs needs the runner installed.
  test.each([
    [
      "a pattern that matches no file",
      "tests/pricing.test.ts\ntests/nowhere/*.test.ts",
      {},
      "fix mutation-tests's `tests/nowhere/*.test.ts` so it names a test file",
    ],
    [
      "a pattern that climbs out of the working directory",
      "../tests/pricing.test.ts",
      {},
      "write mutation-tests's `../tests/pricing.test.ts` relative to the working directory and inside it",
    ],
    [
      "an absolute pattern",
      "/tests/pricing.test.ts",
      {},
      "write mutation-tests's `/tests/pricing.test.ts` relative to the working directory and inside it",
    ],
    [
      "a blank line between patterns",
      "tests/pricing.test.ts\n  \ntests/*.test.ts",
      {},
      "delete the blank line 2 of mutation-tests",
    ],
    [
      "a named file bunfig.toml keeps bun from running",
      "tests/*.test.ts",
      {
        "bunfig.toml": '[test]\npathIgnorePatterns = ["tests/slow.*"]\n',
        "tests/slow.test.ts": TOTAL_TEST,
      },
      "bunfig.toml: take tests/slow.test.ts out of mutation-tests, or `tests/slow.*` out of [test] pathIgnorePatterns",
    ],
    [
      "a pattern written from ./ that names a file bunfig.toml keeps bun from running",
      "./tests/*.test.ts",
      {
        "bunfig.toml": '[test]\npathIgnorePatterns = ["tests/slow.*"]\n',
        "tests/slow.test.ts": TOTAL_TEST,
      },
      "bunfig.toml: take tests/slow.test.ts out of mutation-tests, or `tests/slow.*` out of [test] pathIgnorePatterns",
    ],
  ] as const)("%s is refused by name", async (_, tests, extra, said) => {
    const verdict = await lane(
      [
        BEFORE,
        repo({
          "src/domain/pricing.ts": PRICING + WITH_FEE,
          "tests/pricing.test.ts": FEE_TEST,
          ...extra,
        }),
      ],
      { tests, installed: false },
    );

    expect(messages(verdict)).toEqual([containing(said)]);
    expect(verdict.note).toBe("mutation-tests does not name the tests it was meant to");
  });
});
