import { describe, expect, test } from "bun:test";

import { SQL } from "bun";

import {
  beside,
  compare,
  databaseIn,
  discard,
  type Dump,
  rows,
  scratchDatabase,
  textColumn,
} from "../.github/actions/db-gate/database.ts";

const SERVER =
  Bun.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/postgres";

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
// `Bun.SQL` answers `any`, so nothing about a row is checked by the compiler.
// The wrong implementation is the one that trusts the query and reads the field
// anyway: it gets a `TypeError` three frames later, about a value whose origin
// the stack no longer names.
describe("reading rows off a query", () => {
  const db = new SQL(SERVER);

  test("a row is handed over as an object with the columns it answered", async () => {
    expect(await rows(db, "select 1 as n, 'a' as t")).toEqual([{ n: 1, t: "a" }]);
  });

  test("a named column arrives as the text it has to be", async () => {
    expect(await textColumn(db, "select 'public' as s union all select 'app'", "s")).toEqual([
      "public",
      "app",
    ]);
  });

  /** What a read was refused with, or the fact that it was not refused at all. */
  async function refusal(read: Promise<unknown>): Promise<string> {
    return await read.then(
      () => "the query was accepted",
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );
  }

  test("a column that is not text is refused, naming the column and the query", async () => {
    expect(await refusal(textColumn(db, "select 1 as n", "n"))).toContain(
      "has n as a number rather than text",
    );
  });

  test("a column the query never answered is refused too", async () => {
    expect(await refusal(textColumn(db, "select 1 as n", "missing"))).toContain(
      "has missing as absent rather than text",
    );
  });
});

describe("comparing two dumps", () => {
  /** A schema dump's units, which is how the replay gate cuts one: its lines. */
  const lines = (of: string, text: string): Dump => ({ of, each: "line", units: text.split("\n") });

  const left = lines("the left schema", 'CREATE TABLE "a" ();\nCREATE TABLE "b" ();\n');

  test("identical text is the only way two schemas are equal", () => {
    expect(
      compare(left, lines("the right schema", 'CREATE TABLE "a" ();\nCREATE TABLE "b" ();\n')),
    ).toBeUndefined();
  });

  test("the same statements arranged differently are not equal, and say so", () => {
    const difference = compare(
      left,
      lines("the right schema", 'CREATE TABLE "b" ();\nCREATE TABLE "a" ();\n'),
    );

    expect(difference?.headline).toContain("not in which statements they hold");
    expect(difference?.lines).not.toEqual([]);
  });

  // The tally is of statements, so a blank line moves nothing in it. Reporting
  // that as "a different order" was a claim about something never compared.
  test("a blank-line difference is not reported as a different order", () => {
    const difference = compare(
      left,
      lines("the right schema", 'CREATE TABLE "a" ();\n\nCREATE TABLE "b" ();\n'),
    );

    expect(difference?.headline).toContain("not in which statements they hold");
    expect(difference?.headline).not.toContain("different order");
    expect(difference?.lines).not.toEqual([]);
  });

  test("a line one schema does not have is named, on the side that has it", () => {
    const difference = compare(left, lines("the right schema", 'CREATE TABLE "a" ();\n'));

    expect(difference?.lines).toEqual(['only in the left schema: CREATE TABLE "b" ();']);
    expect(difference?.headline).toContain("the left schema alone has 1 line");
  });

  // The producer says what a unit is called, because the two halves of a
  // database are not compared in the same thing. A count of "lines" over rows
  // that each span several would be the diagnostic repeating the mistake the
  // unit exists to prevent.
  test("the count is of whatever the producer cut the dump into", () => {
    /** A data dump's units, which the replay gate cuts per row rather than per line. */
    const perRow = (of: string, ...units: string[]): Dump => ({ of, each: "row", units });
    const difference = compare(
      perRow("the data before", "INSERT INTO t VALUES (1, 'A\nB');"),
      perRow("the data after"),
    );

    expect(difference?.headline).toContain("the data before alone has 1 row");
    expect(difference?.lines).toEqual([
      "only in the data before: INSERT INTO t VALUES (1, 'A\nB');",
    ]);
  });
});

/**
 * The cleanup a gate does on its way out, driven against a connection that
 * cannot carry it. A closed client is the deterministic form of the thing that
 * happens for real — the server going away mid-run, the backend terminated,
 * the container stopped — because a killed connection is reconnected under us
 * often enough that a test built on one grades the reconnect instead.
 */
describe("giving up the database a gate built", () => {
  async function unusable(): Promise<SQL> {
    const server = new SQL(SERVER);
    await server.unsafe("select 1");
    await server.close();
    return server;
  }

  /** Captures what a case writes to stdout, and puts stdout back. */
  function logged(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const wrote = console.log;
    console.log = (line: unknown) => void lines.push(String(line));
    return { lines, restore: () => void (console.log = wrote) };
  }

  test("a drop that cannot run does not become the error the run reports", async () => {
    const server = await unusable();
    const captured = logged();

    // The shape the gates use it in. `boom` is the failure the author has to
    // read; a `finally` that throws would replace it with one about cleanup.
    const surfaced = await (async () => {
      try {
        throw new Error("boom: the migration that would not apply");
      } finally {
        await discard(server, "backfill_0123456789abcdef");
      }
    })().then(
      () => "no error at all",
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );
    captured.restore();

    expect(surfaced).toBe("boom: the migration that would not apply");
    expect(captured.lines.length).toBe(1);
    expect(captured.lines[0]).toContain("::notice::could not drop backfill_0123456789abcdef");
  });

  test("the database it could not drop is named as reclaimed, not lost", async () => {
    const server = await unusable();
    const captured = logged();

    await discard(server, "upgrade_path_fedcba9876543210");
    captured.restore();

    expect(captured.lines.join("\n")).toContain(
      "drops it by the same derived name before it creates one",
    );
  });
});
