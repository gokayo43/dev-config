import { test as test$1 } from "./invariant-sweep.js";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { createHash } from "node:crypto";
//#region count-ceilings.ts
const COUNTS = [
	"reactCommits",
	"mutationRecords",
	"requests",
	"bodyBytes",
	"scriptBytes"
];
/** The variable that turns a run into the command. */
const MODE = "COUNT_BUDGET";
const command = (where) => `${MODE}=write bunx playwright test ${where.spec}`;
function isJson(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asJson(value, where) {
	if (!isJson(value)) throw new Error(`${where} is not a JSON object`);
	return value;
}
function isRaised(ceiling) {
	return typeof ceiling === "object";
}
function ceilingOf(ceiling) {
	return isRaised(ceiling) ? ceiling.ceiling : ceiling;
}
function byCodePoint(a, b) {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
const DIGEST = 8;
function digest(phase, count, accepted) {
	return createHash("sha256").update(`${phase}\u0000${count}\u0000${accepted}`).digest("hex").slice(0, DIGEST);
}
/** Every count of an entry, in the one order its seal lists them. */
function slots(phases) {
	return [...phases].flatMap(([phase, counts]) => [...counts].map(([count, ceiling]) => [
		phase,
		count,
		ceiling
	])).toSorted(([a, x], [b, y]) => byCodePoint(`${a}\u0000${x}`, `${b}\u0000${y}`));
}
/**
* The seal: per count, a digest of the ceiling the command accepted for it. A
* plain number is accepted as written, and a raise once the command has kept it.
*/
function sealOf(phases) {
	return slots(phases).map(([phase, count, ceiling]) => digest(phase, count, ceilingOf(ceiling))).join("");
}
const slotKey = (phase, count) => `${phase}\u0000${count}`;
/**
* The raises a person made since the command last wrote the entry: those whose
* `was` is the number the seal accepted. `undefined` when any number was changed
* in place, which is an edit the seal exists to catch.
*/
function freshRaises(entry) {
	const each = slots(entry.phases);
	if (entry.seal.length !== each.length * DIGEST) return void 0;
	const fresh = /* @__PURE__ */ new Set();
	for (const [index, [phase, count, ceiling]] of each.entries()) {
		const held = entry.seal.slice(index * DIGEST, (index + 1) * DIGEST);
		if (held === digest(phase, count, ceilingOf(ceiling))) continue;
		if (!isRaised(ceiling) || held !== digest(phase, count, ceiling.was)) return void 0;
		fresh.add(slotKey(phase, count));
	}
	return fresh;
}
function isBroken(entry) {
	return freshRaises(entry) === void 0;
}
function isCount(name) {
	return COUNTS.some((count) => count === name);
}
function isWhole(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function ceilingAt(value, where) {
	if (isWhole(value)) return value;
	if (typeof value === "number") throw new Error(`${where} is ${value}, and a ceiling is a whole number of zero or more`);
	const { ceiling, was, reason } = asJson(value, where);
	if (!isWhole(ceiling) || !isWhole(was)) throw new Error(`${where} is neither a whole number nor a raised ceiling written as { "ceiling": <new>, "was": <the ceiling the command last accepted>, "reason": "<why>" }`);
	if (typeof reason !== "string" || reason.trim() === "") throw new Error(`${where} is raised from ${was} to ${ceiling} with no reason: say why the page does more in its "reason"`);
	if (ceiling <= was) throw new Error(`${where} is written as raised, but its ceiling ${ceiling} is not above the ${was} the command accepted; a lower ceiling is the command's to write`);
	return {
		ceiling,
		was,
		reason
	};
}
/** One test's entry, read from a file a person may have edited. */
function entryAt(value, where) {
	const held = asJson(value, where);
	const { browser, seal } = held;
	if (typeof browser !== "string") throw new Error(`${where}.browser is not a string`);
	if (typeof seal !== "string") throw new Error(`${where}.seal is not a string`);
	const phases = /* @__PURE__ */ new Map();
	for (const [phase, counts] of Object.entries(asJson(held["phases"], `${where}.phases`))) {
		const ceilings = /* @__PURE__ */ new Map();
		for (const [count, ceiling] of Object.entries(asJson(counts, `${where}.phases.${phase}`))) {
			if (!isCount(count)) throw new Error(`${where}.phases.${phase}.${count} is not a count; the counts are ${COUNTS.join(", ")}`);
			ceilings.set(count, ceilingAt(ceiling, `${where}.phases.${phase}.${count}`));
		}
		phases.set(phase, ceilings);
	}
	return {
		browser,
		phases,
		seal
	};
}
/** An entry as the file holds it. */
function entryJson(entry) {
	return {
		browser: entry.browser,
		phases: Object.fromEntries([...entry.phases].map(([phase, counts]) => [phase, Object.fromEntries(counts)])),
		seal: entry.seal
	};
}
/** A whole file with one test's entry set, its tests in code-point order. */
function withEntry(file, key, entry) {
	const others = Object.entries(file).filter(([held]) => held !== key);
	return Object.fromEntries([...others, [key, entryJson(entry)]].toSorted(([a], [b]) => byCodePoint(a, b)));
}
function entryIn(file, key, where) {
	return Object.hasOwn(file, key) ? entryAt(file[key], where) : void 0;
}
function lowerPhase(phase, counts, held) {
	const next = /* @__PURE__ */ new Map();
	const changes = [];
	for (const count of COUNTS) {
		const measured = counts[count];
		const ceiling = held.get(count);
		if (measured === void 0) {
			if (ceiling !== void 0) changes.push({
				kind: "count dropped",
				phase,
				count,
				ceiling
			});
		} else if (ceiling === void 0) {
			next.set(count, measured);
			changes.push({
				kind: "count added",
				phase,
				count,
				measured
			});
		} else if (measured < ceilingOf(ceiling)) {
			next.set(count, measured);
			changes.push({
				kind: "lowered",
				phase,
				count,
				measured,
				ceiling
			});
		} else {
			next.set(count, ceiling);
			if (measured > ceilingOf(ceiling)) changes.push({
				kind: "above",
				phase,
				count,
				measured,
				ceiling
			});
		}
	}
	return {
		next,
		changes
	};
}
/**
* The one rule: what the command writes for a test, and every way that differs
* from what is stored. Every ceiling becomes the lower of itself and the
* measure; a count with no ceiling is written as measured; one no longer
* measured is dropped; none is raised, so a count above its ceiling keeps the
* ceiling. A check fails exactly when this lists a change.
*
* The entry handed in is not `isBroken`.
*/
function lowered(entry, measured, browser) {
	const phases = /* @__PURE__ */ new Map();
	if (entry === void 0) {
		for (const [phase, counts] of measured) phases.set(phase, lowerPhase(phase, counts, /* @__PURE__ */ new Map()).next);
		return {
			entry: {
				browser,
				phases,
				seal: sealOf(phases)
			},
			changes: [{ kind: "new" }]
		};
	}
	const changes = [];
	if (entry.browser !== browser) changes.push({
		kind: "browser",
		from: entry.browser,
		to: browser
	});
	for (const phase of entry.phases.keys()) if (!measured.has(phase)) changes.push({
		kind: "phase dropped",
		phase
	});
	for (const [phase, counts] of measured) {
		const held = entry.phases.get(phase);
		if (held === void 0) changes.push({
			kind: "phase added",
			phase
		});
		const lower = lowerPhase(phase, counts, held ?? /* @__PURE__ */ new Map());
		phases.set(phase, lower.next);
		if (held !== void 0) changes.push(...lower.changes);
	}
	const seal = sealOf(phases);
	const fresh = freshRaises(entry) ?? /* @__PURE__ */ new Set();
	for (const [phase, count, ceiling] of slots(phases)) if (isRaised(ceiling) && fresh.has(slotKey(phase, count))) changes.push({
		kind: "raise kept",
		phase,
		count,
		ceiling
	});
	return {
		entry: {
			browser,
			phases,
			seal
		},
		changes
	};
}
function raiseOf(phase, count, measured, ceiling, where) {
	const raise = isRaised(ceiling) ? `{ "ceiling": ${measured}, "was": ${ceiling.ceiling}, "reason": "<why the page does more>" } once the command has kept the raise it holds, or set this raise's "ceiling" to ${measured} before then` : `{ "ceiling": ${measured}, "was": ${ceiling}, "reason": "<why the page does more>" }`;
	return `«${phase}» ${count}: measured ${measured}, ceiling ${ceilingOf(ceiling)}. The page does more of this work than its ceiling allows: find the change that added it. If the extra work is meant, raise the ceiling by hand in ${where.ceilings} to ${raise}, then run ${command(where)} so the command keeps it.`;
}
/** What a person reads about one change. */
function described(change, where) {
	const run = `run ${command(where)} and commit ${where.ceilings}`;
	let said;
	switch (change.kind) {
		case "new":
			said = `no ceilings for this test in ${where.ceilings}: ${run}.`;
			break;
		case "browser":
			said = `the ceilings were measured on ${change.from}, and this run is ${change.to}: ${run}.`;
			break;
		case "phase added":
			said = `«${change.phase}» has no ceilings: ${run}.`;
			break;
		case "phase dropped":
			said = `«${change.phase}» has ceilings, and this test no longer marks a phase of that name: ${run} to drop them.`;
			break;
		case "count added":
			said = `«${change.phase}» ${change.count}: measured ${change.measured}, and there is no ceiling for it: ${run}.`;
			break;
		case "count dropped":
			said = `«${change.phase}» ${change.count}: the ceiling is ${ceilingOf(change.ceiling)}, and no React renderer ran in this phase, so there is no count to hold to it: ${run} to drop it.`;
			break;
		case "lowered":
			said = `«${change.phase}» ${change.count}: measured ${change.measured}, ceiling ${ceilingOf(change.ceiling)}. The page does less than its ceiling, so the ceiling comes down to match: ${run}.`;
			break;
		case "above":
			said = raiseOf(change.phase, change.count, change.measured, change.ceiling, where);
			break;
		case "raise kept": said = `«${change.phase}» ${change.count} was raised by hand to ${change.ceiling.ceiling}, and the command has not kept the raise yet: ${run}, which seals it, so a later raise is a new edit of its own.`;
	}
	return said;
}
//#endregion
//#region count-budget.ts
const STILL = 2;
const ROUNDS = 100;
/** A round whose idle callback waited this long found the page busy, and counts as one in which the page moved. */
const BUSY_MS = 100;
const PAGE_STATE = "__countBudget";
const REPORTER = "__countBudgetReport";
/**
* What Playwright says when the document an `evaluate` ran in was replaced
* before it answered.
*/
const REPLACED = "Execution context was destroyed";
/**
* Installed in every document of the test's page before any of its scripts.
*
* React calls `onCommitFiberRoot` on the DevTools global hook once per commit,
* production builds included, provided the hook exists before React loads and
* answers `supportsFiber`; the no-op methods are the rest of what React calls on
* it. React skips a hook whose `isDisabled` is true, so turning it off, or
* putting another object in its place, is recorded and refused rather than
* read as a page with no React.
*
* A document also reports itself after every task that changed it, because the
* one it replaces is gone before the test can ask: a binding called from
* `pagehide` arrives after Playwright has dropped the document it came from.
*/
const INSTRUMENT = `(() => {
  if (window.top !== window) return;
  const state = { document: Math.random().toString(36).slice(2), react: false, hookOff: false, reactCommits: 0, mutationRecords: 0 };
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; window.${REPORTER}(read()); });
  };
  const observer = new MutationObserver((records) => { state.mutationRecords += records.length; changed(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const read = () => {
    state.mutationRecords += observer.takeRecords().length;
    return { ...state };
  };
  Object.defineProperty(window, "${PAGE_STATE}", { value: read });
  const renderers = new Map();
  const off = () => { state.hookOff = true; changed(); };
  const hook = {
    renderers,
    supportsFiber: true,
    get isDisabled() { return state.hookOff; },
    set isDisabled(value) { if (value) off(); },
    inject(renderer) {
      state.react = true;
      renderers.set(renderers.size + 1, renderer);
      changed();
      return renderers.size;
    },
    onCommitFiberRoot() { state.reactCommits += 1; changed(); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { get: () => hook, set: off });
})();`;
const ROUND = `new Promise((done) => requestIdleCallback((idle) => requestAnimationFrame(() => done({ busy: idle.didTimeout, state: window.${PAGE_STATE} ? window.${PAGE_STATE}() : null })), { timeout: ${BUSY_MS} }))`;
function whole(found) {
	return typeof found === "number" && Number.isInteger(found) && found >= 0;
}
/** What the instrument says about a document; anything else is refused loudly. */
function documentState(value) {
	if (!isJson(value)) throw new Error(`the page reported ${JSON.stringify(value)} as its counts`);
	const { document, react, hookOff, reactCommits, mutationRecords } = value;
	if (typeof document !== "string" || typeof react !== "boolean" || typeof hookOff !== "boolean" || !whole(reactCommits) || !whole(mutationRecords)) throw new Error(`the page reported ${JSON.stringify(value)} as its counts`);
	return {
		document,
		react,
		hookOff,
		reactCommits,
		mutationRecords
	};
}
/** What moved from one snapshot to the next, in words; empty when nothing did. */
function moved(from, to) {
	const changed = COUNTS.filter((count) => from.totals[count] !== to.totals[count]).map((count) => `${count} ${from.totals[count]} → ${to.totals[count]}`);
	if (from.current?.document !== to.current?.document) changed.push("the document was replaced");
	return changed.join(", ");
}
/**
* Whether a URL is one the test answers: its own origins, or none at all —
* a `blob:` URL is the page's own and raises request events like any other.
*/
function servedBy(origins, url) {
	const { protocol, origin } = new URL(url);
	if (protocol !== "http:" && protocol !== "https:") return true;
	return origins.has(origin);
}
/** A socket's origin as an HTTP origin, which is how the test names what it serves. */
function socketOrigin(url) {
	const { protocol, host } = new URL(url);
	return `${protocol === "wss:" ? "https:" : "http:"}//${host}`;
}
/** The origins the test serves, each normalised, and a written one that is not a URL refused. */
function originsOf(servedOrigins, baseURL) {
	return new Set([...servedOrigins, ...baseURL === void 0 ? [] : [baseURL]].map((written) => {
		let origin;
		try {
			({origin} = new URL(written));
		} catch (cause) {
			throw new Error(`count budget: ${JSON.stringify(written)} in \`servedOrigins\` is not a URL; write the origin the test serves, such as "http://127.0.0.1:8787"`, { cause });
		}
		if (origin === "null") throw new Error(`count budget: ${JSON.stringify(written)} in \`servedOrigins\` has no origin; write an http(s) origin, such as "http://127.0.0.1:8787"`);
		return origin;
	}));
}
var Meter = class Meter {
	#page;
	#origins;
	#documents = /* @__PURE__ */ new Map();
	#network = {
		requests: 0,
		bodyBytes: 0,
		scriptBytes: 0
	};
	#pending = /* @__PURE__ */ new Map();
	#epoch = 0;
	#lastDocument;
	#unserved = [];
	#failures = [];
	constructor(page, origins) {
		this.#page = page;
		this.#origins = origins;
	}
	static async watching(page, origins) {
		const meter = new Meter(page, origins);
		await page.exposeBinding(REPORTER, ({ frame }, state) => {
			if (frame !== page.mainFrame()) return;
			meter.#reported(documentState(state));
		});
		await page.addInitScript(INSTRUMENT);
		await page.emulateMedia({ reducedMotion: "reduce" });
		page.on("request", (request) => {
			if (request.isNavigationRequest() && request.frame() === page.mainFrame()) meter.#epoch += 1;
			meter.#network.requests += 1;
			meter.#pending.set(request, {
				label: `${request.method()} ${request.url()}`,
				epoch: meter.#epoch
			});
		});
		page.on("requestfinished", (request) => void meter.#finished(request));
		page.on("requestfailed", (request) => {
			meter.#failed(request);
			meter.#pending.delete(request);
		});
		page.on("websocket", (socket) => {
			if (!origins.has(socketOrigin(socket.url()))) meter.#unserved.push(`${socket.url()} (WebSocket)`);
		});
		meter.#watchServiceWorkers(page.context());
		return meter;
	}
	/** A service worker's own fetches are reported on the context, never on the page. */
	#watchServiceWorkers(context) {
		context.on("requestfinished", (request) => {
			if (request.serviceWorker() === null) return;
			this.#reachedOut(request).catch((error) => {
				this.#failures.push(`${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		context.on("requestfailed", (request) => {
			if (request.serviceWorker() !== null) this.#failed(request);
		});
	}
	/** A document's counts only grow, so whichever of two reports is behind is the earlier one. */
	#reported(state) {
		const held = this.#documents.get(state.document);
		this.#documents.set(state.document, {
			document: state.document,
			react: state.react || held?.react === true,
			hookOff: state.hookOff || held?.hookOff === true,
			reactCommits: Math.max(state.reactCommits, held?.reactCommits ?? 0),
			mutationRecords: Math.max(state.mutationRecords, held?.mutationRecords ?? 0)
		});
	}
	#failed(request) {
		if (!servedBy(this.#origins, request.url())) this.#unserved.push(`${request.url()} (failed: ${request.failure()?.errorText})`);
	}
	/**
	* Playwright gives a response a server address only when it came from a
	* server: one a route fulfilled has none, which is what tells a stub from a
	* request that reached the origin.
	*/
	async #reachedOut(request) {
		const response = await request.response();
		if (servedBy(this.#origins, request.url()) || response === null) return;
		if (await response.serverAddr() !== null) this.#unserved.push(request.url());
	}
	/**
	* Decoded body bytes, from the body itself. Chromium's encoded size counts a
	* chunked response's framing, which follows how the server split its writes,
	* and misreports a body a route fulfilled (9 bytes for 13).
	*/
	async #finished(request) {
		try {
			const response = await request.response();
			if (response === null) throw new Error("a finished request has no response");
			const bytes = response.status() >= 300 && response.status() < 400 ? 0 : (await response.body()).byteLength;
			this.#network.bodyBytes += bytes;
			if (request.resourceType() === "script") this.#network.scriptBytes += bytes;
			await this.#reachedOut(request);
		} catch (error) {
			this.#failures.push(`${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#pending.delete(request);
		}
	}
	#snapshot(read) {
		if (read !== null) this.#reported(read);
		const totals = {
			...this.#network,
			reactCommits: 0,
			mutationRecords: 0
		};
		let reactDocuments = 0;
		for (const state of this.#documents.values()) {
			totals.reactCommits += state.reactCommits;
			totals.mutationRecords += state.mutationRecords;
			if (state.react) reactDocuments += 1;
		}
		return {
			current: read === null ? null : this.#documents.get(read.document) ?? null,
			reactDocuments,
			totals
		};
	}
	async #round() {
		let answer = void 0;
		try {
			answer = await this.#page.evaluate(ROUND);
		} catch (error) {
			if (error instanceof Error && error.message.includes(REPLACED)) return { kind: "replaced" };
			throw error;
		}
		if (!isJson(answer)) throw new Error(`an idle round answered ${JSON.stringify(answer)}`);
		if (answer["busy"] === true) return { kind: "busy" };
		const state = answer["state"] === null ? null : documentState(answer["state"]);
		return {
			kind: "read",
			snapshot: this.#snapshot(state)
		};
	}
	/**
	* Once a navigation has replaced the document, a request the old one sent
	* that is still pending is a keepalive fetch or a beacon: no document is left
	* for its answer to change, and Playwright reports no end for it.
	*/
	#orphan(current) {
		if (current === this.#lastDocument) return;
		this.#lastDocument = current;
		for (const [request, { epoch }] of this.#pending) if (epoch < this.#epoch) this.#pending.delete(request);
	}
	/** Throws the refusal a precondition owes, if one does not hold. */
	refusals() {
		if (this.#unserved.length > 0) throw new Error([
			`count budget refused: the page reached an origin the test neither serves nor stubs:`,
			...[...new Set(this.#unserved)].map((url) => `  ${url}`),
			`A response from somewhere the test does not control lands when it lands, and where two land close together React may commit once or twice, so the counts stop being repeatable. Answer each with page.route(…, (route) => route.fulfill(…)), or page.routeWebSocket for a socket, with a captured payload; or, if the test itself serves that origin, name it in \`servedOrigins\`. Aborting the request is not a stub: it changes what the page does.`
		].join("\n"));
		if (this.#failures.length > 0) throw new Error([`count budget could not read a response's body:`, ...this.#failures.map((failure) => `  ${failure}`)].join("\n"));
		if ([...this.#documents.values()].some((state) => state.hookOff)) throw new Error(`count budget refused: the page turned React's DevTools hook off (it set \`__REACT_DEVTOOLS_GLOBAL_HOOK__.isDisabled\`, or replaced the hook), and React does not report a single commit to a hook that is off, so the page would read as one with no React. Leave the hook alone in the build the test serves.`);
	}
	async still() {
		let last;
		let quiet = 0;
		const seen = [];
		for (let round = 0; round < ROUNDS; round++) {
			const answer = await this.#round();
			this.refusals();
			if (answer.kind !== "read") {
				quiet = 0;
				seen.push(answer.kind === "busy" ? `the page was busy for a whole round (${BUSY_MS}ms)` : "the document was replaced mid-round");
				continue;
			}
			const now = answer.snapshot;
			this.#orphan(now.current?.document);
			const change = last === void 0 ? void 0 : moved(last, now);
			if (change !== void 0) seen.push(change === "" ? "nothing moved" : change);
			quiet = change === "" && this.#pending.size === 0 ? quiet + 1 : 0;
			if (quiet === STILL) return now;
			last = now;
		}
		const inFlight = [...this.#pending.values()].map(({ label }) => label);
		throw new Error([
			`count budget refused: the page did not go still in ${ROUNDS} idle rounds, so any count read from it would depend on when it was read.`,
			`What moved in the last rounds: ${seen.slice(-3).join("; ")}.`,
			...inFlight.length > 0 ? [`Still in flight: ${inFlight.join(", ")}.`] : [],
			`An animation driven from script that ignores prefers-reduced-motion (the fixture emulates "reduce"), a timer that keeps mutating the DOM, or a request that never finishes keeps a page moving; stop it under reduced motion, or stub what never finishes.`
		].join("\n"));
	}
};
function phaseCounts(start, end) {
	const react = start.current?.react === true || end.current?.react === true || end.reactDocuments > start.reactDocuments;
	const counts = {};
	for (const count of COUNTS) {
		if (count === "reactCommits" && !react) continue;
		counts[count] = end.totals[count] - start.totals[count];
	}
	return counts;
}
/** Where a spec's ceilings live: beside it, named after it. */
function ceilingsFor(spec) {
	return join(dirname(spec), `${basename(spec, extname(spec))}.counts.json`);
}
function keyOf(testInfo) {
	const titles = testInfo.titlePath.slice(1).join(" › ");
	return testInfo.project.name === "" ? titles : `[${testInfo.project.name}] › ${titles}`;
}
async function ceilingsAt(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	const parsed = JSON.parse(text);
	if (!isJson(parsed)) throw new Error(`${path} is not a JSON object`);
	return parsed;
}
function handEdited(where) {
	return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were edited by hand, because their seal no longer matches the ceilings the command accepted. The command lowers a ceiling; a person raises one only as { "ceiling": <new>, "was": <the ceiling the command accepted>, "reason": "<why the page does more>" }, and then runs ${command(where)} to seal it. Put the numbers back as git has them and make the change in that form.`;
}
function otherBrowser(measuredOn, running, where) {
	return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were measured on ${measuredOn}, and this run is ${running}. A count is only comparable on the browser build it was measured on. Re-measure with ${command(where)}, which records this browser and lowers what dropped; a count that rose keeps its ceiling and fails until it is raised by hand with a reason.`;
}
const LOCK_PATIENCE_MS = 1e4;
const LOCK_POLL_MS = 25;
/** When a process started, in clock ticks since boot, where `/proc` says; a reused pid starts later. */
async function startOf(pid) {
	try {
		return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[19] ?? null;
	} catch {
		return null;
	}
}
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
/** Whether the process a lock names is gone, so a run killed while writing costs the next one nothing. */
async function abandoned(lock) {
	let holder;
	try {
		holder = JSON.parse(await readFile(lock, "utf8"));
	} catch {
		return true;
	}
	if (!isJson(holder) || typeof holder["pid"] !== "number") return true;
	if (!alive(holder["pid"])) return true;
	return holder["start"] !== await startOf(holder["pid"]);
}
/**
* Runs `write` holding the file's lock, so workers running tests of one spec in
* parallel each lower their own entry rather than the last writer's view of the
* file winning. The holder is written whole and then linked into place, so a
* lock is never seen half written; one whose holder is gone is taken over, with
* the half-written file it may have left beside it.
*/
async function locked(path, write) {
	const lock = `${path}.lock`;
	const staged = `${path}.writing`;
	const mine = `${lock}.${process.pid}`;
	await writeFile(mine, JSON.stringify({
		pid: process.pid,
		start: await startOf(process.pid)
	}));
	try {
		for (let waited = 0;; waited += LOCK_POLL_MS) {
			try {
				await link(mine, lock);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			if (await abandoned(lock)) {
				await rm(staged, { force: true });
				await rm(lock, { force: true });
				continue;
			}
			if (waited >= LOCK_PATIENCE_MS) throw new Error(`count budget could not write ${path}: another worker has held ${lock} for ${LOCK_PATIENCE_MS / 1e3}s and is still running. If no run is writing ceilings, remove the file.`);
			await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
		}
	} finally {
		await rm(mine, { force: true });
	}
	try {
		return await write(staged);
	} finally {
		await rm(lock, { force: true });
	}
}
function writing() {
	const asked = (process.env["COUNT_BUDGET"] ?? "").trim();
	if (asked === "") return false;
	if (asked !== "write") throw new Error(`${MODE} is ${JSON.stringify(asked)}, and the one value it takes is "write", which writes and lowers each test's ceilings instead of checking them; unset it, or leave it blank, to check`);
	if ((process.env["CI"] ?? "") !== "") throw new Error(`${MODE}=write is refused under CI: the command lowers a file a person commits, a CI workspace throws it away, and a write skips the two checks CI is there for, a count below its ceiling and a file measured on another browser build. Run it on your own machine and commit the file.`);
	return true;
}
const WRITING = writing();
/** What the test's run owes, decided once it has finished: problems to fail it with, if any. */
async function verdict(measured, running, path, where) {
	const shown = `${where.ceilings} › ${JSON.stringify(where.key)}`;
	if (WRITING) return await locked(path, async (staged) => {
		const file = await ceilingsAt(path);
		const entry = entryIn(file, where.key, shown);
		if (entry !== void 0 && isBroken(entry)) return [handEdited(where)];
		const next = lowered(entry, measured, running);
		await writeFile(staged, `${JSON.stringify(withEntry(file, where.key, next.entry), null, 2)}\n`);
		await rename(staged, path);
		return next.changes.filter((change) => change.kind === "above").map((change) => described(change, where));
	});
	const entry = entryIn(await ceilingsAt(path), where.key, shown);
	if (entry !== void 0 && isBroken(entry)) return [handEdited(where)];
	if (entry !== void 0 && entry.browser !== running) return [otherBrowser(entry.browser, running, where)];
	return lowered(entry, measured, running).changes.map((change) => described(change, where));
}
/**
* The invariant sweep's `test` with a `budget` fixture beside it. A test that
* asks for `budget` marks its phases, and its counts are held to the ceilings
* committed beside the spec. Annotated for the reason the sweep's own `test` is.
* Each budgeted test carries its counts as the `count-budget` attachment, a JSON
* object of `Counts` by phase.
*
* ```ts
* import { test } from "@gokayo43/dev-config/count-budget";
* ```
*/
const test = test$1.extend({
	servedOrigins: [[], { option: true }],
	budget: async ({ page, browser, browserName, baseURL, servedOrigins }, provide, testInfo) => {
		if (testInfo.retry > 0) throw new Error(`count budget refused «${keyOf(testInfo)}» on retry ${testInfo.retry}: counts are compared once, exactly, and a retry would pass a count that differs from one run to the next, which is the thing a budget exists to catch. Turn retries off for this spec with test.describe.configure({ retries: 0 }).`);
		const meter = await Meter.watching(page, originsOf(servedOrigins, baseURL));
		const measured = /* @__PURE__ */ new Map();
		const marked = /* @__PURE__ */ new Set();
		const unfinished = [];
		await provide({ phase: async (name, action) => {
			if (marked.has(name)) {
				const twice = `count budget: this test already marked a phase named «${name}»; phase names are a test's keys into its ceilings, so each is used once`;
				unfinished.push(twice);
				throw new Error(twice);
			}
			marked.add(name);
			try {
				const start = await meter.still();
				const answer = await action();
				measured.set(name, phaseCounts(start, await meter.still()));
				return answer;
			} catch (error) {
				unfinished.push(`«${name}» did not finish: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		} });
		if (testInfo.status !== "passed") return;
		if (unfinished.length > 0) throw new Error([`count budget: «${keyOf(testInfo)}» went on after a phase failed, so its counts describe a job that did not happen:`, ...unfinished.map((each) => `  ${each}`)].join("\n"));
		if (measured.size === 0) throw new Error(`count budget: «${keyOf(testInfo)}» asked for \`budget\` and marked no phase; wrap the load and each interaction in budget.phase(name, action)`);
		meter.refusals();
		await testInfo.attach("count-budget", {
			body: JSON.stringify(Object.fromEntries(measured)),
			contentType: "application/json"
		});
		const where = {
			key: keyOf(testInfo),
			spec: relative(process.cwd(), testInfo.file),
			ceilings: relative(process.cwd(), ceilingsFor(testInfo.file))
		};
		const problems = await verdict(measured, `${browserName} ${browser.version()}`, ceilingsFor(testInfo.file), where);
		if (problems.length > 0) throw new Error([`count budget for «${where.key}» (${where.ceilings}), measured ${JSON.stringify(Object.fromEntries(measured))}:`, ...problems.map((problem) => `  ${problem}`)].join("\n"));
	}
});
//#endregion
export { test };
