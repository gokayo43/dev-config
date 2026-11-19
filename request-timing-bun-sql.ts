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
import type { SQL } from "bun";

import { beginWait, type Operation, current } from "./request-timing-operation.ts";
import { standingIn, waitOn } from "./request-timing-wait.ts";

/**
 * Calls `ended` once `pending` settles, either way, through `Promise`'s own
 * `then`: a query's would start it running, and its species is `Promise`, so
 * nothing the driver built is constructed or run by the call.
 */
function onSettled(pending: Promise<unknown>, ended: () => void): void {
  void Promise.prototype.then.call(pending, ended, ended);
}

/**
 * Calls `ended` once what a transaction's callback answered has settled: the
 * promise it answered, or every query of the array it answered, or at once.
 */
function onAnswered(answer: unknown, ended: () => void): void {
  const pending = (Array.isArray(answer) ? answer : [answer]).filter(
    (part): part is Promise<unknown> => part instanceof Promise,
  );
  let left = pending.length;
  if (left === 0) return ended();
  for (const part of pending) {
    onSettled(part, () => {
      left -= 1;
      if (left === 0) ended();
    });
  }
}

/** A stand-in written on the query itself, where it is found ahead of the driver's own on its prototype. */
const member = (value: unknown): PropertyDescriptor => ({
  configurable: true,
  writable: true,
  value,
});

/**
 * `query`, the driver's own object, counted as one wait of `operation` from
 * when it starts running until it settles. It starts on its first `then`,
 * `catch`, `finally` or `execute`, which stand in on the object, each starting
 * the wait before calling the driver's own. `run` is the driver's, and starts
 * the wait through `then`, since the promise it answers resolves to the query.
 * A query never run waits on nothing and counts nothing.
 */
function timedQuery<Query extends SQL.Query<unknown>>(query: Query, operation: Operation): Query {
  // Read off the query to be called with the query as `this`, as the driver's own are.
  // oxlint-disable-next-line typescript/unbound-method -- see above
  const { then, catch: caught, finally: settled, execute } = query;
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    onSettled(query, beginWait(operation, "db"));
  };
  return Object.defineProperties(query, {
    // oxlint-disable-next-line unicorn/no-thenable -- the query is the driver's thenable already; this is its own `then`, started first
    then: member((...args: Parameters<Query["then"]>) => {
      start();
      return then.apply(query, args);
    }),
    catch: member((...args: Parameters<Query["catch"]>) => {
      start();
      return caught.apply(query, args);
    }),
    finally: member((...args: Parameters<Query["finally"]>) => {
      start();
      return settled.apply(query, args);
    }),
    execute: member(() => {
      start();
      return execute.call(query);
    }),
  });
}

/** `query`, counted as one wait of `operation` where there is one. */
const issued = <Query extends SQL.Query<unknown>>(
  operation: Operation | undefined,
  query: Query,
): Query => (operation === undefined ? query : timedQuery(query, operation));

/**
 * Whether what a call of the client answered is a query: a call with strings
 * answers one, and a call with an object or an array answers a helper for a
 * query to come, which is no promise.
 */
const isQuery = (answer: unknown): answer is SQL.Query<unknown> => answer instanceof Promise;

/**
 * A driver member that opens a transaction or a savepoint around the callback
 * it takes last, called on the client it was read from.
 */
type Opens = (args: readonly unknown[]) => Promise<unknown>;

// oxlint-disable anti-slop/no-unknown-returns -- a transaction's callback answers what the app's code does, and the driver what that comes to; both are passed on as they are
/**
 * Whether the last argument of a member that opens a transaction is its
 * callback, the shape Bun's own types give it; Bun refuses any other.
 */
const isCallback = (last: unknown): last is (client: SQL) => unknown => typeof last === "function";

/**
 * Opens a transaction or savepoint through `open` with `args`, whose last is
 * the app's callback. Opening it, which takes the connection and sends BEGIN
 * or SAVEPOINT, is one wait, until the callback is called; closing it, COMMIT,
 * ROLLBACK or RELEASE, is another, from when the callback's answer settles
 * until the driver's promise does. The callback is handed the client wrapped
 * in turn. Bun calls it in the context `begin` was called in, one queued for a
 * connection another context released included (measured on Bun 1.4.4), so
 * its queries count in the operation that opened the transaction.
 */
function transacting(open: Opens, args: readonly unknown[]): Promise<unknown> {
  const operation = current.getStore();
  const callback = args.at(-1);
  if (operation === undefined || !isCallback(callback)) return open(args);
  let opening: (() => void) | undefined = beginWait(operation, "db");
  let closing: (() => void) | undefined;
  const opened = (): void => {
    opening?.();
    opening = undefined;
  };
  const close = (): void => {
    closing = beginWait(operation, "db");
  };
  const inner = (client: SQL): unknown => {
    opened();
    let answer: unknown;
    try {
      answer = callback(timedSql(client));
    } catch (error) {
      close();
      throw error;
    }
    onAnswered(answer, close);
    return answer;
  };
  const pending = open([...args.slice(0, -1), inner]);
  onSettled(pending, () => {
    opened();
    closing?.();
  });
  return pending;
}
// oxlint-enable anti-slop/no-unknown-returns

/** The members that open a transaction or a savepoint around a callback. */
const TRANSACTIONS = new Set([
  "begin",
  "transaction",
  "beginDistributed",
  "distributed",
  "savepoint",
]);

/** The members that answer a promise of one wait on the server. */
const WAITS = new Set(["connect", "listen", "notify", "commitDistributed", "rollbackDistributed"]);

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
export function timedSql<Client extends SQL>(client: Client): Client {
  const standIns = new Map<PropertyKey, unknown>([
    [
      "unsafe",
      (...args: Parameters<SQL["unsafe"]>) => issued(current.getStore(), client.unsafe(...args)),
    ],
    [
      "file",
      (...args: Parameters<SQL["file"]>) => issued(current.getStore(), client.file(...args)),
    ],
    [
      "reserve",
      (...args: Parameters<SQL["reserve"]>) =>
        waitOn("db", () => client.reserve(...args)).then(timedSql),
    ],
  ]);
  // Bun's client keeps its methods on the client itself, and a client lacks
  // some, such as `savepoint` outside a transaction, which stay absent.
  for (const [key, own] of Object.entries(Object.getOwnPropertyDescriptors(client))) {
    const method: unknown = own.value;
    if (typeof method !== "function") continue;
    const send = (args: readonly unknown[]) => Promise.resolve<unknown>(method.apply(client, args));
    if (TRANSACTIONS.has(key)) {
      standIns.set(key, (...args: unknown[]) => transacting(send, args));
    } else if (WAITS.has(key)) {
      standIns.set(key, (...args: unknown[]) => waitOn("db", () => send(args)));
    }
  }
  const called = new Proxy(client, {
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- a call answers a query or a helper as the client's overloads type it, which a trap cannot name
    apply: (_target, receiver, args: unknown[]): unknown => {
      const answer: unknown = Function.prototype.apply.call(client, receiver, args);
      return isQuery(answer) ? issued(current.getStore(), answer) : answer;
    },
  });
  return standingIn(called, standIns);
}
