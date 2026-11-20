import { AsyncLocalStorage } from "node:async_hooks";
// request-timing-operation.ts
/**
* What request timing's modules share: the operation, the waits it
* accumulates, the record it closes into, and the storage that carries the
* current operation. No export names this file. `request-timing.ts`
* re-exports its public half, and `beginWait` is for the connectors that
* measure a driver's query object without the thunk form of `measure`.
*/
/**
* The schema version every record carries under `requestTiming`. The reader
* knows this version alone, and stops on a record of any other.
*/
const RECORD_VERSION = 1;
/**
* Every kind of wait, in the order the record and the reader list them: the
* database, an outside HTTP service, an in-memory store such as Redis. A new
* kind is an entry here and one in `perKind`, which the compiler then asks for.
*/
const WAIT_KINDS = [
	"db",
	"out",
	"store"
];
/** One value per kind of wait, each `of` that kind. */
function perKind(of) {
	return {
		db: of("db"),
		out: of("out"),
		store: of("store")
	};
}
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
	* address, which carries a person's ids and search terms, so the error says
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
* Starts a wait of `kind` against `operation`, answering what ends it: the
* half of `measure` a connector calls where a driver's query object cannot be
* wrapped in a thunk.
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
	return {
		open: () => openOperation(now, options.sink),
		finish: (operation, ended) => {
			try {
				operation.close(ended());
			} catch (error) {
				options.fault(error);
			}
		}
	};
}
/** Which operation is current, read by `measure` and `inOperation` and set by `within`. */
const current = new AsyncLocalStorage();
(class Operation {
	#now;
	#sink;
	#openedAt;
	#sums = perKind(() => 0);
	#counts = perKind(() => 0);
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
			...perKind(waited),
			aborted: ending.aborted,
			streamed: ending.streamed
		});
	}
});
// request-timing.ts
/**
* Request timing: which operation a wait belongs to, carried in
* `AsyncLocalStorage`, in plain async code and in an Effect program alike.
* `docs/exports/request-timing.md` is how an app adopts it, and
* `request-timing-conformance-effect.ts` says why an Effect program needs
* nothing more.
*/
/**
* Whether an operation is current. An entry connector asks it before opening
* one and opens nothing when it answers true, so work a page runs in-process
* during its own request, such as a server function it calls, counts in the
* page's operation and operations never nest.
*/
function inOperation() {
	return current.getStore() !== void 0;
}
/**
* Runs `handler` with `operation` as the current one, and answers what it
* answers, unchanged. Every `measure` called from it, or from anything it
* starts that keeps its async context, counts in `operation`.
*/
function within(operation, handler) {
	return current.run(operation, handler);
}
/**
* Runs `wait` and adds its duration to the current operation under `kind`, or
* to nothing when no operation is current. The operation is read when
* `measure` is called, so a wait belongs to the operation that issued it
* whoever settles it. The answer settles as `wait`'s promise does, with its
* value or its rejection, and a synchronous throw is thrown on. `wait` is
* called once, and a thenable it answers has its `then` called once.
*/
function measure(kind, wait) {
	const operation = current.getStore();
	if (operation === void 0) return Promise.resolve(wait());
	const end = beginWait(operation, kind);
	let pending;
	try {
		pending = wait();
	} catch (error) {
		end();
		throw error;
	}
	return Promise.resolve(pending).then((value) => {
		end();
		return value;
	}, (error) => {
		end();
		throw error;
	});
}
export { RECORD_VERSION as a, current as c, requestTiming as d, OperationName as i, methodOf as l, measure as n, WAIT_KINDS as o, within as r, beginWait as s, inOperation as t, perKind as u };
