import { describe, expect, test } from "bun:test";

import { type Allowlist, allowlistFrom } from "../.github/actions/_lib/gate.ts";
import { type Column, timestamptzGate } from "../.github/actions/db-gate/timestamptz.ts";

import { containing } from "./matchers.ts";

const parsed = (value: string): Allowlist => allowlistFrom(value, "timestamp-allowlist");

/** The gate takes the parsed input whole; these cases are about the columns rather than the reasons. */
const waiving = (...columns: string[]): Allowlist => ({
  entries: columns,
  unreasoned: new Set(),
  problems: [],
});

// Captured from information_schema on a real Postgres 16 carrying one of each
// escape: a table in a non-public schema, an array of wall-clock timestamps
// whose data_type is ARRAY, and a quoted identifier with a space in it. The
// timestamptz scalar, the timestamptz[] and the integer beside them are in it
// too — the query asks for every column, and what discriminates is the gate.
const COLUMNS = (await Bun.file(new URL("./columns.json", import.meta.url)).json()) as Column[];

function messages(problems: readonly { readonly message: string }[]): string[] {
  return problems.map(({ message }) => message);
}

describe("timestamptz gate", () => {
  test("a schema with no wall-clock column passes", () => {
    expect(timestamptzGate([], waiving())).toEqual([]);
  });

  test("every wall-clock column the catalogue reports is refused, schema and all", () => {
    expect(messages(timestamptzGate(COLUMNS, waiving()))).toEqual([
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
    const said = messages(timestamptzGate(COLUMNS, waiving()));
    expect(said.find((m) => m.includes("reading.samples"))).toContain(
      "store instants as timestamptz[]",
    );
    expect(said.find((m) => m.includes("events.occurred_at"))).toContain(
      "store instants as timestamptz,",
    );
  });

  test("an allowlisted column is the deliberate wall-clock case", () => {
    expect(timestamptzGate(COLUMNS, waiving("app.events.occurred_at"))).toHaveLength(2);
  });

  // A type name is a Postgres identifier, and the catalogue reports whatever a
  // repo called its enum. Asked of a plain object, "constructor" and "toString"
  // answer out of the prototype rather than out of the two wall-clock types —
  // and truthily, so a correct schema goes red and the diagnostic tells its
  // author to store instants as `function Object() { [native code] }`. Every
  // column reaches this now, rather than only the two types the query used to
  // filter for, so any repo with such a type reaches the lookup.
  test("a type named for something on Object's prototype is not a wall-clock type", () => {
    const typed = (udt_name: string): Column => ({
      table_schema: "public",
      table_name: "thing",
      column_name: "kind",
      udt_name,
    });

    expect(timestamptzGate([typed("constructor")], waiving())).toEqual([]);
    expect(timestamptzGate([typed("toString")], waiving())).toEqual([]);
    expect(timestamptzGate([typed("hasOwnProperty")], waiving())).toEqual([]);
  });

  // The columns the fixture carries beside the wall-clock ones. A gate that
  // refused on the catalogue rather than on the type would report all seven.
  test("a column that already stores an instant is not refused", () => {
    const said = messages(timestamptzGate(COLUMNS, waiving()));
    expect(said.some((m) => m.includes("recorded_at"))).toBe(false);
    expect(said.some((m) => m.includes("reading.instants"))).toBe(false);
    expect(said.some((m) => m.includes("events.id"))).toBe(false);
  });

  // The gate takes the allowlist whole, so the price of the hatch is charged
  // wherever the gate runs rather than by each entry point remembering to.
  test("an entry that waives a column without saying why is refused", () => {
    expect(messages(timestamptzGate([], parsed("public.opening_hours.opens_at")))).toEqual([
      containing("waives public.opening_hours.opens_at without saying why"),
    ]);
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

// The third gate in this repo to refuse a waiver that stands for nobody, after
// route-allowlist and stack-allowlist. An exemption nobody has to justify again
// is indistinguishable, a year later, from a bug someone silenced — and this
// one leaves the gate quietly covering a column fewer than the allowlist says.
describe("the price of the hatch", () => {
  // Two schemas can hold the same table, and an allowlist keyed without the
  // schema would exempt a column nobody looked at — and name one nobody has.
  test("the allowlist names one column in one schema", () => {
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

    expect(messages(timestamptzGate(COLUMNS, waiving("events.occurred_at")))).toEqual([
      containing("app.events.occurred_at is a wall-clock timestamp"),
      containing("public.audit log.at"),
      containing("public.reading.samples"),
      containing("waives events.occurred_at, which this schema has no column called"),
    ]);
  });

  // The entry a dropped or renamed column leaves behind. "Fix the name" is half
  // the diagnostic because a waiver that never matched anything and one whose
  // column has gone are the same line to look at and two different edits.
  test("a waiver for a column the schema does not have is refused", () => {
    expect(
      messages(timestamptzGate(COLUMNS, parsed("public.reading.taken_at -- a clock reading"))),
    ).toContainEqual(
      containing(
        "timestamp-allowlist waives public.reading.taken_at, which this schema has no column called — drop the entry, or fix the name",
      ),
    );
  });

  // The other way the hatch rots, and the reason the gate is handed the whole
  // catalogue: the column is still here and is no longer wall-clock. The
  // conversion the entry exempted the column from has happened, so sending its
  // author name-hunting would be sending them after a mistake they did not make.
  test("a waiver for a column that has since been converted says so, not 'fix the name'", () => {
    expect(
      messages(timestamptzGate(COLUMNS, parsed("app.events.recorded_at -- a clock reading"))),
    ).toContainEqual(
      containing(
        "timestamp-allowlist waives app.events.recorded_at, which is not a wall-clock column — the migration this entry was written against has been made, so drop the entry",
      ),
    );
  });

  test("a waiver for a wall-clock column that is still one is the hatch working", () => {
    expect(
      messages(timestamptzGate(COLUMNS, parsed("public.audit log.at -- the shift board's clock"))),
    ).toEqual([
      containing("app.events.occurred_at is a wall-clock timestamp"),
      containing("public.reading.samples is a wall-clock timestamp"),
    ]);
  });

  // One mistake earns one diagnostic: an entry with no reason is a line its
  // author is going back to regardless, and reporting it dead as well would be
  // two findings about one edit. The other two allowlists charge it the same
  // way.
  test("an entry with no reason is not also reported dead", () => {
    expect(messages(timestamptzGate(COLUMNS, parsed("public.reading.taken_at")))).toEqual([
      containing("waives public.reading.taken_at without saying why"),
      containing("app.events.occurred_at is a wall-clock timestamp"),
      containing("public.audit log.at"),
      containing("public.reading.samples"),
    ]);
  });

  // stack-gate goes quiet about dead entries while a manifest will not parse,
  // and route-coverage while the app reported no route table: what those two
  // walked came up short, and every waiver written for the missing part would
  // report as dead. Nothing here can come up short — the catalogue is one query,
  // and one that fails throws before the gate is called — so a catalogue with
  // nothing in it is a catalogue that was read, and a waiver against it is dead
  // rather than unexamined.
  test("an empty catalogue is a read rather than a half-read", () => {
    expect(
      messages(timestamptzGate([], parsed("public.opening_hours.opens_at -- the shop's clock"))),
    ).toEqual([containing("which this schema has no column called")]);
  });
});
