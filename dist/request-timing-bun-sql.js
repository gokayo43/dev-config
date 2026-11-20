import { c as current, s as beginWait } from "./request-timing-CRXpA8f5.js";
import { n as waitOn, t as standingIn } from "./request-timing-wait-Cj7WA-Qu.js";
// request-timing-bun-sql.ts
/**
* Calls `ended` once `pending` settles, either way, through `Promise`'s own
* `then`: a query's would start it running, and its species is `Promise`, so
* nothing the driver built is constructed or run by the call.
*/
function onSettled(pending, ended) {
	Promise.prototype.then.call(pending, ended, ended);
}
/**
* Calls `ended` once what a transaction's callback answered has settled: the
* promise it answered, or every query of the array it answered, or at once.
*/
function onAnswered(answer, ended) {
	const pending = (Array.isArray(answer) ? answer : [answer]).filter((part) => part instanceof Promise);
	let left = pending.length;
	if (left === 0) return ended();
	for (const part of pending) onSettled(part, () => {
		left -= 1;
		if (left === 0) ended();
	});
}
/** A stand-in written on the query itself, where it is found ahead of the driver's own on its prototype. */
const member = (value) => ({
	configurable: true,
	writable: true,
	value
});
/**
* `query`, the driver's own object, counted as one wait of `operation` from
* when it starts running until it settles. It starts on its first `then`,
* `catch`, `finally` or `execute`, which stand in on the object, each starting
* the wait before calling the driver's own. `run` is the driver's, and starts
* the wait through `then`, since the promise it answers resolves to the query.
* A query never run waits on nothing and counts nothing.
*/
function timedQuery(query, operation) {
	const { then, catch: caught, finally: settled, execute } = query;
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		onSettled(query, beginWait(operation, "db"));
	};
	return Object.defineProperties(query, {
		then: member((...args) => {
			start();
			return then.apply(query, args);
		}),
		catch: member((...args) => {
			start();
			return caught.apply(query, args);
		}),
		finally: member((...args) => {
			start();
			return settled.apply(query, args);
		}),
		execute: member(() => {
			start();
			return execute.call(query);
		})
	});
}
/** `query`, counted as one wait of `operation` where there is one. */
const issued = (operation, query) => operation === void 0 ? query : timedQuery(query, operation);
/**
* Whether what a call of the client answered is a query: a call with strings
* answers one, and a call with an object or an array answers a helper for a
* query to come, which is no promise.
*/
const isQuery = (answer) => answer instanceof Promise;
/**
* Whether the last argument of a member that opens a transaction is its
* callback, the shape Bun's own types give it; Bun refuses any other.
*/
const isCallback = (last) => typeof last === "function";
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
function transacting(open, args) {
	const operation = current.getStore();
	const callback = args.at(-1);
	if (operation === void 0 || !isCallback(callback)) return open(args);
	let opening = beginWait(operation, "db");
	let closing;
	const opened = () => {
		opening?.();
		opening = void 0;
	};
	const close = () => {
		closing = beginWait(operation, "db");
	};
	const inner = (client) => {
		opened();
		let answer;
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
/** The members that open a transaction or a savepoint around a callback. */
const TRANSACTIONS = /* @__PURE__ */ new Set([
	"begin",
	"transaction",
	"beginDistributed",
	"distributed",
	"savepoint"
]);
/** The members that answer a promise of one wait on the server. */
const WAITS = /* @__PURE__ */ new Set([
	"connect",
	"listen",
	"notify",
	"commitDistributed",
	"rollbackDistributed"
]);
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
function timedSql(client) {
	const standIns = /* @__PURE__ */ new Map([
		["unsafe", (...args) => issued(current.getStore(), client.unsafe(...args))],
		["file", (...args) => issued(current.getStore(), client.file(...args))],
		["reserve", (...args) => waitOn("db", () => client.reserve(...args)).then(timedSql)]
	]);
	for (const [key, own] of Object.entries(Object.getOwnPropertyDescriptors(client))) {
		const method = own.value;
		if (typeof method !== "function") continue;
		const send = (args) => Promise.resolve(method.apply(client, args));
		if (TRANSACTIONS.has(key)) standIns.set(key, (...args) => transacting(send, args));
		else if (WAITS.has(key)) standIns.set(key, (...args) => waitOn("db", () => send(args)));
	}
	const called = new Proxy(client, { apply: (_target, receiver, args) => {
		const answer = Function.prototype.apply.call(client, receiver, args);
		return isQuery(answer) ? issued(current.getStore(), answer) : answer;
	} });
	return standingIn(called, standIns);
}
export { timedSql };
