import { n as waitOn, t as standingIn } from "./request-timing-wait-Cj7WA-Qu.js";
// request-timing-mysql2.ts
function timedStatement(statement) {
	return standingIn(statement, /* @__PURE__ */ new Map([["execute", (...args) => waitOn("db", () => statement.execute(...args))]]));
}
/**
* `connection` with each call that waits on the server measured. `prepare` is
* one, and answers a statement whose `execute` is measured in turn. `release`,
* `destroy`, the escapes, the events and `connection`, the callback-API
* connection beneath, are the connection's own.
*/
function timedConnection(connection) {
	return standingIn(connection, /* @__PURE__ */ new Map([
		["query", (...args) => waitOn("db", () => connection.query(...args))],
		["execute", (...args) => waitOn("db", () => connection.execute(...args))],
		["beginTransaction", () => waitOn("db", () => connection.beginTransaction())],
		["commit", () => waitOn("db", () => connection.commit())],
		["rollback", () => waitOn("db", () => connection.rollback())],
		["ping", () => waitOn("db", () => connection.ping())],
		["reset", () => waitOn("db", () => connection.reset())],
		["changeUser", (...args) => waitOn("db", () => connection.changeUser(...args))],
		["prepare", (...args) => waitOn("db", () => connection.prepare(...args)).then(timedStatement)]
	]));
}
/**
* `pool` with every wait on the server measured: `query` and `execute` on the
* pool, one wait each with the checkout they make inside, and `getConnection`,
* one wait, answering a connection whose own waits are measured. Everything
* else is the pool's own, so drizzle and every caller use the answer as they
* used the pool: the same type, prototype, events, results, errors and
* transaction boundaries.
*/
function timedPool(pool) {
	return standingIn(pool, /* @__PURE__ */ new Map([
		["query", (...args) => waitOn("db", () => pool.query(...args))],
		["execute", (...args) => waitOn("db", () => pool.execute(...args))],
		["getConnection", () => waitOn("db", () => pool.getConnection()).then(timedConnection)]
	]));
}
export { timedPool };
