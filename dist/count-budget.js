import { test as test$1 } from "./invariant-sweep.js";
import { link, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
//#region count-ceilings.ts
const COUNTS = [
	"reactCommits",
	"mutationRecords",
	"requests",
	"bodyBytes",
	"scriptBytes"
];
/** The four counts every phase has, each made by `make`. */
function always(make) {
	return {
		mutationRecords: make("mutationRecords"),
		requests: make("requests"),
		bodyBytes: make("bodyBytes"),
		scriptBytes: make("scriptBytes")
	};
}
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
/** A ceilings file's text, read as the object it has to be. */
function fileIn(text, path) {
	return asJson(JSON.parse(text), path);
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
/** A phase's ceilings that are there, in the order `COUNTS` lists them. */
function present(ceilings) {
	return COUNTS.flatMap((count) => {
		const ceiling = ceilings[count];
		return ceiling === void 0 ? [] : [[count, ceiling]];
	});
}
/** Every count of an entry, in the one order its seal lists them. */
function slots(phases) {
	return [...phases].flatMap(([phase, ceilings]) => present(ceilings).map(([count, ceiling]) => [
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
/** One phase's ceilings, read from a file a person may have edited. */
function phaseAt(value, where) {
	const written = asJson(value, where);
	for (const count of Object.keys(written)) if (!isCount(count)) throw new Error(`${where}.${count} is not a count; the counts are ${COUNTS.join(", ")}`);
	const ceilings = always((count) => {
		if (!Object.hasOwn(written, count)) throw new Error(`${where} has no ${count}, which every phase measures`);
		return ceilingAt(written[count], `${where}.${count}`);
	});
	return Object.hasOwn(written, "reactCommits") ? {
		...ceilings,
		reactCommits: ceilingAt(written["reactCommits"], `${where}.reactCommits`)
	} : ceilings;
}
/** One test's entry, read from a file a person may have edited. */
function entryAt(value, where) {
	const written = asJson(value, where);
	const { browser, seal } = written;
	if (typeof browser !== "string") throw new Error(`${where}.browser is not a string`);
	if (typeof seal !== "string") throw new Error(`${where}.seal is not a string`);
	const phases = /* @__PURE__ */ new Map();
	for (const [phase, ceilings] of Object.entries(asJson(written["phases"], `${where}.phases`))) phases.set(phase, phaseAt(ceilings, `${where}.phases.${phase}`));
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
		phases: Object.fromEntries([...entry.phases].map(([phase, ceilings]) => [phase, Object.fromEntries(present(ceilings))])),
		seal: entry.seal
	};
}
/** A whole file with one test's entry set, its tests in code-point order. */
function withEntry(file, key, entry) {
	const others = Object.entries(file).filter(([held]) => held !== key);
	return Object.fromEntries([...others, [key, entryJson(entry)]].toSorted(([a], [b]) => byCodePoint(a, b)));
}
/** A test's entry as the file holds it, judged against its seal; nothing when the file has none. */
function entryIn(file, key, where) {
	if (!Object.hasOwn(file, key)) return void 0;
	const entry = entryAt(file[key], where);
	const raises = freshRaises(entry);
	return raises === void 0 ? { kind: "hand edited" } : {
		kind: "sealed",
		entry,
		raises
	};
}
/** A measured count against its ceiling: the lower of the two, and a change wherever they differ. */
function against(phase, count, measured, ceiling, changes) {
	if (measured < ceilingOf(ceiling)) {
		changes.push({
			kind: "lowered",
			phase,
			count,
			measured,
			ceiling
		});
		return measured;
	}
	if (measured > ceilingOf(ceiling)) changes.push({
		kind: "above",
		phase,
		count,
		measured,
		ceiling
	});
	return ceiling;
}
function lowerPhase(phase, counts, stored) {
	const changes = [];
	const measured = counts.reactCommits;
	const ceiling = stored.reactCommits;
	let reactCommits = void 0;
	if (measured === void 0) {
		if (ceiling !== void 0) changes.push({
			kind: "count dropped",
			phase,
			count: "reactCommits",
			ceiling
		});
	} else if (ceiling === void 0) {
		reactCommits = measured;
		changes.push({
			kind: "count added",
			phase,
			count: "reactCommits",
			measured
		});
	} else reactCommits = against(phase, "reactCommits", measured, ceiling, changes);
	const next = always((count) => against(phase, count, counts[count], stored[count], changes));
	return {
		next: reactCommits === void 0 ? next : {
			...next,
			reactCommits
		},
		changes
	};
}
/**
* The one rule: what the command writes for a test, and every way that differs
* from what is stored. Every ceiling becomes the lower of itself and the
* measure; a count with no ceiling is written as measured; one no longer
* measured is dropped; none is raised, so a count above its ceiling keeps the
* ceiling. A check fails exactly when this lists a change.
*/
function lowered(stored, measured, browser) {
	const phases = new Map(measured);
	if (stored === void 0) return {
		entry: {
			browser,
			phases,
			seal: sealOf(phases)
		},
		changes: [{ kind: "new" }]
	};
	const { entry, raises } = stored;
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
		if (held === void 0) {
			changes.push({
				kind: "phase added",
				phase
			});
			continue;
		}
		const lower = lowerPhase(phase, counts, held);
		phases.set(phase, lower.next);
		changes.push(...lower.changes);
	}
	for (const [phase, count, ceiling] of slots(phases)) if (isRaised(ceiling) && raises.has(slotKey(phase, count))) changes.push({
		kind: "raise kept",
		phase,
		count,
		ceiling
	});
	return {
		entry: {
			browser,
			phases,
			seal: sealOf(phases)
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
			said = `the ceilings were measured on ${change.from}, and this run is ${change.to}. A count is only comparable on the browser build it was measured on. The command records this browser and lowers what dropped, and a count that rose keeps its ceiling and fails until it is raised by hand with a reason: ${run}.`;
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
//#region file-lock.ts
/**
* Which process a file names, and the lock built on that answer: one holder at
* a time for a path, across processes on one Linux machine.
*
* The lock is a file linked into place. A holder is written whole to a file of
* the waiter's own and then linked at the lock's path, so the lock is never seen
* half written: `open` with O_EXCL would make the file exist before its
* contents do, and a waiter reading it in that gap finds nobody, judges the lock
* abandoned and takes it, which is no lock at all, measured.
*
* A lock whose holder is gone is taken over, so a process killed while holding
* it costs the next one nothing; `takeOver` says how two waiters that judged
* the same holder gone are kept from both taking it.
*/
/** A pid this package may signal: a real process, never `0` (its own group) or `1` (everything). */
function isPid(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 1;
}
/** A tick count `/proc` could have reported. */
function isTick(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** The three fields that say which process, in a record or in a lock. */
function isHolder(value) {
	return typeof value === "object" && value !== null && "pid" in value && isPid(value.pid) && "bootId" in value && typeof value.bootId === "string" && value.bootId !== "" && "startTicks" in value && isTick(value.startTicks);
}
/** This machine's boot. Every pid a holder names belongs to exactly one of these. */
async function bootId() {
	return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}
/**
* What `/proc` says about a running process, or nothing when it is not there.
*
* Read from after the LAST `)`, because field 2 is the executable name, is not
* escaped, and may contain both spaces and parentheses. What is wanted after
* that is field 5, the process group, and field 22, the tick this process
* started on.
*/
async function procStat(pid) {
	let raw;
	try {
		raw = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return null;
		throw error;
	}
	const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
	const group = Number(fields[2]);
	const startTicks = Number(fields[19]);
	if (!Number.isInteger(group) || !Number.isInteger(startTicks)) throw new Error(`/proc/${pid}/stat is not the shape this reads — fields 5 and 22 are not numbers`);
	return {
		startTicks,
		leadsItsGroup: group === pid
	};
}
/**
* Whether a holder is still the process that wrote it down, or nothing.
*
* Answers with what `/proc` said rather than a boolean, because the one caller
* that goes on to signal has a second question to ask of it and no reason to
* read the same file twice.
*/
async function ours(who, boot) {
	if (who.bootId !== boot) return null;
	const stat = await procStat(who.pid);
	return stat !== null && stat.startTicks === who.startTicks ? stat : null;
}
const POLL_MS = 25;
/** How a claim's file name ends, which is how the sweep tells one from the files it may remove. */
const CLAIM = ".claim";
async function paced(next) {
	if (next === "wait") await setTimeout(POLL_MS);
}
function hasCode(error, code) {
	return error instanceof Error && "code" in error && error.code === code;
}
/** A file's text, or nothing when it is not there. */
async function textAt(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return void 0;
		throw error;
	}
}
async function liveHolder(text, boot) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	return isHolder(parsed) && await ours(parsed, boot) !== null ? parsed : void 0;
}
/** A name beside `path` that no other waiter, in this process or another, will pick. */
function own(path) {
	return `${path}.${process.pid}-${randomBytes(4).toString("hex")}`;
}
/** Whether `from` was linked at `to`; `false` when `to` already exists. */
async function linked(from, to) {
	try {
		await link(from, to);
		return true;
	} catch (error) {
		if (hasCode(error, "EEXIST")) return false;
		throw error;
	}
}
/** Whether `from` was renamed to `to`; `false` when `from` is gone. */
async function renamed(from, to) {
	try {
		await rename(from, to);
		return true;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false;
		throw error;
	}
}
/**
* Moves aside the lock at `path` if it still holds `dead`, the text of a holder
* judged gone. Only one waiter at a time does this for a given dead holder: the
* one holding the claim named after its text, a lock taken the same way. So
* the lock cannot have been taken over and taken again by somebody alive
* between the recheck and the move, and a waiter whose judgement is stale finds
* that at the recheck and moves nothing.
*/
async function takeOver(path, dead, patienceMs, between, me) {
	await using held = await acquire(`${path}.${createHash("sha256").update(dead).digest("hex").slice(0, 16)}${CLAIM}`, patienceMs, between, me);
	await between("recheck", path);
	if (await textAt(path) !== dead) return;
	const aside = `${own(path)}.moved`;
	await between("move", path);
	if (!await renamed(path, aside)) return;
	await between("confirm", path);
	const moved = await textAt(aside);
	if (moved === void 0 || moved === dead) {
		await rm(aside, { force: true });
		return;
	}
	try {
		if (!await linked(aside, path)) throw new Error(`${path} was replaced by hand while a dead holder's lock was being taken over, and a second process took it before the first could be put back, so two processes may each believe they hold it. Stop the runs that use it and remove ${path}.`);
	} finally {
		await rm(aside, { force: true });
	}
}
async function acquire(path, patienceMs, between, me) {
	const mine = own(path);
	await writeFile(mine, me.text, {
		flag: "wx",
		mode: 384
	});
	try {
		for (let waited = 0;;) {
			await between("link", path);
			if (await linked(mine, path)) return { async [Symbol.asyncDispose]() {
				await between("release", path);
				await rm(path, { force: true });
			} };
			await between("read", path);
			const found = await textAt(path);
			if (found === void 0) continue;
			const holder = await liveHolder(found, me.boot);
			if (holder === void 0) {
				await between("take", path);
				await takeOver(path, found, patienceMs, between, me);
				continue;
			}
			if (waited >= patienceMs) throw new Error(`${path} has been held for ${patienceMs}ms by process ${holder.pid}, which is still running: wait for it, or remove ${path} if that process is not using it.`);
			await between("wait", path);
			waited += POLL_MS;
		}
	} finally {
		await rm(mine, { force: true });
	}
}
/**
* Clears every file beside the lock that names a process that is gone: the file
* a waiter killed while waiting wrote its holder to, and a dead holder's lock
* moved aside by a waiter killed before discarding it, are removed, since only
* the process that wrote either ever touches it. A claim its taker died holding
* is taken over through `takeOver` like any dead lock and never removed by
* name, because another waiter may be taking it over at the same moment.
*/
async function sweep(path, patienceMs, between, me) {
	const prefix = `${basename(path)}.`;
	const beside = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix));
	for (const name of beside) {
		const file = join(dirname(path), name);
		const text = await textAt(file);
		if (text === void 0) continue;
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		if (!isHolder(parsed) || await ours(parsed, me.boot) !== null) continue;
		if (name.endsWith(CLAIM)) await takeOver(file, text, patienceMs, between, me);
		else await rm(file, { force: true });
	}
}
/**
* Takes the lock at `path`, waiting up to `patienceMs` for a live holder, and
* releases it when disposed. Linux only: a holder is proven alive from `/proc`.
*
* `between` defaults to sleeping before each look at a live holder's lock; a
* test passes its own to decide when each step runs.
*/
async function lock(path, patienceMs, between = paced) {
	const stat = await procStat(process.pid);
	if (stat === null) throw new Error(`/proc/${process.pid} is not readable — this needs Linux`);
	const boot = await bootId();
	const me = {
		text: `${JSON.stringify({
			pid: process.pid,
			bootId: boot,
			startTicks: stat.startTicks
		})}\n`,
		boot
	};
	const held = await acquire(path, patienceMs, between, me);
	try {
		await sweep(path, patienceMs, between, me);
	} catch (error) {
		await held[Symbol.asyncDispose]();
		throw error;
	}
	return held;
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
* it. React skips a hook whose `isDisabled` is true or that lacks
* `supportsFiber`, so any write to the hook, or another object put in its
* place, is recorded and refused rather than read as a page with no React.
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
  const hook = new Proxy({
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
  }, {
    set() { off(); return true; },
    defineProperty() { off(); return true; },
    deleteProperty() { off(); return true; },
  });
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { get: () => hook, set: off });
})();`;
const ROUND = `new Promise((done) => requestIdleCallback((idle) => requestAnimationFrame(() => done({ busy: idle.didTimeout, state: window.${PAGE_STATE} ? window.${PAGE_STATE}() : null })), { timeout: ${BUSY_MS} }))`;
/** What the instrument says about a document; anything else is refused loudly. */
function documentState(value) {
	if (typeof value === "object" && value !== null && "document" in value && typeof value.document === "string" && "react" in value && typeof value.react === "boolean" && "hookOff" in value && typeof value.hookOff === "boolean" && "reactCommits" in value && isWhole(value.reactCommits) && "mutationRecords" in value && isWhole(value.mutationRecords)) {
		const { document, react, hookOff, reactCommits, mutationRecords } = value;
		return {
			document,
			react,
			hookOff,
			reactCommits,
			mutationRecords
		};
	}
	throw new Error(`the page reported ${JSON.stringify(value)} as its counts`);
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
/**
* Whether a request comes from the page's main frame. That frame is attached to
* the page from the start, and `frame()` throws only for the navigation of a
* frame not attached yet, which is therefore never it.
*/
function fromMainFrame(page, request) {
	try {
		return request.frame() === page.mainFrame();
	} catch {
		return false;
	}
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
	#unanswered = [];
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
			if (request.isNavigationRequest() && fromMainFrame(page, request)) meter.#epoch += 1;
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
		context.on("request", (request) => {
			if (request.serviceWorker() === null) return;
			this.#pending.set(request, { label: `${request.method()} ${request.url()} (service worker)` });
		});
		context.on("requestfinished", (request) => {
			if (request.serviceWorker() === null) return;
			this.#reachedOut(request).catch((error) => {
				this.#failures.push(`${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
			}).finally(() => this.#pending.delete(request));
		});
		context.on("requestfailed", (request) => {
			if (request.serviceWorker() === null) return;
			this.#failed(request);
			this.#pending.delete(request);
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
		if (!servedBy(this.#origins, request.url())) this.#unanswered.push(`${request.url()} (${request.failure()?.errorText})`);
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
			const status = response.status();
			const bytes = status >= 300 && status < 400 || status === 204 || status === 205 || request.method() === "HEAD" ? 0 : (await response.body()).byteLength;
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
		if (typeof answer !== "object" || answer === null || !("busy" in answer) || !("state" in answer)) throw new Error(`an idle round answered ${JSON.stringify(answer)}`);
		if (answer.busy === true) return { kind: "busy" };
		const state = answer.state === null ? null : documentState(answer.state);
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
		for (const [request, { epoch }] of this.#pending) if (epoch !== void 0 && epoch < this.#epoch) this.#pending.delete(request);
	}
	/** Throws the refusal a precondition owes, if one does not hold. */
	refusals() {
		if (this.#unserved.length > 0) throw new Error([
			`count budget refused: the page reached an origin the test neither serves nor stubs:`,
			...[...new Set(this.#unserved)].map((url) => `  ${url}`),
			`A response from somewhere the test does not control lands when it lands, and where two land close together React may commit once or twice, so the counts stop being repeatable. Answer each with page.route(…, (route) => route.fulfill(…)), or page.routeWebSocket for a socket, with a captured payload; or, if the test itself serves that origin, name it in \`servedOrigins\`. Aborting the request is not a stub: it changes what the page does.`
		].join("\n"));
		if (this.#unanswered.length > 0) throw new Error([
			`count budget refused: a request to an origin the test does not serve ended before any answer reached the page:`,
			...[...new Set(this.#unanswered)].map((url) => `  ${url}`),
			`The page aborted it, a route aborted it, or the connection failed, and each of those changes what the page does next. Answer it with page.route(…, (route) => route.fulfill(…)) and a captured payload, soon enough that the answer arrives before the page gives up on it; or change the page so it does not issue the request.`
		].join("\n"));
		if (this.#failures.length > 0) throw new Error([`count budget could not read a response's body:`, ...this.#failures.map((failure) => `  ${failure}`)].join("\n"));
		if ([...this.#documents.values()].some((state) => state.hookOff)) throw new Error(`count budget refused: the page turned React's DevTools hook off: it wrote to \`__REACT_DEVTOOLS_GLOBAL_HOOK__\`, by setting \`isDisabled\`, overwriting its properties as a "disable React DevTools" snippet does, or putting another object in its place. React reports no commit to a hook it cannot use, so the page would read as one with no React. Leave the hook alone in the build the test serves.`);
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
/** What the page did between two snapshots, by the rule `Counts` states for `reactCommits`. */
function phaseCounts(start, end) {
	const counts = always((count) => end.totals[count] - start.totals[count]);
	return start.current?.react === true || end.current?.react === true || end.reactDocuments > start.reactDocuments ? {
		...counts,
		reactCommits: end.totals.reactCommits - start.totals.reactCommits
	} : counts;
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
	return fileIn(text, path);
}
function handEdited(where) {
	return `count budget refused «${where.key}»: its ceilings in ${where.ceilings} were edited by hand, because their seal no longer matches the ceilings the command accepted. The command lowers a ceiling; a person raises one only as { "ceiling": <new>, "was": <the ceiling the command accepted>, "reason": "<why the page does more>" }, and then runs ${command(where)} to seal it. Put the numbers back as git has them and make the change in that form.`;
}
const LOCK_PATIENCE_MS = 1e4;
/**
* Writes the file whole, then moves it into place. Only the lock's holder
* writes, so another process's staging file beside it was left by a writer
* killed mid-write.
*/
async function rewrite(path, file) {
	const prefix = `${basename(path)}.`;
	const left = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix) && name.endsWith(".writing"));
	await Promise.all(left.map(async (name) => await rm(join(dirname(path), name), { force: true })));
	const staged = `${path}.${process.pid}.writing`;
	await writeFile(staged, `${JSON.stringify(file, null, 2)}\n`);
	await rename(staged, path);
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
	await using held = WRITING ? await lock(`${path}.lock`, LOCK_PATIENCE_MS) : null;
	const file = await ceilingsAt(path);
	const stored = entryIn(file, where.key, `${where.ceilings} › ${JSON.stringify(where.key)}`);
	if (stored?.kind === "hand edited") return [handEdited(where)];
	const { entry, changes } = lowered(stored, measured, running);
	if (!WRITING) {
		const browser = changes.filter((change) => change.kind === "browser");
		return (browser.length > 0 ? browser : changes).map((change) => described(change, where));
	}
	await rewrite(path, withEntry(file, where.key, entry));
	return changes.filter((change) => change.kind === "above").map((change) => described(change, where));
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
