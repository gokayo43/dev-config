import { Pool } from "mysql2/promise";
//#region request-timing-mysql2.d.ts
/**
 * `pool` with every wait on the server measured: `query` and `execute` on the
 * pool, one wait each with the checkout they make inside, and `getConnection`,
 * one wait, answering a connection whose own waits are measured. Everything
 * else is the pool's own, so drizzle and every caller use the answer as they
 * used the pool: the same type, prototype, events, results, errors and
 * transaction boundaries.
 */
export declare function timedPool<P extends Pool>(pool: P): P;
//#endregion