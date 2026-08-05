import { describe, expect, test } from "bun:test";

import { timestamptzGate, wallClockColumns } from "../.github/actions/db-gate/timestamptz.ts";

// A real `pg_dump --schema-only` of a schema built to carry both column types,
// quoted and unquoted identifiers, a precision modifier, a sequence and a view.
const DUMP = await Bun.file(new URL("./schema-dump.sql", import.meta.url)).text();

describe("timestamptz gate", () => {
  test("every wall-clock column in a real dump is found, and nothing else", () => {
    expect(wallClockColumns(DUMP)).toEqual([
      { table: "audit log", column: "at" },
      { table: "user", column: "opens_at" },
      { table: "user", column: "billing_day" },
    ]);
  });

  test("a schema of nothing but timestamptz passes", () => {
    const zoned = DUMP.replaceAll("without time zone", "with time zone");
    expect(timestamptzGate(zoned, [])).toEqual([]);
  });

  test("the diagnostic names the column and offers the allowlist", () => {
    const [first] = timestamptzGate(DUMP, []);
    expect(first?.message).toContain("audit log.at");
    expect(first?.message).toContain("timestamp-allowlist");
  });

  test("an allowlisted column is the deliberate wall-clock case", () => {
    expect(timestamptzGate(DUMP, ["audit log.at", "user.opens_at", "user.billing_day"])).toEqual([]);
  });

  test("the allowlist is per column, not per name", () => {
    expect(timestamptzGate(DUMP, ["user.opens_at"])).toHaveLength(2);
  });

  test("a column outside any CREATE TABLE block is not a column", () => {
    // The sequence body in the dump is indented exactly like a column list; a
    // parser that ignored block boundaries would read START WITH 1 as one.
    expect(wallClockColumns("CREATE SEQUENCE public.s\n    START WITH 1 timestamp without time zone\n")).toEqual([]);
  });
});
