import { test as test$1 } from "./invariant-sweep.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
//#region count-budget.ts
const COUNTS = [
	"reactCommits",
	"mutationRecords",
	"requests",
	"bodyBytes",
	"scriptBytes"
];
const MODE = "COUNT_BUDGET";
const COMMAND = (spec) => `${MODE}=write bunx playwright test ${spec}`;
const STILL = 2;
const ROUNDS = 100;
/** A round whose idle callback waited this long found the page busy, and counts as one in which the page moved. */
const BUSY_MS = 100;
const PAGE_STATE = "__countBudget";
const REPORTER = "__countBudgetReport";
/**
* Installed in every document of the test's page before any of its scripts.
*
* React calls `onCommitFiberRoot` on the DevTools global hook once per commit,
* production builds included, provided the hook exists before React loads and
* answers `supportsFiber`; the no-op methods are the rest of what React calls on
* it. A document whose React never called `inject` has no renderer, and reports
* no commit count.
*
* A document also reports itself after every task that changed it, because the
* one it replaces is gone before the test can ask: a binding called from
* `pagehide` arrives after Playwright has dropped the document it came from.
*/
const INSTRUMENT = `(() => {
  if (window.top !== window) return;
  const state = { document: Math.random().toString(36).slice(2), react: false, reactCommits: 0, mutationRecords: 0 };
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
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
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
})();`;
const ROUND = `new Promise((done) => requestIdleCallback((idle) => requestAnimationFrame(() => done({ busy: idle.didTimeout, state: window.${PAGE_STATE} ? window.${PAGE_STATE}() : null })), { timeout: ${BUSY_MS} }))`;
function isJson(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The initial `about:blank` a page starts on, which no init script ran in. */
const BLANK = {
	document: "",
	react: false,
	reactCommits: 0,
	mutationRecords: 0
};
function documentState(value) {
	if (!isJson(value)) return BLANK;
	const held = value;
	const number = (key) => {
		const found = held[key];
		if (typeof found !== "number" || !Number.isInteger(found) || found < 0) throw new Error(`the page reported ${key} as ${JSON.stringify(found)}`);
		return found;
	};
	return {
		document: String(held["document"]),
		react: held["react"] === true,
		reactCommits: number("reactCommits"),
		mutationRecords: number("mutationRecords")
	};
}
function sameSnapshot(a, b) {
	return a.current.document === b.current.document && COUNTS.every((count) => a.totals[count] === b.totals[count]);
}
function moved(from, to) {
	const changed = COUNTS.filter((count) => from.totals[count] !== to.totals[count]).map((count) => `${count} ${from.totals[count]} → ${to.totals[count]}`);
	if (from.current.document !== to.current.document) changed.push("the document was replaced");
	return changed.join(", ");
}
function servedBy(origins, url) {
	const { protocol, origin } = new URL(url);
	if (protocol !== "http:" && protocol !== "https:") return true;
	return origins.has(origin);
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
			meter.#network.requests += 1;
			meter.#pending.set(request, `${request.method()} ${request.url()}`);
		});
		page.on("requestfinished", (request) => void meter.#finished(request));
		page.on("requestfailed", (request) => {
			if (!servedBy(origins, request.url())) meter.#unserved.push(`${request.url()} (failed: ${request.failure()?.errorText})`);
			meter.#pending.delete(request);
		});
		return meter;
	}
	/** A document's counts only grow, so whichever of two reports is behind is the earlier one. */
	#reported(state) {
		const held = this.#documents.get(state.document);
		this.#documents.set(state.document, {
			document: state.document,
			react: state.react || held?.react === true,
			reactCommits: Math.max(state.reactCommits, held?.reactCommits ?? 0),
			mutationRecords: Math.max(state.mutationRecords, held?.mutationRecords ?? 0)
		});
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
			if (!servedBy(this.#origins, request.url()) && await response.serverAddr() !== null) this.#unserved.push(request.url());
		} catch (error) {
			this.#failures.push(`${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#pending.delete(request);
		}
	}
	#snapshot(read) {
		if (read !== BLANK) this.#reported(read);
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
			current: this.#documents.get(read.document) ?? BLANK,
			reactDocuments,
			totals
		};
	}
	/** `undefined` when the page was busy for the whole round or replaced its document mid-round. */
	async #round() {
		let answer = void 0;
		try {
			answer = await this.#page.evaluate(ROUND);
		} catch (error) {
			if (error instanceof Error && error.message.includes("Execution context was destroyed")) return void 0;
			throw error;
		}
		if (!isJson(answer)) throw new Error(`an idle round answered ${JSON.stringify(answer)}`);
		return answer["busy"] === true ? void 0 : this.#snapshot(documentState(answer["state"]));
	}
	#refusals() {
		if (this.#unserved.length > 0) throw new Error([
			`count budget refused: the page reached an origin the test neither serves nor stubs:`,
			...[...new Set(this.#unserved)].map((url) => `  ${url}`),
			`A response from somewhere the test does not control lands when it lands, and where two land close together React may commit once or twice, so the counts stop being repeatable. Answer each with page.route(…, (route) => route.fulfill(…)) and a captured payload, or, if the test itself serves that origin, name it in \`servedOrigins\`. Aborting the request is not a stub: it changes what the page does.`
		].join("\n"));
		if (this.#failures.length > 0) throw new Error([`count budget could not read a response's body:`, ...this.#failures.map((failure) => `  ${failure}`)].join("\n"));
	}
	async still() {
		let last;
		let quiet = 0;
		const seen = [];
		for (let round = 0; round < ROUNDS; round++) {
			const now = await this.#round();
			this.#refusals();
			if (now === void 0) {
				quiet = 0;
				seen.push("the page was busy for a whole round, or replaced its document");
				continue;
			}
			if (last !== void 0) seen.push(moved(last, now) || "nothing moved");
			quiet = last !== void 0 && this.#pending.size === 0 && sameSnapshot(last, now) ? quiet + 1 : 0;
			if (quiet === STILL) return now;
			last = now;
		}
		const inFlight = [...this.#pending.values()];
		throw new Error([
			`count budget refused: the page did not go still in ${ROUNDS} idle rounds, so any count read from it would depend on when it was read.`,
			`What moved in the last rounds: ${seen.slice(-3).join("; ")}.`,
			...inFlight.length > 0 ? [`Still in flight: ${inFlight.join(", ")}.`] : [],
			`An animation driven from script that ignores prefers-reduced-motion (the fixture emulates "reduce"), a timer that keeps mutating the DOM, or a request that never finishes keeps a page moving; stop it under reduced motion, or stub what never finishes.`
		].join("\n"));
	}
};
function phaseCounts(start, end) {
	const react = start.current.react || end.current.react || end.reactDocuments > start.reactDocuments;
	const counts = {};
	for (const count of COUNTS) {
		if (count === "reactCommits" && !react) continue;
		counts[count] = end.totals[count] - start.totals[count];
	}
	return counts;
}
function isRaised(ceiling) {
	return typeof ceiling === "object";
}
function ceilingOf(ceiling) {
	return isRaised(ceiling) ? ceiling.ceiling : ceiling;
}
/** What the command last wrote for a count, which is what the seal covers. */
function writtenOf(ceiling) {
	return isRaised(ceiling) ? ceiling.was : ceiling;
}
function sealOf(phases) {
	const each = Object.entries(phases).flatMap(([phase, counts]) => Object.entries(counts).map(([count, ceiling]) => `${phase}\u0000${count}\u0000${writtenOf(ceiling)}`)).toSorted();
	return createHash("sha256").update(each.join("\n")).digest("hex").slice(0, 16);
}
function isCount(name) {
	return COUNTS.some((count) => count === name);
}
function isWhole(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function asRecord(value, where) {
	if (!isJson(value)) throw new Error(`${where} is not a JSON object`);
	return value;
}
function ceilingAt(value, where) {
	if (isWhole(value)) return value;
	if (typeof value === "number") throw new Error(`${where} is ${value}, and a ceiling is a whole number of zero or more`);
	const { ceiling, was, reason } = asRecord(value, where);
	if (!isWhole(ceiling) || !isWhole(was)) throw new Error(`${where} is neither a whole number nor a raised ceiling written as { "ceiling": <new>, "was": <the number the command wrote>, "reason": "<why>" }`);
	if (typeof reason !== "string" || reason.trim() === "") throw new Error(`${where} is raised from ${was} to ${ceiling} with no reason: say why the page does more in its "reason"`);
	if (ceiling <= was) throw new Error(`${where} is written as raised, but its ceiling ${ceiling} is not above the ${was} the command wrote; a lower ceiling is the command's to write`);
	return {
		ceiling,
		was,
		reason
	};
}
function entryAt(value, where) {
	const held = asRecord(value, where);
	if (typeof held["browser"] !== "string") throw new Error(`${where}.browser is not a string`);
	if (typeof held["seal"] !== "string") throw new Error(`${where}.seal is not a string`);
	const phases = {};
	for (const [phase, counts] of Object.entries(asRecord(held["phases"], `${where}.phases`))) {
		const ceilings = {};
		for (const [count, ceiling] of Object.entries(asRecord(counts, `${where}.phases.${phase}`))) {
			if (!isCount(count)) throw new Error(`${where}.phases.${phase}.${count} is not a count; the counts are ${COUNTS.join(", ")}`);
			ceilings[count] = ceilingAt(ceiling, `${where}.phases.${phase}.${count}`);
		}
		phases[phase] = ceilings;
	}
	return {
		browser: held["browser"],
		phases,
		seal: held["seal"]
	};
}
/**
* Every test's entry in a ceilings file, unread: a test holds only its own entry
* to the shape, so one entry written wrong fails one test rather than the file.
*/
async function ceilingsAt(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return asRecord(JSON.parse(text), path);
}
async function entryFor(path, where) {
	const held = (await ceilingsAt(path))[where.key];
	return held === void 0 ? void 0 : entryAt(held, `${where.ceilings} › ${JSON.stringify(where.key)}`);
}
function ceilingsFor(spec) {
	return join(dirname(spec), `${basename(spec, extname(spec))}.counts.json`);
}
function keyOf(testInfo) {
	const titles = testInfo.titlePath.slice(1).join(" › ");
	return testInfo.project.name === "" ? titles : `[${testInfo.project.name}] › ${titles}`;
}
function refusedForHandEdit(entry, where) {
	if (sealOf(entry.phases) === entry.seal) return void 0;
	return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were edited by hand, because their seal no longer matches the numbers the command wrote. The command lowers a ceiling; a person raises one only as { "ceiling": <new>, "was": <the number the command wrote>, "reason": "<why the page does more>" }. Put the numbers back as git has them and make the change in that form.`;
}
function refusedForBrowser(entry, browser, where) {
	if (entry.browser === browser) return void 0;
	return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were measured on ${entry.browser}, and this run is ${browser}. A count is only comparable on the browser build it was measured on. Re-measure with ${COMMAND(where.spec)}, which records this browser and lowers what dropped; a count that rose keeps its ceiling and fails until it is raised by hand with a reason.`;
}
function exceeded(phase, count, measured, ceiling, where) {
	const raise = isRaised(ceiling) ? `set its "ceiling" to ${measured} and say why in its "reason"` : `replace ${ceiling} with { "ceiling": ${measured}, "was": ${ceiling}, "reason": "<why the page does more>" }`;
	return `«${phase}» ${count}: measured ${measured}, ceiling ${ceilingOf(ceiling)}. The page does more of this work than its ceiling allows: find the change that added it. If the extra work is meant, raise the ceiling by hand in ${where.ceilings}: ${raise}.`;
}
function checked(phase, count, value, ceiling, where) {
	const lower = `run ${COMMAND(where.spec)} and commit ${where.ceilings}`;
	if (ceiling === void 0) return value === void 0 ? void 0 : `«${phase}» ${count}: measured ${value}, and there is no ceiling for it: ${lower}.`;
	if (value === void 0) return `«${phase}» ${count}: the ceiling is ${ceilingOf(ceiling)}, and no React renderer ran in this phase, so there is no count to hold to it: ${lower} to drop it.`;
	if (value > ceilingOf(ceiling)) return exceeded(phase, count, value, ceiling, where);
	if (value < ceilingOf(ceiling)) return `«${phase}» ${count}: measured ${value}, ceiling ${ceilingOf(ceiling)}. The page does less than its ceiling, so the ceiling comes down to match: ${lower}.`;
}
function compared(entry, measured, where) {
	const lower = `run ${COMMAND(where.spec)} and commit ${where.ceilings}`;
	if (entry === void 0) return [`no ceilings for this test in ${where.ceilings}: ${lower}.`];
	const stale = Object.keys(entry.phases).filter((phase) => !(phase in measured)).map((phase) => `«${phase}» has ceilings, and this test no longer marks a phase of that name: ${lower} to drop them.`);
	const measuredProblems = Object.entries(measured).flatMap(([phase, counts]) => {
		const held = entry.phases[phase];
		if (held === void 0) return [`«${phase}» has no ceilings: ${lower}.`];
		return COUNTS.map((count) => checked(phase, count, counts[count], held[count], where)).filter((problem) => problem !== void 0);
	});
	return [...stale, ...measuredProblems];
}
/**
* The command: every ceiling becomes the lower of itself and what was measured.
* A count with no ceiling yet is written as measured; one the test no longer
* produces is dropped; none is ever raised, so a count above its ceiling keeps
* the ceiling and fails.
*/
function lowered(entry, measured, browser, where) {
	const phases = {};
	const problems = [];
	for (const [phase, counts] of Object.entries(measured)) {
		const next = {};
		for (const count of COUNTS) {
			const value = counts[count];
			if (value === void 0) continue;
			const ceiling = entry?.phases[phase]?.[count];
			if (ceiling === void 0 || value < ceilingOf(ceiling)) {
				next[count] = value;
				continue;
			}
			next[count] = ceiling;
			if (value > ceilingOf(ceiling)) problems.push(exceeded(phase, count, value, ceiling, where));
		}
		phases[phase] = next;
	}
	return {
		entry: {
			browser,
			phases,
			seal: sealOf(phases)
		},
		problems
	};
}
const LOCK_PATIENCE_MS = 3e4;
const LOCK_POLL_MS = 25;
/**
* Runs `write` while holding the file's lock, so workers running tests of one
* spec in parallel each lower their own entry rather than the last writer's
* view of the file winning.
*/
async function locked(path, write) {
	const lock = `${path}.lock`;
	for (let waited = 0;; waited += LOCK_POLL_MS) try {
		await mkdir(lock);
		break;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		if (waited >= LOCK_PATIENCE_MS) throw new Error(`count budget could not write ${path}: ${lock} has been held for ${LOCK_PATIENCE_MS / 1e3}s. If no run is writing ceilings, a run that died left it; remove the directory.`, { cause: error });
		await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
	}
	try {
		return await write();
	} finally {
		await rmdir(lock);
	}
}
async function stored(path, key, entry) {
	const ceilings = await ceilingsAt(path);
	ceilings[key] = entry;
	const sorted = Object.fromEntries(Object.entries(ceilings).toSorted(([a], [b]) => a.localeCompare(b)));
	const staged = `${path}.${process.pid}`;
	await writeFile(staged, `${JSON.stringify(sorted, null, 2)}\n`);
	await rename(staged, path);
}
function writing() {
	const asked = (process.env[MODE] ?? "").trim();
	if (asked === "") return false;
	if (asked === "write") return true;
	throw new Error(`${MODE} is ${JSON.stringify(asked)}, and the one value it takes is "write", which writes and lowers each test's ceilings instead of checking them; unset it, or leave it blank, to check`);
}
const WRITING = writing();
/**
* The invariant sweep's `test` with a `budget` fixture beside it. A test that
* asks for `budget` marks its phases, and its counts are held to the ceilings
* committed beside the spec. Annotated for the reason the sweep's own `test` is.
*
* ```ts
* import { test } from "@gokayo43/dev-config/count-budget";
* ```
*/
const test = test$1.extend({
	servedOrigins: [[], { option: true }],
	budget: async ({ page, browser, browserName, baseURL, servedOrigins }, provide, testInfo) => {
		if (testInfo.retry > 0) throw new Error(`count budget refused «${keyOf(testInfo)}» on retry ${testInfo.retry}: counts are compared once, exactly, and a retry would pass a count that differs from one run to the next, which is the thing a budget exists to catch. Turn retries off for this spec with test.describe.configure({ retries: 0 }).`);
		const origins = /* @__PURE__ */ new Set([...servedOrigins, ...baseURL === void 0 ? [] : [new URL(baseURL).origin]]);
		const meter = await Meter.watching(page, origins);
		const measured = {};
		await provide({ phase: async (name, action) => {
			if (name in measured) throw new Error(`count budget: this test already marked a phase named «${name}»; phase names are a test's keys into its ceilings, so each is used once`);
			const start = await meter.still();
			const answer = await action();
			measured[name] = phaseCounts(start, await meter.still());
			return answer;
		} });
		if (testInfo.errors.length > 0) return;
		if (Object.keys(measured).length === 0) throw new Error(`count budget: «${keyOf(testInfo)}» asked for \`budget\` and marked no phase; wrap the load and each interaction in budget.phase(name, action)`);
		await testInfo.attach("count-budget", {
			body: JSON.stringify(measured),
			contentType: "application/json"
		});
		const where = {
			key: keyOf(testInfo),
			spec: relative(process.cwd(), testInfo.file),
			ceilings: relative(process.cwd(), ceilingsFor(testInfo.file))
		};
		const running = `${browserName} ${browser.version()}`;
		const path = ceilingsFor(testInfo.file);
		const problems = WRITING ? await locked(path, async () => {
			const entry = await entryFor(path, where);
			const refused = entry === void 0 ? void 0 : refusedForHandEdit(entry, where);
			if (refused !== void 0) return [refused];
			const next = lowered(entry, measured, running, where);
			await stored(path, where.key, next.entry);
			return next.problems;
		}) : await (async () => {
			const entry = await entryFor(path, where);
			if (entry === void 0) return compared(entry, measured, where);
			const refused = refusedForHandEdit(entry, where) ?? refusedForBrowser(entry, running, where);
			return refused === void 0 ? compared(entry, measured, where) : [refused];
		})();
		if (problems.length > 0) throw new Error([`count budget for «${where.key}» (${where.ceilings}), measured ${JSON.stringify(measured)}:`, ...problems.map((problem) => `  ${problem}`)].join("\n"));
	}
});
//#endregion
export { test };
