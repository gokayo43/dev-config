import { afterEach, describe, expect, test } from "bun:test";

import { passed, refused, reportVerdict } from "../.github/actions/db-gate/verdict.ts";

/**
 * The entry points hand a verdict straight to `reportVerdict` and do nothing
 * else, so what a run's log holds is decided entirely here. Captured off
 * `console.log` because that is the protocol: GitHub reads `::error` and
 * `::notice` off stdout, and the order they arrive in is what a reader scrolls
 * through.
 */
function logged(run: () => void): string[] {
  const lines: string[] = [];
  const wrote = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    run();
  } finally {
    console.log = wrote;
  }
  return lines;
}

// A refusal sets the exit code, which is the process the suite is running in.
// Reset rather than saved and restored around each case: restoring what was
// captured writes `undefined` back, which Bun reads as no change at all, so the
// file leaves a failing exit code behind and the run is only green while some
// later file happens to clear it.
afterEach(() => {
  process.exitCode = 0;
});

describe("what a verdict puts in the log", () => {
  test("a verdict that held is one notice and no failure", () => {
    const lines = logged(() => {
      reportVerdict(passed("replay: the migrations rebuild the schema from empty"));
    });

    expect(lines).toEqual(["::notice::replay: the migrations rebuild the schema from empty"]);
    expect(process.exitCode).not.toBe(1);
  });

  // The order is the claim the docstring makes: the evidence is above the
  // annotation that summarises it, so a reader who scrolls to the error finds
  // what it was about without scrolling further.
  test("the divergence is in the log before the annotation about it", () => {
    const lines = logged(() => {
      reportVerdict(
        refused(
          [{ message: "the two do not agree" }],
          ["only in the left: a", "only in the right: b"],
        ),
      );
    });

    expect(lines).toEqual([
      "only in the left: a",
      "only in the right: b",
      "::error::the two do not agree",
    ]);
  });

  // A refusal has no summary by construction, so nothing here can paraphrase
  // the error back at the reader as a notice beside it.
  test("a refusal carries no notice", () => {
    const lines = logged(() => {
      reportVerdict(refused([{ message: "no" }]));
    });

    expect(lines.filter((line) => line.startsWith("::notice"))).toEqual([]);
  });
});
