import { describe, expect, test } from "bun:test";

import { timestamptzGate, type WallClockColumn } from "../.github/actions/db-gate/timestamptz.ts";

import { containing } from "./matchers.ts";

// Captured from information_schema on a real Postgres 16 whose schema carries
// both column types, a quoted identifier and a precision modifier.
const COLUMNS = (await Bun.file(
  new URL("./wall-clock-columns.json", import.meta.url),
).json()) as WallClockColumn[];

describe("timestamptz gate", () => {
  test("a schema with no wall-clock column passes", () => {
    expect(timestamptzGate([], [])).toEqual([]);
  });

  test("every wall-clock column the catalogue reports is refused", () => {
    expect(timestamptzGate(COLUMNS, []).map(({ message }) => message)).toEqual([
      containing("audit log.at"),
      containing("user.billing_day"),
      containing("user.opens_at"),
    ]);
  });

  test("the diagnostic offers the allowlist rather than only refusing", () => {
    expect(timestamptzGate(COLUMNS, [])[0]?.message).toContain("timestamp-allowlist");
  });

  test("an allowlisted column is the deliberate wall-clock case", () => {
    const deliberate = COLUMNS.map(({ table_name, column_name }) => `${table_name}.${column_name}`);
    expect(timestamptzGate(COLUMNS, deliberate)).toEqual([]);
  });

  test("the allowlist is per column, not per table or per name", () => {
    expect(timestamptzGate(COLUMNS, ["user.opens_at"])).toHaveLength(2);
    expect(timestamptzGate(COLUMNS, ["opens_at"])).toHaveLength(3);
  });
});
