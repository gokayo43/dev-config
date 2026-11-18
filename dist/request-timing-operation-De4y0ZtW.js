//#region request-timing-operation.ts
/**
* What both carriers of request timing share: the operation, the waits it
* accumulates, and the record it closes into. No export names this file. The
* plain carrier re-exports its public half, and the Effect carrier reaches the
* one function a carrier needs, `beginWait`, which no app or connector calls.
*
* It imports nothing at all, so the plain export stays free of `effect` and the
* Effect export stays free of `node:async_hooks`.
*/
/**
* The schema version every record carries under `requestTiming`. The reader
* knows this version alone, and stops on a record of any other.
*/
const RECORD_VERSION = 1;
/** Every kind, in the order the record and the reader list them. */
const WAIT_KINDS = [
	"db",
	"out",
	"store"
];
/** Every method a record can carry. */
const METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"OTHER"
];
/** A request's method as a record carries it: a standard one upper-cased, and every other as `OTHER`. */
function methodOf(written) {
	const upper = written.toUpperCase();
	return METHODS.find((method) => method === upper) ?? "OTHER";
}
/** What marks a URL rather than a pattern: a query string, a fragment, a scheme. */
const URL_SHAPED = /[?#]|:\/\//u;
/** Every character that does not print as itself: control, format, unassigned and private-use characters, and every space or line separator. */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;
/**
* Why `pattern` is not a name a router could have registered, or nothing where
* it is one. `OperationName.registered` and the reader both ask it, so every
* record a connector can write is one the reader reads, and a log line the
* reader prints cannot carry a terminal escape or a fake row. The answer never
* quotes the pattern, which on a refusal is likely a request's own address.
*/
function patternProblem(pattern) {
	if (pattern === "") return "it is empty";
	if (pattern.length > 256) return `it is longer than 256 characters`;
	if (UNPRINTABLE.test(pattern)) return "it holds a space, a control character or another character that does not print";
	if (URL_SHAPED.test(pattern)) return "it holds a query string, a fragment or a scheme, which makes it a request's own address";
}
/**
* An operation's name as its router registered it: `/presets/:id`, never
* `/presets/42`; a procedure by its registered name. The only ways to make one
* are `registered`, which a connector hands the router's own pattern, and
* `unmatched`, so a string read off a request cannot reach a record by
* accident.
*/
var OperationName = class OperationName {
	/** The fixed name of a request no route matched. */
	static unmatched = new OperationName("unmatched");
	pattern;
	constructor(pattern) {
		this.pattern = pattern;
	}
	/**
	* The name a router registered. Throws where `patternProblem` names one: a
	* pattern shaped like a URL is a connector handing over the request's own
	* address, which carries a customer's ids and search terms, so the error says
	* what shape was refused and quotes none of it.
	*/
	static registered(pattern) {
		const problem = patternProblem(pattern);
		if (problem !== void 0) throw new Error(`request timing names an operation by the pattern its router registered, such as /presets/:id; this one was refused because ${problem}`);
		return new OperationName(pattern);
	}
};
const ignored = () => void 0;
/** Records carry microseconds: more digits are noise from the clock, and bytes in every log line. */
const micro = (ms) => Math.round(ms * 1e3) / 1e3;
/**
* Starts a wait of `kind` against `operation`, answering what ends it. A
* carrier's half of `measure`, exported for the Effect carrier's sake.
*/
let beginWait;
let openOperation;
const monotonic = () => performance.timeOrigin + performance.now();
/**
* Switches request timing on: every operation opened through the answer closes
* into one record handed to `sink`. Nothing is written by the export itself.
*/
function requestTiming(options) {
	const now = options.now ?? monotonic;
	return { open: () => openOperation(now, options.sink) };
}
(class Operation {
	#now;
	#sink;
	#openedAt;
	#sums = {
		db: 0,
		out: 0,
		store: 0
	};
	#counts = {
		db: 0,
		out: 0,
		store: 0
	};
	#sealed = false;
	/** Waits begun and not yet ended. */
	#active = 0;
	/** When `#active` last rose from zero. */
	#busySince = 0;
	#inFlight = 0;
	static {
		beginWait = (operation, kind) => operation.#begin(kind);
		openOperation = (now, sink) => new Operation(now, sink);
	}
	constructor(now, sink) {
		this.#now = now;
		this.#sink = sink;
		this.#openedAt = now();
	}
	#begin(kind) {
		if (this.#sealed) return ignored;
		const began = this.#now();
		if (this.#active === 0) this.#busySince = began;
		this.#active += 1;
		return () => {
			if (this.#sealed) return;
			const ended = this.#now();
			this.#sums[kind] += ended - began;
			this.#counts[kind] += 1;
			this.#active -= 1;
			if (this.#active === 0) this.#inFlight += ended - this.#busySince;
		};
	}
	/**
	* Seals the operation and hands its record to the sink. A wait still in
	* flight counts in no kind's sum or count, now or when it settles, though the
	* time it was in flight before the close is in `inFlightMs`. Throws on a
	* second close, since a connector closing twice is emitting a second record
	* for one response, and on a status outside 100 to 599. A sink that throws
	* throws out of here, after the operation is sealed.
	*/
	close(ending) {
		if (this.#sealed) throw new Error(`request timing: ${ending.method} ${ending.name.pattern} was closed twice; a connector closes an operation once, when its response has finished`);
		if (!Number.isInteger(ending.status) || ending.status < 100 || ending.status > 599) throw new Error(`request timing: ${ending.method} ${ending.name.pattern} closed with status ${ending.status}, which is not an HTTP status`);
		const closedAt = this.#now();
		this.#sealed = true;
		const inFlight = this.#inFlight + (this.#active > 0 ? closedAt - this.#busySince : 0);
		const waited = (kind) => ({
			waitMs: micro(this.#sums[kind]),
			count: this.#counts[kind]
		});
		this.#sink({
			requestTiming: 1,
			at: new Date(closedAt).toISOString(),
			method: ending.method,
			operation: ending.name.pattern,
			status: ending.status,
			totalMs: micro(closedAt - this.#openedAt),
			inFlightMs: micro(inFlight),
			db: waited("db"),
			out: waited("out"),
			store: waited("store"),
			aborted: ending.aborted,
			streamed: ending.streamed
		});
	}
});
//#endregion
export { methodOf as a, beginWait as i, RECORD_VERSION as n, requestTiming as o, WAIT_KINDS as r, OperationName as t };
