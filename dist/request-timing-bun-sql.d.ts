/**
 * Request timing's Bun.sql connector: an `SQL` client the app built, every
 * query it issues, every transaction and savepoint it opens and every
 * connection it reserves, each wait on the server counted as one `db` wait of
 * the operation that issued it. `docs/exports/request-timing.md` says what an
 * app mounts and what a count includes.
 *
 * A Bun query is a promise of the driver's own class, with private state its
 * methods refuse to find behind a Proxy, that runs on its first `then`. So a
 * query is never wrapped: the driver's own object is answered, with the
 * members that start it standing in on the object itself.
 */
import { SQL } from "bun";
/**
 * `client` with every wait on the server measured, each for the operation
 * current where the app issues it. One `db` wait each:
 *
 * - a query, made by calling the client as a tagged template or with a string,
 *   by `unsafe` or by `file`, from when it starts running until it settles,
 *   which includes waiting for a pooled connection;
 * - opening and closing a transaction (`begin`, `transaction`,
 *   `beginDistributed`, `distributed`) or a savepoint, whose own queries count
 *   one each through the client the callback is handed;
 * - `reserve`, the checkout, answering a reserved connection wrapped in turn;
 * - `connect`, `listen` until the server confirms it, `notify`,
 *   `commitDistributed` and `rollbackDistributed`.
 *
 * Everything else is the client's own, so drizzle and every caller use the
 * answer as they used the client: the same type, the same query objects,
 * results, errors and transaction boundaries. What a call makes of an object
 * or an array is a helper, not a query, and is what it was.
 */
export declare function timedSql<Client extends SQL>(client: Client): Client;