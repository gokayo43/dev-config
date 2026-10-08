import { expect, test as test$1 } from "@playwright/test";
//#region invariant-sweep.ts
/**
* The E2E invariant sweep testing.md asks of every visited page, as a Playwright
* fixture a repo imports instead of `@playwright/test`'s own `test`:
*
*   no page logged a `console.error`, no page threw, no page scrolled
*   sideways, and nothing on a page moved that the user did not move.
*
* They are invariants rather than assertions because no single test owns them.
* A flow test knows what it came to click; nobody's job is to notice that the
* checkout page has been logging a failed request for three weeks, or that a
* card runs eight pixels past the right edge on a phone. Written as assertions
* they would have to be repeated in every spec and would be missing from the
* one that mattered — so they are a property of *visiting a page at all*, and
* the only thing a repo does to get them is change one import.
*
* ## Where the checking happens, and why it is not in the test process
*
* The console and the page's own errors arrive as events, so those are the easy
* half. Overflow is a measurement, and a measurement has to happen somewhere,
* at some moment; a layout shift is an entry the browser hands only to an
* observer that was in the page when it happened. Two designs that do not work:
*
* - **After each `goto`.** A test that navigates by clicking a link never calls
*   `goto`, and those pages would go unswept while the fixture claimed to sweep
*   every one.
* - **On the runner's `load` event.** The check is an `evaluate`, so it races
*   the test: a spec that navigates again immediately destroys the execution
*   context mid-measurement, and the honest handling of that rejection is to
*   swallow it — which turns "every page" into "every page the spec was slow
*   enough to let us look at", silently.
*
* So the measuring runs **in the page**, installed by an init script that runs
* in every document before anything else, and reports back through an exposed
* binding. There is no context to lose and no navigation to race, and an SPA
* route change that never fires `load` is caught by the same observer as
* everything else.
*
* ## The fixture is the context, not the page
*
* Everything is installed on the browser **context**, so a page the spec never
* held a reference to — a `target="_blank"` popup, an OAuth window — is swept
* like any other. A `page` fixture cannot see those at all: they are pages the
* context opened and the spec may never name.
*
* ## What a page can do to the verdict
*
* The export's page, `docs/exports/invariant-sweep.md`, says it under "What a
* page is allowed to say about itself", and that is the one place it is said.
*
* ## Recording
*
* `E2E_VIDEO=on` turns Playwright's own `video` option on for the run, over
* whatever the config says. The export's page, `docs/exports/invariant-sweep.md`,
* has the switch under "Recording a video".
*/
/** The name the page-side script calls, and the name the fixture exposes. One constant, two ends. */
const REPORTER = "__invariantSweep";
/** The name the page-side drain answers to, and the name the fixture calls. One constant, two ends. */
const DRAINER = "__invariantSweepDrain";
/** The name the page-side act mark answers to, and the name the fixture calls. One constant, two ends. */
const ACTOR = "__invariantSweepActing";
/**
* How long after the user acts a layout shift is still theirs, in ms: the
* window the Layout Instability spec sets `hadRecentInput` by, which the
* fixture applies after each action it marks as well.
*/
const RECENT = 500;
/** The calls that replace a page's document, each drained first. */
const REPLACING = [
	"goto",
	"reload",
	"goBack",
	"goForward",
	"setContent"
];
/** The actions Playwright performs with nothing the browser counts as input, each marked as the user acting. */
const UNPROMPTED = [
	"fill",
	"selectOption",
	"setInputFiles"
];
/**
* How long a document has to go unchanged before it has nothing further to
* report, in ms. Playwright calls a page idle after 500ms with no network
* activity, which is the same judgement about the same kind of page; this
* applies it to the DOM.
*/
const QUIET = 500;
/**
* How long a document that never armed — one whose `load` or whose fonts never
* arrive — is waited out, in ms: the 5s Playwright's own `expect` gives a page
* to come good.
*/
const CAP = 5e3;
/** How far past the viewport an element has to reach before it counts, in CSS pixels. */
const SLACK = 1;
/**
* How many class names go into an element's description. Enough to tell two
* siblings apart, and short of pasting a utility-CSS class list into a
* diagnostic.
*/
const CLASSES = 3;
/** How many offending elements a diagnostic names before it stops. */
const OFFENDERS = 3;
/** How much of a page's own sentence reaches the failure message. */
const DETAIL_LIMIT = 300;
/**
* What Playwright says when there is no longer anything to evaluate in: the
* first when the page navigated out from under the call, the second when the
* page — a popup that closed itself, say — or the whole context has gone.
*/
const GONE = ["Execution context was destroyed", "Target page, context or browser has been closed"];
/** The resource kinds whose URLs a violation may be attributed to. */
const ADDRESSABLE = /* @__PURE__ */ new Set(["document", "script"]);
/** The variable that switches recording on. */
const RECORD = "E2E_VIDEO";
/**
* Whether this run records a video of every page in the context, read once
* from the environment. Unset or blank leaves `video` to the config, as a blank
* budget does in `property.ts`; anything but `on` throws, because a misspelt
* switch read as off is a run that was asked for a recording, went green, and
* left nothing to watch.
*/
function recordingAsked() {
	const written = (process.env[RECORD] ?? "").trim();
	if (written === "") return false;
	if (written === "on") return true;
	throw new Error(`${RECORD} is ${JSON.stringify(written)}, and the one value it takes is "on", which records a video of every page in the test's own context; unset it, or leave it blank, to leave \`video\` to the Playwright config`);
}
const RECORDING = recordingAsked();
/** The config's `video`, switched on when the run asked for a recording, and the rest of it kept. */
function recorded(video) {
	if (!RECORDING) return video;
	return typeof video === "string" ? "on" : {
		...video,
		mode: "on"
	};
}
/** The violations the page measures for itself, which are the only kinds it may name over the bridge. */
const MEASURED = ["overflow", "layout-shift"];
function measured(kind) {
	return MEASURED.some((each) => each === kind);
}
/**
* Asking the document to drain, as an expression rather than a function for the
* same reason `watch` writes source: there is no DOM lib here to type it with.
*
* It gives one document its last chance to report before it is replaced or the
* test ends. A document can be behind in two ways, and one ask covers both. It
* may not have *measured* yet: a page that lays its overflow out on a timer
* after `load` has nothing to say when `goto` resolves, and a spec that
* navigates on that instant destroys the document before the layout it would
* have failed on. And it may have measured without the report having
* *crossed*: a report leaves on the frame after the check runs, so two frames
* follow the wait. `watch` owns what each of those costs and answers when both
* are spent.
*/
const DRAIN = `window.${DRAINER}()`;
/**
* The measuring, as source rather than as a function, for two reasons that both
* matter: `addInitScript` serialises a function anyway, and this file is
* compiled with no DOM lib — a repo's Playwright config is not this package's
* `tsconfig`, and typing the browser here to write eight lines of it would put
* `lib: ["DOM"]` into everything that imports the fixture.
*
* Four moments, deduplicated: when the document loads, when its fonts settle (a
* webfont swapping in is a reflow, and a reflow is where overflow appears),
* when any subresource finishes loading (an image's bytes carry its width, and
* nothing in the DOM has to change when they arrive), and on the next frame
* after anything in the tree changes — which is what covers a client-rendered
* route change that fires no `load` at all. The top frame only: an iframe
* scrolling sideways inside its own box is the embed's business, and
* `documentElement` there is not the page.
*
* The same four moments are what draining waits on, and the document owns that
* too: it is asked, and it answers when it has nothing further to report. The
* runner holds no clock and no promise per document, so there is nothing for a
* same-document navigation or a page closing itself to orphan — the state is in
* the document, and it goes when the document does.
*
* Three ways to have nothing further to report, and a document reaches whichever
* comes first. It has **gone quiet**: armed — loaded, with its fonts swapped in,
* the last two reflows anything schedules for it — and `QUIET` since the last of
* the four moments. It has been **changing without pause** since it armed for
* twice that, which is an animation: it is measured on every one of those
* changes, so waiting for a gap that will not come buys nothing. Or it **never
* armed** at all, and `CAP` has passed since the script ran.
*
* Layout shifts are not measured at those moments: the browser hands each one
* to the observer as an entry, from the first frame the document paints, and
* every entry is a violation unless the user caused it. The browser says so by
* marking it `hadRecentInput`; the fixture says so for an `UNPROMPTED` action
* by calling `ACTOR` as the action starts and as it returns. An entry is the
* action's when it starts between the first `input` or `change` event the
* action set off, or its return if it set off none, and `RECENT` after the
* return; what the page moved while the action was still waiting for its
* element is not. Those events count only while an action runs, so a page that
* dispatches one itself excuses nothing. An entry observed while an action runs
* is held until it returns, because its window is not known before then; any
* other is judged as it is observed.
*
* The reporter is read once, here, so a page that later replaces the global
* does not replace where its reports go.
*/
const WATCH = `(() => {
  if (window.top !== window) return;
  const report = window.${REPORTER};
  const seen = new Set();
  const say = (kind, key, detail) => {
    if (seen.has(kind + " " + key)) return;
    seen.add(kind + " " + key);
    report(kind, detail);
  };
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const names = typeof el.className === "string" ? el.className.trim() : "";
    const cls = names ? "." + names.split(/\\s+/).slice(0, ${CLASSES}).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const check = () => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    if (root.scrollWidth <= limit) return;
    const past = Array.from(document.querySelectorAll("*")).filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > limit + ${SLACK};
    });
    const innermost = past.filter((el) => !past.some((other) => other !== el && el.contains(other)));
    const named = (innermost.length ? innermost : past).slice(0, ${OFFENDERS}).map(describe).join(", ");
    const detail = root.scrollWidth + "px of content in a " + limit + "px viewport"
      + (named ? ", reaching past the right edge: " + named : "");
    say("overflow", detail, detail);
  };
  const started = performance.now();
  let armed = 0;
  let changed = 0;
  let queued = false;
  const soon = () => {
    changed = performance.now();
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; check(); });
  };
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  const loaded = document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((done) => window.addEventListener("load", done, { once: true }));
  fonts.then(soon);
  loaded.then(soon);
  Promise.all([fonts, loaded]).then(() => { armed = performance.now(); soon(); });
  const until = () => armed === 0
    ? started + ${CAP}
    : Math.min(Math.max(changed, armed) + ${QUIET}, armed + ${QUIET * 2});
  const named = (source) => {
    const node = source.node && source.node.nodeType !== Node.ELEMENT_NODE
      ? source.node.parentElement
      : source.node;
    return node ? describe(node) : "an element no longer in the page";
  };
  const travel = (source) => {
    const from = source.previousRect;
    const to = source.currentRect;
    if (from.width * from.height === 0) return "into view";
    if (to.width * to.height === 0) return "out of view";
    const dy = Math.round(to.y - from.y);
    const dx = Math.round(to.x - from.x);
    const legs = [];
    if (dy !== 0) legs.push(Math.abs(dy) + "px " + (dy > 0 ? "down" : "up"));
    if (dx !== 0) legs.push(Math.abs(dx) + "px " + (dx > 0 ? "right" : "left"));
    return legs.length ? legs.join(" and ") : "by less than a pixel";
  };
  const marks = [];
  const held = [];
  let acting = 0;
  let touched = Infinity;
  const judge = (entry) => {
    if (marks.some(({ from, to }) => entry.startTime >= from && entry.startTime <= to + ${RECENT})) return;
    const sources = entry.sources.slice(0, ${OFFENDERS});
    const score = "score " + entry.value.toFixed(4);
    const moved = sources.length
      ? sources.map((source) => named(source) + " moved " + travel(source)).join(", ")
      : "something moved";
    say("layout-shift", sources.length ? sources.map(named).join(", ") : score,
      score + ", with no input in the ${RECENT}ms before: " + moved);
  };
  window.${ACTOR} = (edge) => {
    if (edge === "start") return void (acting += 1);
    const now = performance.now();
    marks.push({ from: Math.min(touched, now), to: now });
    // An action that replaced the document ends in a document it never started in.
    acting = Math.max(0, acting - 1);
    if (acting > 0) return;
    touched = Infinity;
    held.splice(0).forEach(judge);
  };
  for (const type of ["input", "change"]) {
    window.addEventListener(type, (event) => {
      if (acting > 0) touched = Math.min(touched, event.timeStamp);
    }, true);
  }
  const shifted = (entries) => {
    for (const entry of entries) {
      if (entry.hadRecentInput) continue;
      if (acting > 0) held.push(entry);
      else judge(entry);
    }
  };
  // Firefox and WebKit have no Layout Instability API, and observing a type a
  // browser lacks logs a warning rather than throwing.
  const shifts = PerformanceObserver.supportedEntryTypes.includes("layout-shift")
    ? new PerformanceObserver((list) => shifted(list.getEntries()))
    : undefined;
  if (shifts) shifts.observe({ type: "layout-shift", buffered: true });
  // An observer is called some time after the frame a shift happened in, and a
  // document on its way out is not called again.
  const flush = () => {
    if (shifts) shifted(shifts.takeRecords());
    held.splice(0).forEach(judge);
  };
  window.addEventListener("pagehide", flush);
  window.${DRAINER} = () => new Promise((done) => {
    const wait = () => {
      const left = until() - performance.now();
      // Capped, so that a document arming mid-wait is noticed rather than slept
      // through: once armed, the deadline is never further off than this.
      if (left > 0) return void setTimeout(wait, Math.min(left, ${QUIET}));
      flush();
      requestAnimationFrame(() => requestAnimationFrame(done));
    };
    wait();
  });
  // Capture phase: a subresource's own load event does not bubble, and an
  // image's bytes are what carry its width.
  document.addEventListener("load", soon, true);
  // \`document\` and not \`documentElement\`: an init script runs before the
  // document has an element, and observing a null target throws — which the
  // page then reports through this very fixture as an error of its own.
  new MutationObserver(soon).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
  });
})();`;
/**
* The characters a terminal reads as instructions rather than as text: C0 and
* the newline among them, DEL, and the C1 range some terminals still take as
* escape sequences.
*/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
* One line, printable, and no longer than a sentence.
*
* A page writes this string and a CI annotation prints it, so every control
* character goes: an ANSI escape would colour somebody's log, and a newline is
* what a `::error::` workflow command needs in order to start a line of its own.
*/
function sanitized(detail) {
	const printable = (typeof detail === "string" ? detail : "").replaceAll(CONTROL, " ").replaceAll(/\s+/g, " ").trim();
	return printable.length > DETAIL_LIMIT ? `${printable.slice(0, DETAIL_LIMIT)}…` : printable;
}
/** The first http(s) URL a stack names, which is the script the error came out of. */
function scriptIn(stack) {
	return /https?:\/\/[^\s)]+?(?=:\d+:\d+|\s|\)|$)/.exec(stack ?? "")?.[0];
}
/** What to do about each kind, said by the sweep rather than by the page, so no cut a page's sentence takes can lose it. */
const ADVICE = {
	"console.error": "fix what it reports, or stop reporting it as an error",
	pageerror: "fix what threw, or catch it where it can be handled",
	overflow: "make what reaches past the edge fit the viewport",
	"layout-shift": "reserve the space for whatever arrives late, or move it with a transform"
};
function describe({ kind, at, detail }) {
	return `${kind} at ${at} — ${detail}; ${ADVICE[kind]}`;
}
/**
* Every page a sweeping context watches with JavaScript on. The wrapped calls
* below are wrapped on Playwright's prototypes, so they run for every page in
* the process, and this is what they ask before touching one.
*/
const WATCHED = /* @__PURE__ */ new WeakSet();
/**
* Runs `expression` in a watched page's current document, if it still has one,
* and never costs the assertion. A page that navigates, or that closes itself,
* while this runs has nothing left to ask, and every way that surfaces is
* admitted here. Letting one through would replace the sweep's verdict, the
* list it spent the whole test collecting, with a message about the ask.
*/
async function ask(page, expression) {
	if (!WATCHED.has(page) || page.isClosed()) return;
	try {
		await page.evaluate(expression);
	} catch (error) {
		if (page.isClosed()) return;
		if (!(error instanceof Error) || !GONE.some((gone) => error.message.includes(gone))) throw error;
	}
}
/** Telling a document an action has started, and that it has returned, which is the mark. */
const ACTION = {
	start: `window.${ACTOR}("start")`,
	end: `window.${ACTOR}("end")`
};
/**
* The prototype `instance` shares with every other of its class. Playwright
* exports its classes as types only, so an instance is the one way to reach
* one.
*/
function prototypeOf(instance) {
	return Object.getPrototypeOf(instance);
}
/**
* `original`, reachable as `name` on an object that inherits everything else
* from `self`. Playwright names a call after the method its innermost frame of
* Playwright's own was reached through, and under its test runner a method
* reached through `apply` or `call` is named `apply` or `call`: a failing
* `page.fill` would read `page.apply`. Reached as `name`, it reads `page.fill`.
* Every wrapped method only reads its receiver, so an object inheriting all of
* `self` stands in for it.
*/
function callable(self, name, original) {
	return Object.create(self, { [name]: { value: original } });
}
/** Wraps each named method of `prototype` in `around`, which decides when the original runs. */
function wrap(prototype, names, around) {
	for (const name of names) {
		const original = prototype[name];
		prototype[name] = async function(...args) {
			return await around(this, async () => await callable(this, name, original)[name](...args));
		};
	}
}
/** Runs an `UNPROMPTED` action, and marks the user as having acted when it returns. */
async function marked(page, call) {
	if (page === void 0) return await call();
	await ask(page, ACTION.start);
	try {
		return await call();
	} finally {
		await ask(page, ACTION.end);
	}
}
/**
* Wraps the calls the sweep needs on the prototypes they live on, once per
* process: on a page, the `REPLACING` calls and the `UNPROMPTED` actions, and
* the `UNPROMPTED` actions on a locator and an element handle. Not on a frame,
* though a page's and a locator's actions run through one: a wrapper there
* would be the innermost frame of every call and rename it `frame.fill`. The
* prototypes are reached through a page of the browser's own made for it,
* since an element handle is only had by asking a page for one.
*/
async function wrapOnce(browser) {
	const scratch = await browser.newPage();
	try {
		const handle = await scratch.locator(":root").elementHandle();
		const pages = prototypeOf(scratch);
		wrap(pages, REPLACING, async (page, call) => {
			await ask(page, DRAIN);
			return await call();
		});
		wrap(pages, UNPROMPTED, async (page, call) => await marked(page, call));
		wrap(prototypeOf(scratch.locator(":root")), UNPROMPTED, async (locator, call) => await marked(locator.page(), call));
		wrap(prototypeOf(handle), UNPROMPTED, async (element, call) => {
			return await marked((await element.ownerFrame())?.page(), call);
		});
	} finally {
		await scratch.close();
	}
}
/** The one `wrapOnce` this process runs, whichever test reaches it first. */
let wrapped;
/**
* Playwright's `test`, with the browser context replaced by one that watches
* every page it opens. A repo swaps its import and every spec it already has is
* swept.
*
* Annotated rather than inferred because the declaration emitter needs a type it
* can name: left to infer, the `.d.ts` reaches through `@playwright/test` and
* names `playwright/test`, a package a consumer never declared.
*
* ```ts
* import { test } from "@gokayo43/dev-config/invariant-sweep";
* import { expect } from "@playwright/test";
* ```
*/
const test = test$1.extend({
	sweepAllowlist: [{}, { option: true }],
	video: [async ({ video }, provide) => await provide(recorded(video)), {
		scope: "worker",
		box: true
	}],
	context: async ({ browser, context, javaScriptEnabled, sweepAllowlist }, provide) => {
		wrapped ??= wrapOnce(browser);
		await wrapped;
		const allowed = Object.keys(sweepAllowlist).map((pattern) => {
			try {
				return new RegExp(pattern);
			} catch (cause) {
				throw new Error(`sweepAllowlist key ${JSON.stringify(pattern)} is not a regular expression — the keys are patterns tested against the URL a violation came from, so a metacharacter such as \`(\`, \`?\` or \`.\` in a URL needs its backslash`, { cause });
			}
		});
		const violations = [];
		/** Every URL the browser actually loaded a document or a script from. */
		const fetched = /* @__PURE__ */ new Set();
		const record = (violation) => {
			if (allowed.some((pattern) => pattern.test(violation.at))) return;
			violations.push(violation);
		};
		/**
		* The URL to attribute this to: what was claimed, but only where the browser
		* reports having loaded it. A `//# sourceURL=` comment is a claim any script
		* can make about itself, and honouring it unchecked lets an inline script of
		* ours land in a vendor's allowlist bucket.
		*/
		const from = (claimed, page) => claimed !== void 0 && fetched.has(claimed) ? claimed : page.url();
		const adopt = (page) => {
			if (javaScriptEnabled) WATCHED.add(page);
		};
		context.on("response", (response) => {
			if (ADDRESSABLE.has(response.request().resourceType())) fetched.add(response.url());
		});
		context.on("console", (message) => {
			const page = message.page();
			if (page === null || message.type() !== "error") return;
			record({
				kind: "console.error",
				at: from(message.location().url, page),
				detail: sanitized(message.text())
			});
		});
		context.on("weberror", (thrown) => {
			const page = thrown.page();
			if (page === null) return;
			const error = thrown.error();
			record({
				kind: "pageerror",
				at: from(scriptIn(error.stack), page),
				detail: sanitized(error.message)
			});
		});
		await context.exposeBinding(REPORTER, ({ frame, page }, kind, detail) => {
			if (frame !== page.mainFrame() || !measured(kind)) return;
			record({
				kind,
				at: frame.url(),
				detail: sanitized(detail)
			});
		});
		await context.addInitScript(WATCH);
		context.on("page", adopt);
		for (const open of context.pages()) adopt(open);
		await provide(context);
		await Promise.all(context.pages().map(async (page) => await ask(page, DRAIN)));
		expect(violations.map(describe), "pages visited by this test broke an invariant every page holds; fix it, or name the URL in `sweepAllowlist` with the reason it is tolerated").toEqual([]);
	}
});
//#endregion
export { test };
