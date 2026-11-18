/**
 * The mysql2 connector against a real MySQL.
 *
 * Invariant 1, the differential: one scripted sequence through drizzle and
 * through the raw pool, run on a bare pool and on the wrapped one, each on a
 * database of its own with the same rows, compared step by step and by the
 * rows each database ends with. The bare run is the oracle.
 *
 * What a count includes: a table of every call the connector measures, each
 * run as one operation, against the count its page states.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import type { Pool, RowDataPacket } from "mysql2/promise";

import { rejectionOf } from "../narrowing.ts";
import { timedPool } from "../request-timing-mysql2.ts";
import { counted, NONE, outcome } from "./request-timing-oracle.ts";
import { MYSQL_URL, scratchDatabase } from "./request-timing-servers.ts";

const presets = mysqlTable("presets", {
  id: int().primaryKey().autoincrement(),
  label: varchar({ length: 64 }).notNull().unique(),
});

class Refused extends Error {}

/**
 * The sequence an app's database layer runs: reads, a transaction that
 * commits, one that rolls back, a query that fails, a named lock held on a
 * connection of its own, the warehouse's locked transaction on a drizzle made
 * from one connection, a prepared statement, and streamed rows.
 */
async function script(pool: Pool) {
  const db = drizzle(pool);
  return {
    select: await outcome(() => db.select().from(presets).orderBy(presets.id)),
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
    failed: await outcome(() => db.insert(presets).values({ label: "first" })),
    locked: await outcome(async () => {
      const connection = await pool.getConnection();
      try {
        const [taken] = await connection.query<RowDataPacket[]>("select get_lock('rt', 1) as got");
        const [released] = await connection.query<RowDataPacket[]>(
          "select release_lock('rt') as gone",
        );
        return { taken, released };
      } finally {
        connection.release();
      }
    }),
    lockedTransaction: await outcome(async () => {
      const connection = await pool.getConnection();
      try {
        return await drizzle({ client: connection }).transaction(async (tx) => {
          await connection.query("select get_lock('rt-tx', 1)");
          await tx.update(presets).set({ label: "second, renamed" }).where(eq(presets.id, 2));
          return tx.select().from(presets).where(eq(presets.id, 2));
        });
      } finally {
        await connection.query("select release_lock('rt-tx')");
        pool.releaseConnection(connection);
      }
    }),
    prepared: await outcome(async () => {
      const connection = await pool.getConnection();
      try {
        const statement = await connection.prepare("select label from presets where id = ?");
        const [rows] = await statement.execute([1]);
        await statement.close();
        return rows;
      } finally {
        connection.release();
      }
    }),
    streamed: await outcome(async () => {
      const rows: unknown[] = [];
      for await (const row of db.select().from(presets).orderBy(presets.id).iterator()) {
        rows.push(row);
      }
      return rows;
    }),
    finally: await outcome(() => db.select().from(presets).orderBy(presets.id)),
  };
}

describe("the mysql2 connector", () => {
  test("changes nothing drizzle or the pool's own callers see", async () => {
    await using bare = await scratchDatabase();
    await using wrapped = await scratchDatabase();
    const off = await script(bare.pool);
    const on = await counted(() => script(timedPool(wrapped.pool)));

    expect(on.answer).toEqual(off);
    expect(off.rolledBack).toMatchObject({ error: { message: "refused midway" } });
    expect(off.failed.error?.cause?.fields).toContain("code=ER_DUP_ENTRY");
  });

  // A checkout is one wait, and so is each statement a connection sends;
  // the pool's own `query` is one, its checkout inside it.
  const calls: [string, (pool: Pool) => Promise<unknown>, number][] = [
    ["pool.query", (pool) => pool.query("select 1"), 1],
    ["pool.execute", (pool) => pool.execute("select ?", [1]), 1],
    [
      "a checkout and two statements on it",
      async (pool) => {
        const connection = await pool.getConnection();
        await connection.query("select 1");
        await connection.execute("select ?", [2]);
        connection.release();
      },
      3,
    ],
    [
      "a transaction by hand",
      async (pool) => {
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        await connection.query("insert into presets (label) values ('by hand')");
        await connection.rollback();
        await connection.beginTransaction();
        await connection.commit();
        await connection.ping();
        connection.release();
      },
      7,
    ],
    [
      "a prepared statement",
      async (pool) => {
        const connection = await pool.getConnection();
        const statement = await connection.prepare("select ?");
        await statement.execute([1]);
        await statement.close();
        connection.release();
      },
      3,
    ],
    [
      "a session reset and a change of user",
      async (pool) => {
        const connection = await pool.getConnection();
        await connection.reset();
        const { username, password } = new URL(MYSQL_URL);
        await connection.changeUser({ user: username, password });
        connection.release();
      },
      3,
    ],
    ["a drizzle select", async (pool) => await drizzle(pool).select().from(presets), 1],
    [
      "a drizzle transaction: checkout, begin, insert, commit",
      (pool) => drizzle(pool).transaction((tx) => tx.insert(presets).values({ label: "in tx" })),
      4,
    ],
    [
      "streamed rows: the checkout alone, the rows read with the code's own time",
      async (pool) => {
        for await (const row of drizzle(pool).select().from(presets).iterator()) void row;
      },
      1,
    ],
  ];
  for (const [what, call, db] of calls) {
    test(`counts ${what} as ${db}`, async () => {
      await using database = await scratchDatabase();
      const { counts } = await counted(() => call(timedPool(database.pool)));
      expect(counts).toEqual({ ...NONE, db });
    });
  }

  test("counts a statement that fails, and hands its error back as it was", async () => {
    await using database = await scratchDatabase();
    const pool = timedPool(database.pool);
    const { answer, counts } = await counted(() =>
      rejectionOf(pool.query("select * from absent"), Error),
    );
    expect(answer.message).toContain("absent");
    expect(counts).toEqual({ ...NONE, db: 1 });
  });

  test("hands a connection back that the pool takes as its own", async () => {
    // `releaseConnection` takes back only what is an instance of its own
    // connection class; one it refused would hold the single connection.
    await using database = await scratchDatabase(1);
    const pool = timedPool(database.pool);
    pool.releaseConnection(await pool.getConnection());
    const again = await pool.getConnection();
    again.release();
  });
});
