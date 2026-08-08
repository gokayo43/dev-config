import { describe, expect, test } from "bun:test";

import { type Allowlist, allowlistFrom } from "../.github/actions/_lib/gate.ts";
import { timestamptzGate, type WallClockColumn } from "../.github/actions/db-gate/timestamptz.ts";

import { containing } from "./matchers.ts";

const parsed = (value: string): Allowlist => allowlistFrom(value, "timestamp-allowlist");

/** The gate takes the parsed input whole; these cases are about the columns rather than the reasons. */
const waiving = (...columns: string[]): Allowlist => ({
  entries: columns,
  unreasoned: [],
  problems: [],
});

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
    expect(timestamptzGate([], waiving())).toEqual([]);
  });

  test("every wall-clock column the catalogue reports is refused, schema and all", () => {
    expect(timestamptzGate(COLUMNS, waiving()).map(({ message }) => message)).toEqual([
      containing("app.events.occurred_at"),
      containing("public.audit log.at"),
      containing("public.reading.samples"),
    ]);
  });

  test("the diagnostic offers the allowlist rather than only refusing", () => {
    expect(timestamptzGate(COLUMNS, waiving())[0]?.message).toContain("timestamp-allowlist");
  });

  // An array of wall-clock timestamps becomes timestamptz[], not timestamptz —
  // a diagnostic naming the scalar type would be telling the author to make a
  // second wrong change.
  test("an array column is told to become timestamptz[]", () => {
    const messages = timestamptzGate(COLUMNS, waiving()).map(({ message }) => message);
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
    expect(timestamptzGate(COLUMNS, waiving(...deliberate))).toEqual([]);
  });

  // The gate takes the allowlist whole, so the price of the hatch is charged
  // wherever the gate runs rather than by each entry point remembering to.
  test("an entry that waives a column without saying why is refused", () => {
    expect(
      timestamptzGate([], parsed("public.opening_hours.opens_at")).map((p) => p.message),
    ).toEqual([containing("waives public.opening_hours.opens_at without saying why")]);
  });

  // Two schemas can hold the same table, and an allowlist keyed without the
  // schema would exempt a column nobody looked at.
  test("the allowlist names one column in one schema", () => {
    expect(timestamptzGate(COLUMNS, waiving("app.events.occurred_at"))).toHaveLength(2);
    expect(timestamptzGate(COLUMNS, waiving("events.occurred_at"))).toHaveLength(3);
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
        waiving("public.events.occurred_at"),
      ).map(({ message }) => message),
    ).toEqual([containing("app.events.occurred_at")]);
  });

  // A table name can carry a space — information_schema reports it verbatim —
  // so a space-separated input could not name one. The comma in the reason is
  // the other half of the same rule, which entriesIn states.
  test("an entry naming a quoted identifier survives the parse", () => {
    expect(
      parsed(
        "public.audit log.at -- the shift's wall clock, not an instant\napp.events.occurred_at -- ditto\n",
      ).entries,
    ).toEqual(["public.audit log.at", "app.events.occurred_at"]);
    expect(parsed("").entries).toEqual([]);
    expect(
      timestamptzGate(COLUMNS, parsed("public.audit log.at -- the shift's wall clock")),
    ).toHaveLength(2);
  });
});
