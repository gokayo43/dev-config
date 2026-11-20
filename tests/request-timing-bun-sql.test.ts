/**
 * The Bun.sql connector against a real Postgres.
 *
 * Invariant 1, the differential: one scripted sequence through drizzle and
 * through the client's own calls, run on a bare client and on the wrapped one,
 * each on a database of its own with the same rows, compared step by step and
 * by the rows each database ends with. The bare run is the oracle.
 *
 * What a count includes: a table of every way a query, a transaction or a
 * checkout is issued, each run as one operation, against the count the
 * export's page states.
 *
 * Invariant 3 at the seam: a property over overlapping operations on a pool of
 * one connection the case holds until every operation's first query has
 * started, so each is handed the connection by another's release.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { array, asyncProperty, boolean, integer, record } from "fast-check";

import { check } from "../property.ts";
import { timedSql } from "../request-timing-bun-sql.ts";
import { OperationName, requestTiming, type TimingRecord, within } from "../request-timing.ts";
import { counted, NONE, outcome } from "./request-timing-oracle.ts";
import { scratchPostgres } from "./request-timing-postgres.ts";

const presets = pgTable("presets", {
  id: serial().primaryKey(),
  label: varchar({ length: 64 }).notNull().unique(),
});

class Refused extends Error {}

/**
 * The sequence an app's database layer runs, through drizzle as the template
 * does and through each of the client's own ways in: reads, a transaction
 * that commits, one that rolls back, a savepoint that rolls back inside one
 * that commits, a query that fails, a reserved connection, and a transaction
 * that answers an array of queries.
 */
async function script(client: SQL) {
  const db = drizzle({ client });
  return {
    select: await outcome(() => db.select().from(presets).orderBy(presets.id)),
    tagged: await outcome(
      async () => await client<unknown>`select label from presets where id = ${1}`,
    ),
    unsafe: await outcome(
      async () => await client.unsafe<unknown>("select $1::int as n", [7]).values(),
    ),
    // duplicate-code-allow -- the steps the mysql2 suite's differential runs, over drizzle's Postgres dialect, whose table and database types the MySQL one shares none of
    committed: await outcome(() =>
      db.transaction(async (tx) => {
        await tx.insert(presets).values({ label: "third" });
        return tx.select().from(presets).where(eq(presets.label, "third"));
      }),
    ),
    rolledBack: await outcome(() =>
      db.transaction(async (tx) => {
        await tx.insert(presets).values({ label: "never" });
        throw new Refused("refused midway");
      }),
    ),
    savepoint: await outcome(() =>
      db.transaction(async (tx) => {
        await tx.insert(presets).values({ label: "kept" });
        await outcome(() =>
          tx.transaction(async (inner) => {
            await inner.insert(presets).values({ label: "undone" });
            throw new Refused("inner refused");
          }),
        );
        return tx.select().from(presets).orderBy(presets.id);
      }),
    ),
    failed: await outcome(() => db.insert(presets).values({ label: "first" })),
    reserved: await outcome(async () => {
      const connection = await client.reserve();
      try {
        return await connection<unknown>`select count(*)::int as n from presets`;
      } finally {
        await connection.release();
      }
    }),
    answeredArray: await outcome(() =>
      client.begin((tx) => [
        tx`insert into presets (label) values ('from an array')`,
        tx`select label from presets order by id`,
      ]),
    ),
    finally: await outcome(() => db.select().from(presets).orderBy(presets.id)),
  };
}

/** A client of its own on a database of its own, closed and dropped on disposal. */
async function database() {
  const scratch = await scratchPostgres();
  const client = new SQL(scratch.url);
  return {
    client,
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await scratch[Symbol.asyncDispose]();
    },
  };
}

describe("the Bun.sql connector", () => {
  test("changes nothing drizzle or the client's own callers see", async () => {
    await using bare = await database();
    await using wrapped = await database();
    const off = await script(bare.client);
    const on = await counted(() => script(timedSql(wrapped.client)));

    expect(on.answer).toEqual(off);
    expect(off.rolledBack).toMatchObject({ error: { message: "refused midway" } });
    expect(off.failed.error?.cause?.fields).toContain("errno=23505");
    expect(off.finally).toMatchObject({
      value: ["first", "second", "third", "kept", "from an array"].map((label) => ({ label })),
    });
  });

  // A query is one wait from when it starts running; a transaction is two
  // beside its queries, opening it and closing it, and so is a savepoint.
  const calls: [string, (client: SQL) => Promise<unknown>, number][] = [
    ["a tagged template", async (client) => await client<unknown>`select 1`, 1],
    [
      "unsafe, read as values",
      async (client) => await client.unsafe<unknown>("select 1").values(),
      1,
    ],
    [
      "a query awaited twice",
      async (client) => {
        const query = client`select 1`;
        await query;
        await query;
      },
      1,
    ],
    [
      "a query started by execute, then awaited",
      async (client) => await client<unknown>`select 1`.execute(),
      1,
    ],
    ["a query run by catch", async (client) => await client<unknown>`select 1`.catch(() => []), 1],
    [
      "a query run by finally",
      async (client) => await client<unknown>`select 1`.finally(() => 0),
      1,
    ],
    [
      "a helper, which is no query, inside one that is",
      async (client) => {
        const values = client({ label: "helped" });
        await client`insert into presets ${values}`;
      },
      1,
    ],
    ["a query that fails", (client) => client`select * from absent`.catch(() => []), 1],
    ["a drizzle select", async (client) => await drizzle({ client }).select().from(presets), 1],
    [
      "a drizzle transaction: begin, insert, commit",
      (client) =>
        drizzle({ client }).transaction((tx) => tx.insert(presets).values({ label: "in tx" })),
      3,
    ],
    [
      "a drizzle transaction that rolls back: begin, insert, rollback",
      (client) =>
        outcome(() =>
          drizzle({ client }).transaction(async (tx) => {
            await tx.insert(presets).values({ label: "rolled back" });
            throw new Refused("refused");
          }),
        ),
      3,
    ],
    [
      "a savepoint: begin, savepoint, insert, release, commit",
      (client) =>
        drizzle({ client }).transaction((tx) =>
          tx.transaction((inner) => inner.insert(presets).values({ label: "saved" })),
        ),
      5,
    ],
    [
      "a transaction that answers an array of two queries",
      (client) => client.begin((tx) => [tx`select 1`, tx`select 2`]),
      4,
    ],
    [
      "a reserved connection and two queries on it",
      async (client) => {
        const connection = await client.reserve();
        await connection`select 1`;
        await connection.unsafe("select 2");
        await connection.release();
      },
      3,
    ],
    [
      "a query read from a file",
      async (client) => {
        const directory = await mkdtemp(join(tmpdir(), "request-timing-"));
        try {
          const path = join(directory, "query.sql");
          await Bun.write(path, "select 1");
          await client.file(path);
        } finally {
          await rm(directory, { recursive: true });
        }
      },
      1,
    ],
    ["connect", async (client) => await client.connect(), 1],
    ["notify", (client) => client.notify("request_timing", "payload"), 1],
    [
      "listen, until the server confirms it",
      async (client) => {
        const subscription = await client.listen("request_timing", () => undefined);
        await subscription.unlisten();
      },
      1,
    ],
  ];
  for (const [what, call, db] of calls) {
    test(`counts ${what} as ${db}`, async () => {
      await using scratch = await database();
      const { counts } = await counted(() => call(timedSql(scratch.client)));
      expect(counts).toEqual({ ...NONE, db });
    });
  }

  test("counts a query made and never run as nothing, and as no time waited", async () => {
    await using scratch = await database();
    const client = timedSql(scratch.client);
    const made = await counted(async () => void client`select 1`);
    expect(made).toMatchObject({ counts: NONE, inFlightMs: 0 });
  });

  test("counts a query issued outside every operation in none", async () => {
    await using scratch = await database();
    const client = timedSql(scratch.client);
    const { counts } = await counted(async () => undefined);
    await client`select 1`;
    expect(counts).toEqual(NONE);
  });

  test("counts each overlapping operation's own queries, whoever hands it the connection", async () => {
    await using scratch = await scratchPostgres();
    await check(
      asyncProperty(
        array(record({ queries: integer({ min: 1, max: 3 }), transaction: boolean() }), {
          minLength: 2,
          maxLength: 6,
        }),
        async (plans) => {
          await using bare = new SQL({ url: scratch.url, max: 1 });
          const client = timedSql(bare);
          const records: TimingRecord[] = [];
          const timing = requestTiming({
            fault: (error) => {
              throw error;
            },
            sink: (made) => void records.push(made),
          });
          // The latch: the pool's one connection, held outside any operation
          // until every operation's first query has started, so each started
          // query is waiting for it. `execute` starts a query as it is called,
          // where `await` would start it a turn later, after the release.
          const holding = await bare.reserve();
          const lanes = plans.map(async (plan, lane) => {
            const operation = timing.open();
            await within(operation, async () => {
              await client`select ${lane}`.execute();
              for (let query = 1; query < plan.queries; query += 1) await client`select ${lane}`;
              if (plan.transaction) await client.begin((tx) => tx`select ${lane}`);
            });
            operation.close({
              method: "GET",
              name: OperationName.registered(`/lanes/${lane}`),
              status: 200,
              aborted: false,
              streamed: false,
            });
          });
          await holding.release();
          await Promise.all(lanes);
          expect(
            Object.fromEntries(records.map((made) => [made.operation, made.db.count])),
          ).toEqual(
            Object.fromEntries(
              plans.map((plan, lane) => [
                `/lanes/${lane}`,
                plan.queries + (plan.transaction ? 3 : 0),
              ]),
            ),
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
