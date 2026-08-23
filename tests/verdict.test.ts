import { describe, expect, test } from "bun:test";

import { passed, refused } from "../.github/actions/db-gate/verdict.ts";

/**
 * The two gates in db-gate that prove a property build every verdict they
 * report through these, so what those steps can ever say is decided here. What
 * `publish` then does with one is gate.test.ts.
 */
describe("a verdict from a gate that proves a property", () => {
  test("a claim that held is a note and nothing else", () => {
    expect(passed("replay: the migrations rebuild the schema from empty")).toEqual({
      note: "replay: the migrations rebuild the schema from empty",
      table: undefined,
      log: undefined,
      problems: [],
    });
  });

  // A refusal has no note by construction, so nothing built here can paraphrase
  // the error back at the reader as a notice beside it.
  test("a refusal carries no note", () => {
    expect(refused([{ message: "the two do not agree" }])).toEqual({
      note: undefined,
      table: undefined,
      log: undefined,
      problems: [{ message: "the two do not agree" }],
    });
  });

  // Every line two dumps disagree about, as one blob for the log: an annotation
  // is one line rendered on the step, and this runs to hundreds.
  test("the divergence is the log, one line per entry", () => {
    expect(refused([{ message: "no" }], ["only in the left: a", "only in the right: b"]).log).toBe(
      "only in the left: a\nonly in the right: b",
    );
  });

  // A joined empty list is an empty string, which `publish` would echo as a
  // blank line of log standing for evidence nobody has.
  test("no divergence is no log at all", () => {
    expect(refused([{ message: "no" }], []).log).toBeUndefined();
  });
});
