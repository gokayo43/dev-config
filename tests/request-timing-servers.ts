/**
 * The real servers the request-timing connector suites run against, and the
 * one way those suites read what an operation counted.
 *
 * `TEST_MYSQL_URL` and `TEST_REDIS_URL` are refused rather than defaulted, for
 * the reason `tests/postgres.ts` gives: `localhost` on the box these suites run
 * on is a host address the live shop's MariaDB and the API's Redis answer on.
 * A suite here creates and drops a database of its own on the MySQL it is
 * given, and writes only keys under a prefix of its own on the Redis.
 */
import { createPool, type Pool } from "mysql2/promise";

import { required } from "../.github/actions/_lib/gate.ts";
import { only } from "../narrowing.ts";
import {
  OperationName,
  requestTiming,
  type TimingRecord,
  type WaitKind,
  within,
} from "../request-timing.ts";

export const MYSQL_URL = required(
  "TEST_MYSQL_URL",
  'the request-timing connector suites create and drop a database on the MySQL they are given, so they will not guess at one — point them at a throwaway (README\'s "Gating this repo" has the one-liner)',
);

export const REDIS_URL = required(
  "TEST_REDIS_URL",
  'the request-timing connector suites write keys on the Redis they are given, so they will not guess at one — point them at a throwaway (README\'s "Gating this repo" has the one-liner)',
);

let made = 0;

/**
 * A database of this run's own on `TEST_MYSQL_URL`, named for the process that
 * made it so two runs on one server never meet, with a `presets` table, and
 * dropped on disposal. `pool` reaches it with `connectionLimit` connections.
 */
export async function scratchDatabase(connectionLimit = 4) {
  made += 1;
  const name = `request_timing_${process.pid}_${made}`;
  const server = createPool({ uri: MYSQL_URL, connectionLimit: 1 });
  await server.query(`create database ${name}`);
  const url = new URL(MYSQL_URL);
  url.pathname = `/${name}`;
  const pool: Pool = createPool({ uri: url.href, connectionLimit });
  await pool.query(
    "create table presets (id int primary key auto_increment, label varchar(64) not null unique)",
  );
  await pool.query("insert into presets (label) values ('first'), ('second')");
  return {
    pool,
    url: url.href,
    [Symbol.asyncDispose]: async () => {
      await pool.end();
      await server.query(`drop database ${name}`);
      await server.end();
    },
  };
}

let prefixes = 0;

/** A key prefix no other run and no other case writes under. */
export function keyPrefix(): string {
  prefixes += 1;
  return `request-timing:${process.pid}:${prefixes}:`;
}

/** What one kind of wait came to in a record: its count alone, the part a real server makes deterministic. */
export type Counts = Readonly<Record<WaitKind, number>>;

const countsOf = (record: TimingRecord): Counts => ({
  db: record.db.count,
  out: record.out.count,
  store: record.store.count,
});

/**
 * Runs `work` as one operation and answers what it answered with the counts
 * its record carries.
 */
export async function counted<T>(work: () => Promise<T>): Promise<{ answer: T; counts: Counts }> {
  const records: TimingRecord[] = [];
  const operation = requestTiming({ sink: (record) => void records.push(record) }).open();
  const answer = await within(operation, work);
  operation.close({
    method: "GET",
    name: OperationName.registered("/counted"),
    status: 200,
    aborted: false,
    streamed: false,
  });
  return { answer, counts: countsOf(only(records)) };
}

/** No wait of any kind. */
export const NONE: Counts = { db: 0, out: 0, store: 0 };
