/**
 * Request timing's mysql2 connector: a pool created by `mysql2/promise`, every
 * connection taken from it and every statement prepared on one, each call that
 * waits on the server counted as one `db` wait of the operation that made it.
 * `docs/exports/request-timing.md` says what an app mounts and what a count
 * includes.
 */
import type { Pool, PoolConnection, PreparedStatementInfo } from "mysql2/promise";

import { standingIn, waitOn } from "./request-timing-wait.ts";

function timedStatement(statement: PreparedStatementInfo): PreparedStatementInfo {
  return standingIn(
    statement,
    new Map([
      [
        "execute",
        (...args: Parameters<PreparedStatementInfo["execute"]>) =>
          waitOn("db", () => statement.execute(...args)),
      ],
    ]),
  );
}

/**
 * `connection` with each call that waits on the server measured. `prepare` is
 * one, and answers a statement whose `execute` is measured in turn. `release`,
 * `destroy`, the escapes, the events and `connection`, the callback-API
 * connection beneath, are the connection's own.
 */
function timedConnection(connection: PoolConnection): PoolConnection {
  return standingIn(
    connection,
    new Map<PropertyKey, unknown>([
      [
        "query",
        (...args: Parameters<PoolConnection["query"]>) =>
          waitOn("db", () => connection.query(...args)),
      ],
      [
        "execute",
        (...args: Parameters<PoolConnection["execute"]>) =>
          waitOn("db", () => connection.execute(...args)),
      ],
      ["beginTransaction", () => waitOn("db", () => connection.beginTransaction())],
      ["commit", () => waitOn("db", () => connection.commit())],
      ["rollback", () => waitOn("db", () => connection.rollback())],
      ["ping", () => waitOn("db", () => connection.ping())],
      ["reset", () => waitOn("db", () => connection.reset())],
      [
        "changeUser",
        (...args: Parameters<PoolConnection["changeUser"]>) =>
          waitOn("db", () => connection.changeUser(...args)),
      ],
      [
        "prepare",
        (...args: Parameters<PoolConnection["prepare"]>) =>
          waitOn("db", () => connection.prepare(...args)).then(timedStatement),
      ],
    ]),
  );
}

/**
 * `pool` with every wait on the server measured: `query` and `execute` on the
 * pool, one wait each with the checkout they make inside, and `getConnection`,
 * one wait, answering a connection whose own waits are measured. Everything
 * else is the pool's own, so drizzle and every caller use the answer as they
 * used the pool: the same type, prototype, events, results, errors and
 * transaction boundaries.
 */
export function timedPool<P extends Pool>(pool: P): P {
  return standingIn(
    pool,
    new Map<PropertyKey, unknown>([
      ["query", (...args: Parameters<Pool["query"]>) => waitOn("db", () => pool.query(...args))],
      [
        "execute",
        (...args: Parameters<Pool["execute"]>) => waitOn("db", () => pool.execute(...args)),
      ],
      ["getConnection", () => waitOn("db", () => pool.getConnection()).then(timedConnection)],
    ]),
  );
}
