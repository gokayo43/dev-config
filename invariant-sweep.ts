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
 * The console and the page's own errors arrive as events, so those are the
 * easy half. Overflow is a measurement, and a measurement has to happen
 * somewhere, at some moment. Two designs that do not work:
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
 * ## The allowlist
 *
 * `sweepAllowlist` maps a URL pattern to the reason that URL is tolerated —
 * a third-party embed logging into our console is the case it exists for, and
 * naming a whole page is the blunter version of the same thing. It is a
 * Playwright option, so a repo can set it once in `playwright.config.ts`,
 * narrow it per file with `test.use`, and see it in the trace.
 *
 * A stale entry is not failed here, deliberately: the allowlist is consulted per
 * run, and a run that did not visit the embedded page did not use its entry —
 * which is normal rather than rot. The ratchet that drains itself is the one
 * whose whole population is in front of it at once, which is what
 * `response-schema.ts` has and this does not.
 */
import { expect, test as base } from "@playwright/test";

/** The name the page-side script calls, and the name the fixture exposes. One constant, two ends. */
const REPORTER = "__invariantSweep";

/** How far past the viewport an element has to reach before it counts, in CSS pixels. */
const SLACK = 1;

/** How many offending elements a diagnostic names before it stops. */
const NAMED = 3;

/** One invariant, broken once. */
interface Violation {
  readonly kind: "console.error" | "pageerror" | "overflow";
  /**
   * Where it came *from*: the script's URL for a console error, the page's for
   * everything else. The source rather than the page, because the case the
   * allowlist exists for is a third-party embed on a page of ours.
   */
  readonly at: string;
  readonly detail: string;
}

/**
 * The measuring, as source rather than as a function, for two reasons that both
 * matter: `addInitScript` serialises a function anyway, and this file is
 * compiled with no DOM lib — a repo's Playwright config is not this package's
 * `tsconfig`, and typing the browser here to write eight lines of it would put
 * `lib: ["DOM"]` into everything that imports the fixture.
 *
 * Three moments, deduplicated: when the document loads, when its fonts settle
 * (a webfont swapping in is a reflow, and a reflow is where overflow appears),
 * and on the next frame after anything in the tree changes — which is what
 * covers a client-rendered route change that fires no `load` at all. The top
 * frame only: an iframe scrolling sideways inside its own box is the embed's
 * business, and `documentElement` there is not the page.
 */
const WATCH = `(() => {
  if (window.top !== window) return;
  const seen = new Set();
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const names = typeof el.className === "string" ? el.className.trim() : "";
    const cls = names ? "." + names.split(/\\s+/).slice(0, ${NAMED}).join(".") : "";
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
    const named = (innermost.length ? innermost : past).slice(0, ${NAMED}).map(describe).join(", ");
    const detail = root.scrollWidth + "px of content in a " + limit + "px viewport"
      + (named ? ", reaching past the right edge: " + named : "");
    if (seen.has(detail)) return;
    seen.add(detail);
    window.${REPORTER}({ kind: "overflow", at: location.href, detail: detail });
  };
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; check(); });
  };
  if (document.fonts) document.fonts.ready.then(soon);
  if (document.readyState === "complete") soon();
  else window.addEventListener("load", soon);
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
 * Two frames, as an expression rather than a function for the same reason
 * `WATCH` is one: there is no DOM lib here to type `requestAnimationFrame` with.
 */
const FLUSH = "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))";

/** The option a repo sets, declared so `test.use({ sweepAllowlist })` type-checks. */
export interface InvariantSweep {
  /**
   * URLs whose console errors, page errors and overflow this run tolerates,
   * each against the reason it is tolerated. The key is a **regular
   * expression** tested against the URL — a literal URL works as one, and
   * `.*` is there when a pattern is wanted — and the value is why, which is
   * the half a reviewer reads.
   */
  sweepAllowlist: Record<string, string>;
}

function describe({ kind, at, detail }: Violation): string {
  return `${kind} at ${at} — ${detail}`;
}

/**
 * `@playwright/test`'s `test`, with `page` replaced by one that is watched. A
 * repo swaps its import and every spec it already has is swept:
 *
 * ```ts
 * import { test } from "@gokayo43/dev-config/invariant-sweep.ts";
 * import { expect } from "@playwright/test";
 * ```
 */
export const test = base.extend<InvariantSweep>({
  sweepAllowlist: [{}, { option: true }],

  // `provide` rather than Playwright's own `use`: a parameter named `use` reads
  // as a React hook to the linter, and the name is ours to choose.
  page: async ({ page, sweepAllowlist }, provide) => {
    const allowed = Object.keys(sweepAllowlist).map((pattern) => new RegExp(pattern));
    const violations: Violation[] = [];
    const record = (violation: Violation): void => {
      if (allowed.some((pattern) => pattern.test(violation.at))) return;
      violations.push(violation);
    };

    // Exposed before the init script is added, because the script the next
    // navigation runs calls it in its first frame.
    await page.exposeFunction(REPORTER, record);
    await page.addInitScript(WATCH);

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The script's URL where the browser knows one, so an embed's noise is
      // allowlistable by the embed's own address rather than by ours.
      record({
        kind: "console.error",
        at: message.location().url || page.url(),
        detail: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      record({ kind: "pageerror", at: page.url(), detail: error.message });
    });

    await provide(page);

    // A report crosses from the page on the frame after the check runs, so a
    // spec that ends the instant `goto` resolves would be asserted against an
    // empty list — the sweep's answer would depend on how long the spec
    // happened to take. Two frames: the first lets a pending check run, the
    // second lets a check that frame scheduled land. Nothing is left to drain
    // when the spec closed the page itself, which is a thing specs do.
    if (!page.isClosed()) await page.evaluate(FLUSH);

    expect(
      violations.map(describe),
      "pages visited by this test broke an invariant every page holds; fix it, or name the URL in `sweepAllowlist` with the reason it is tolerated",
    ).toEqual([]);
  },
});
