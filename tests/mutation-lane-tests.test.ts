import { describe, expect, test } from "bun:test";

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

  test("a dirty baseline among the named files is refused by the file that failed", async () => {
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

    expect(messages(verdict)).toEqual([refusedBy("tests/browser.test.ts")]);
    expect(verdict.note).toBe("the named tests do not pass unmutated");
  });

  // A branch that breaks a named test and touches no domain file used to pass,
  // and the next branch to change a domain file met the red baseline with
  // nothing naming the test or the branch that broke it.
  test.each([
    [
      "a named test that fails a case",
      { "tests/pricing.test.ts": TOTAL_TEST.replace("toBe(300)", "toBe(301)") },
      "tests/pricing.test.ts",
    ],
    [
      "a named test that cannot load",
      { "tests/browser.test.ts": BROWSER_SPEC },
      "tests/browser.test.ts",
    ],
    // bun's JUnit report gives each describe a suite of its own under the
    // file's, with the same file and only its own count.
    [
      "a named test whose failing case sits in a describe block before a passing one",
      {
        "tests/pricing.test.ts": `import { describe, expect, test } from "bun:test";
import { total } from "../src/domain/pricing.ts";
describe("first", () => { test("charges for every unit", () => { expect(total(100, 3)).toBe(301); }); });
describe("second", () => { test("charges for one unit", () => { expect(total(100, 1)).toBe(100); }); });
`,
      },
      "tests/pricing.test.ts",
    ],
  ] as const)(
    "%s, on a branch that changed no domain file, is refused by its file",
    async (_, change, file) => {
      const verdict = await lane([BEFORE, { ...BEFORE, ...change }], {
        tests: "tests/*.test.ts",
        installed: false,
      });

      expect(messages(verdict)).toEqual([refusedBy(file)]);
      expect(verdict.note).toBe("the named tests do not pass unmutated");
    },
  );

  // A case that ends the process leaves bun no report, which names no file:
  // the refusal quotes what bun wrote rather than blaming every named file.
  test("a named run that ends before bun writes its report blames no file", async () => {
    const EXITS = `import { test } from "bun:test";

test("ends the process", () => {
  process.exit(1);
});
`;
    const verdict = await lane([BEFORE, { ...BEFORE, "tests/exits.test.ts": EXITS }], {
      tests: "tests/*.test.ts",
      installed: false,
    });

    expect(messages(verdict)).toEqual([
      containing(
        ": make the named tests pass as a plain `bun test` with every case allowed 60000 ms and no `.env` file read: run unmutated it exited 1 without a report naming a file that failed",
      ),
    ]);
    expect(verdict.note).toBe("the named tests do not pass unmutated");
  });

  // A developer's checkout holds a `.env` with real credentials, and bun loads
  // it, and the files beside it, into every test it runs from there.
  test("the named tests' unmutated run reads no .env file of the checkout's", async () => {
    const ENV_TEST = `import { expect, test } from "bun:test";

test("no name a .env file sets is in reach", () => {
  expect(process.env["FROM_ENV"]).toBeUndefined();
  expect(process.env["FROM_ENV_LOCAL"]).toBeUndefined();
  expect(process.env["FROM_ENV_TEST"]).toBeUndefined();
});
`;
    const verdict = await lane(
      [
        BEFORE,
        {
          ...BEFORE,
          ".env": "FROM_ENV=1\n",
          ".env.local": "FROM_ENV_LOCAL=1\n",
          ".env.test": "FROM_ENV_TEST=1\n",
          "tests/env.test.ts": ENV_TEST,
        },
      ],
      { tests: "tests/*.test.ts", installed: false },
    );

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("the named tests pass unmutated"));
  });

  // What the lane's own unmutated run in the checkout cannot see is what
  // differs in Stryker's copy, and the refusal names those differences.
  test("named tests that pass in the checkout and fail in Stryker's copy are refused, naming what differs", async () => {
    const NEEDS_THE_EXAMPLE = `import { expect, test } from "bun:test";
import { total, withFee } from "../src/domain/pricing.ts";

if (!(await Bun.file(".env.example").exists())) throw new Error("the example env file is gone");

test("adds the fee", () => {
  expect(total(100, 3)).toBe(300);
  expect(withFee(100)).toBe(150);
});
`;
    const verdict = await lane(
      [
        repo({
          ".env.example": "NAME=\n",
          "src/domain/pricing.ts": PRICING,
          "tests/pricing.test.ts": NEEDS_THE_EXAMPLE,
        }),
        repo({
          ".env.example": "NAME=\n",
          "src/domain/pricing.ts": PRICING + WITH_FEE,
          "tests/pricing.test.ts": NEEDS_THE_EXAMPLE,
        }),
      ],
      { tests: "tests/*.test.ts" },
    );

    expect(messages(verdict)).toEqual([
      containing(
        "passed when the lane ran them unmutated in the checkout, so what failed is what differs in Stryker's copy: the sandbox holds no `.env*` file",
      ),
    ]);
    expect(verdict.note).toBe("the suite this run mutated does not pass unmutated");
  });

  // bun passes a test on any of its retried attempts, so a mutant would be
  // graded on whichever run passed; bun's --retry=0 does not outrank the
  // bunfig, so the lane refuses it, walked or named.
  test.each(["", "tests/*.test.ts"])(
    "a bunfig that retries failing tests is refused by name (mutation-tests %p)",
    async (tests) => {
      const verdict = await lane(
        [
          BEFORE,
          repo({
            "bunfig.toml": "[test]\nretry = 2\n",
            "src/domain/pricing.ts": PRICING + WITH_FEE,
            "tests/pricing.test.ts": FEE_TEST,
          }),
        ],
        { tests, installed: false },
      );

      expect(messages(verdict)).toEqual([
        "bunfig.toml: take `retry = 2` out of [test] in bunfig.toml, or run the retried suite outside the lane: bun retries a failing test that many times and passes it on any attempt, so a mutant would be graded on whichever run passed, and neither the runner nor bun's --retry=0 switches it off",
      ]);
      expect(verdict.note).toBe("the repo's bunfig retries failing tests");
    },
  );

  // Every rule the lane reads off bunfig.toml waits on reading it, so one that
  // cannot be read is refused as that, before any rule is named.
  test.each(["", "tests/*.test.ts"])(
    "a bunfig that cannot be read is refused as unreadable (mutation-tests %p)",
    async (tests) => {
      const verdict = await lane(
        [
          BEFORE,
          repo({
            "bunfig.toml": "[test\nretry = 2\n",
            "src/domain/pricing.ts": PRICING + WITH_FEE,
            "tests/pricing.test.ts": FEE_TEST,
          }),
        ],
        { tests, installed: false },
      );

      expect(messages(verdict)).toEqual([containing("bunfig.toml")]);
      expect(verdict.note).toBe("bunfig.toml cannot be read");
    },
  );

  test("a named test the branch changed that passes leaves nothing to mutate", async () => {
    const verdict = await lane(
      [
        BEFORE,
        {
          ...BEFORE,
          "tests/pricing.test.ts": TOTAL_TEST.replace("(100, 3)).toBe(300)", "(100, 4)).toBe(400)"),
        },
      ],
      { tests: "tests/*.test.ts", installed: false },
    );

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe(
      "no domain file changed — the named tests pass unmutated, and there is nothing to mutate; mutation-tests names 1 test file",
    );
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

/** The refusal of a named file that fails unmutated, under the default case limit. */
function refusedBy(file: string): string {
  return `${file}: make ${file} pass as a plain \`bun test\` of the files \`mutation-tests\` names, with every case allowed 60000 ms and no \`.env\` file read, or take it out of the patterns: run unmutated it failed, so no mutant can be graded against it`;
}
