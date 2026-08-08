import { describe, expect, test } from "bun:test";

import {
  beside,
  compare,
  databaseIn,
  scratchDatabase,
} from "../.github/actions/db-gate/database.ts";

describe("a database beside the one the caller declared", () => {
  const declared = "postgres://postgres:hunter2@localhost:5432/app";

  test("the same server, the other database", () => {
    expect(beside(declared, "other")).toBe("postgres://postgres:hunter2@localhost:5432/other");
    expect(databaseIn(beside(declared, "other"))).toBe("other");
  });

  // The whole reason the name is derived: two checkouts under review on one
  // server are two runs of a gate, and a fixed name means each drops the
  // database the other is midway through building.
  test("two checkouts name two databases", () => {
    expect(scratchDatabase("/work/one", "upgrade_path")).not.toBe(
      scratchDatabase("/work/two", "upgrade_path"),
    );
  });

  // And the reason it is derived from the path rather than from a clock: a run
  // killed between the create and the drop leaves a database behind, and the
  // next run of that checkout reclaims it by arriving at the same name.
  test("one checkout names one database, however it was spelled", () => {
    expect(scratchDatabase("/work/one/.", "upgrade_path")).toBe(
      scratchDatabase("/work/one", "upgrade_path"),
    );
  });

  test("two purposes on one checkout are two databases", () => {
    expect(scratchDatabase("/work/one", "upgrade_path")).not.toBe(
      scratchDatabase("/work/one", "backfill"),
    );
    expect(scratchDatabase("/work/one", "backfill")).toStartWith("backfill_");
  });
});

/**
 * The comparison itself, driven where a database cannot put it: pg_dump is
 * deterministic, so two dumps holding the same statements in a different order
 * are not something a fixture repo can produce. What has to hold is that no
 * answer of "these differ" comes with nothing to say about how.
 */
describe("comparing two dumps", () => {
  const left = { of: "the left schema", text: 'CREATE TABLE "a" ();\nCREATE TABLE "b" ();\n' };

  test("identical text is the only way two schemas are equal", () => {
    expect(compare(left, { of: "the right schema", text: left.text })).toBeUndefined();
  });

  test("the same statements arranged differently are not equal, and say so", () => {
    const reordered = {
      of: "the right schema",
      text: 'CREATE TABLE "b" ();\nCREATE TABLE "a" ();\n',
    };
    const difference = compare(left, reordered);

    expect(difference?.headline).toContain("not in which statements they hold");
    expect(difference?.lines).not.toEqual([]);
  });

  // The tally is of statements, so a blank line moves nothing in it. Reporting
  // that as "a different order" was a claim about something never compared.
  test("a blank-line difference is not reported as a different order", () => {
    const spaced = {
      of: "the right schema",
      text: 'CREATE TABLE "a" ();\n\nCREATE TABLE "b" ();\n',
    };
    const difference = compare(left, spaced);

    expect(difference?.headline).toContain("not in which statements they hold");
    expect(difference?.headline).not.toContain("different order");
    expect(difference?.lines).not.toEqual([]);
  });

  test("a line one schema does not have is named, on the side that has it", () => {
    const difference = compare(left, { of: "the right schema", text: 'CREATE TABLE "a" ();\n' });

    expect(difference?.lines).toEqual(['only in the left schema: CREATE TABLE "b" ();']);
    expect(difference?.headline).toContain("the left schema alone has 1 line");
  });
});
