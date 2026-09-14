import { expect, test as test$1 } from "@playwright/test";
//#region invariant-sweep.ts
/**
* The E2E invariant sweep testing.md asks of every visited page, as a Playwright
* fixture a repo imports instead of `@playwright/test`'s own `test`:
*
*   no page logged a `console.error`, no page threw, and no page scrolled
*   sideways.
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
* at some moment. Two designs that do not work:
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
* ## What the page is allowed to say about itself
*
* A page is not a trusted narrator. The bridge takes **one string** from it and
* nothing else: the `kind` is always `overflow`, and the URL is the one
* Playwright says that frame is at. Reports from anything but the top frame are
* dropped, so a cross-origin iframe cannot invent a violation for the page
* carrying it, and the string itself is stripped of control characters — which
* is what stops an embed writing ANSI escapes or a `::error::` workflow command
* into somebody's CI annotation.
*
* The same reasoning decides which URL a console error is attributed to. The
* console reports the script's URL, and a script's URL is whatever its
* `//# sourceURL=` comment claims — so an inline script of ours can wear a
* vendor's name and land in the vendor's allowlist bucket. A claimed URL is
* therefore honoured only when a document or script **actually loaded** from it
* in this page, which is a fact about responses the browser received and not
* one any page can write.
*/
/** The name the page-side script calls, and the name the fixture exposes. One constant, two ends. */
const REPORTER = "__invariantSweep";
/** The name the page-side drain answers to, and the name the fixture calls. One constant, two ends. */
const DRAINER = "__invariantSweepDrain";
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
/**
* Asking the document to drain, as an expression rather than a function for the
* same reason `WATCH` is one: there is no DOM lib here to type it with.
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
*/
const WATCH = `(() => {
  if (window.top !== window) return;
  const seen = new Set();
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
    if (seen.has(detail)) return;
    seen.add(detail);
    window.${REPORTER}(detail);
  };
  const started = Date.now();
  let armed = 0;
  let changed = 0;
  let queued = false;
  const soon = () => {
    changed = Date.now();
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
  Promise.all([fonts, loaded]).then(() => { armed = Date.now(); soon(); });
  const until = () => armed === 0
    ? started + ${CAP}
    : Math.min(Math.max(changed, armed) + ${QUIET}, armed + ${QUIET * 2});
  window.${DRAINER} = () => new Promise((done) => {
    const wait = () => {
      const left = until() - Date.now();
      // Capped, so that a document arming mid-wait is noticed rather than slept
      // through: once armed, the deadline is never further off than this.
      if (left > 0) return void setTimeout(wait, Math.min(left, ${QUIET}));
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
function describe({ kind, at, detail }) {
	return `${kind} at ${at} — ${detail}`;
}
/**
* Gives one document its last chance to report before it is replaced or the test
* ends, and never costs the assertion.
*
* A document can be behind in two ways, and one ask covers both. It may not have
* *measured* yet: a page that lays its overflow out on a timer after `load` has
* nothing to say when `goto` resolves, and a spec that navigates on that instant
* destroys the document before the layout it would have failed on. And it may
* have measured without the report having *crossed*: a report leaves on the
* frame after the check runs, so two frames follow the wait. `WATCH` above owns
* what each of those costs and answers when both are spent.
*
* A page that navigates, or that closes itself, while this runs has nothing left
* to drain — whatever it measured crossed as it was measured — and every way
* that surfaces is admitted here. Letting one through would replace the sweep's
* verdict, the list it spent the whole test collecting, with a message about the
* flush.
*/
async function drain(page) {
	if (page.isClosed()) return;
	try {
		await page.evaluate(DRAIN);
	} catch (error) {
		if (page.isClosed()) return;
		if (!(error instanceof Error) || !GONE.some((gone) => error.message.includes(gone))) throw error;
	}
}
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
	context: async ({ context, sweepAllowlist }, provide) => {
		const allowed = Object.keys(sweepAllowlist).map((pattern) => {
			try {
				return new RegExp(pattern);
			} catch (cause) {
				throw new Error(`sweepAllowlist key ${JSON.stringify(pattern)} is not a regular expression — the keys are patterns tested against the URL a violation came from, so a literal URL works as one and an unbalanced \`(\` does not`, { cause });
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
		const watch = (page) => {
			const draining = (replace) => async (...args) => {
				await drain(page);
				return await replace(...args);
			};
			page.goto = draining(page.goto.bind(page));
			page.reload = draining(page.reload.bind(page));
			page.goBack = draining(page.goBack.bind(page));
			page.goForward = draining(page.goForward.bind(page));
			page.setContent = draining(page.setContent.bind(page));
			page.on("response", (response) => {
				if (ADDRESSABLE.has(response.request().resourceType())) fetched.add(response.url());
			});
			page.on("console", (message) => {
				if (message.type() !== "error") return;
				record({
					kind: "console.error",
					at: from(message.location().url, page),
					detail: sanitized(message.text())
				});
			});
			page.on("pageerror", (error) => {
				record({
					kind: "pageerror",
					at: from(scriptIn(error.stack), page),
					detail: sanitized(error.message)
				});
			});
		};
		await context.exposeBinding(REPORTER, ({ frame, page }, detail) => {
			if (frame !== page.mainFrame()) return;
			record({
				kind: "overflow",
				at: frame.url(),
				detail: sanitized(detail)
			});
		});
		await context.addInitScript(WATCH);
		context.on("page", watch);
		for (const open of context.pages()) watch(open);
		await provide(context);
		await Promise.all(context.pages().map(async (page) => await drain(page)));
		expect(violations.map(describe), "pages visited by this test broke an invariant every page holds; fix it, or name the URL in `sweepAllowlist` with the reason it is tolerated").toEqual([]);
	}
});
//#endregion
export { test };
