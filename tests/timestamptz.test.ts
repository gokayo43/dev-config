import { describe, expect, test } from "bun:test";

import {
  allowlistFrom,
  timestamptzGate,
  type WallClockColumn,
} from "../.github/actions/db-gate/timestamptz.ts";

import { containing } from "./matchers.ts";

// Captured from information_schema on a real Postgres 16 carrying one of each
// escape: a table in a non-public schema, an array of wall-clock timestamps
// whose data_type is ARRAY, and a quoted identifier with a space in it. The
// timestamptz scalar and the timestamptz[] beside them are absent, which is
// what proves the query discriminates rather than matching everything.
const COLUMNS = (await Bun.file(
  new URL("./wall-clock-columns.json", import.meta.url),
).json()) as WallClockColumn[];

describe("timestamptz gate", () => {
  test("a schema with no wall-clock column passes", () => {
    expect(timestamptzGate([], [])).toEqual([]);
  });

  test("every wall-clock column the catalogue reports is refused, schema and all", () => {
    expect(timestamptzGate(COLUMNS, []).map(({ message }) => message)).toEqual([
      containing("app.events.occurred_at"),
      containing("public.audit log.at"),
      containing("public.reading.samples"),
    ]);
  });

  test("the diagnostic offers the allowlist rather than only refusing", () => {
    expect(timestamptzGate(COLUMNS, [])[0]?.message).toContain("timestamp-allowlist");
  });

  // An array of wall-clock timestamps becomes timestamptz[], not timestamptz —
  // a diagnostic naming the scalar type would be telling the author to make a
  // second wrong change.
  test("an array column is told to become timestamptz[]", () => {
    const messages = timestamptzGate(COLUMNS, []).map(({ message }) => message);
    expect(messages.find((m) => m.includes("reading.samples"))).toContain(
      "store instants as timestamptz[]",
    );
    expect(messages.find((m) => m.includes("events.occurred_at"))).toContain(
      "store instants as timestamptz,",
    );
  });

  test("an allowlisted column is the deliberate wall-clock case", () => {
    const deliberate = COLUMNS.map(({ table_schema, table_name, column_name }) =>
      [table_schema, table_name, column_name].join("."),
    );
    expect(timestamptzGate(COLUMNS, deliberate)).toEqual([]);
  });

  // Two schemas can hold the same table, and an allowlist keyed without the
  // schema would exempt a column nobody looked at.
  test("the allowlist names one column in one schema", () => {
    expect(timestamptzGate(COLUMNS, ["app.events.occurred_at"])).toHaveLength(2);
    expect(timestamptzGate(COLUMNS, ["events.occurred_at"])).toHaveLength(3);
    expect(
      timestamptzGate(
        [
          {
            table_schema: "app",
            table_name: "events",
            column_name: "occurred_at",
            udt_name: "timestamp",
          },
          {
            table_schema: "public",
            table_name: "events",
            column_name: "occurred_at",
            udt_name: "timestamp",
          },
        ],
        ["public.events.occurred_at"],
      ).map(({ message }) => message),
    ).toEqual([containing("app.events.occurred_at")]);
  });

  // A table name can carry a space — information_schema reports it verbatim —
  // so a space-separated input could not name one.
  test("an entry naming a quoted identifier survives the parse", () => {
    expect(allowlistFrom("public.audit log.at, app.events.occurred_at")).toEqual([
      "public.audit log.at",
      "app.events.occurred_at",
    ]);
    expect(allowlistFrom("public.audit log.at\napp.events.occurred_at\n")).toEqual([
      "public.audit log.at",
      "app.events.occurred_at",
    ]);
    expect(allowlistFrom("")).toEqual([]);
    expect(timestamptzGate(COLUMNS, allowlistFrom("public.audit log.at"))).toHaveLength(2);
  });
});
