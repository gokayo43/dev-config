/**
 * Request timing's mysql2 connector: a pool created by `mysql2/promise`, every
 * connection taken from it and every statement prepared on one, each call that
 * waits on the server counted as one `db` wait of the operation that made it.
 * `docs/exports/request-timing.md` says what an app mounts and what a count
 * includes.
 */
import { Pool } from "mysql2/promise";
/**
 * `pool` with every wait on the server measured: `query` and `execute` on the
 * pool, one wait each with the checkout they make inside, and `getConnection`,
 * one wait, answering a connection whose own waits are measured. Everything
 * else is the pool's own, so drizzle and every caller use the answer as they
 * used the pool: the same type, prototype, events, results, errors and
 * transaction boundaries.
 */
export declare function timedPool<P extends Pool>(pool: P): P;