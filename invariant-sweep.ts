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
import { expect, type Page, test as base } from "@playwright/test";

/** The name the page-side script calls, and the name the fixture exposes. One constant, two ends. */
const REPORTER = "__invariantSweep";

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

/** What Playwright says when the page navigated out from under an evaluate. */
const DESTROYED = "Execution context was destroyed";

/** The resource kinds whose URLs a violation may be attributed to. */
const ADDRESSABLE = new Set(["document", "script"]);

/** One invariant, broken once. */
interface Violation {
  readonly kind: "console.error" | "pageerror" | "overflow";
  /**
   * Where it came *from*: the script's URL for a console error, the frame's for
   * everything else — and only ever a URL the browser reported loading. The
   * source rather than the page, because the case the allowlist exists for is a
   * third-party embed on a page of ours.
   */
  readonly at: string;
  readonly detail: string;
}

/**
 * Two frames, as an expression rather than a function for the same reason
 * `WATCH` is one: there is no DOM lib here to type `requestAnimationFrame` with.
 */
const FLUSH = "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))";

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
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; check(); });
  };
  if (document.fonts) document.fonts.ready.then(soon);
  if (document.readyState === "complete") soon();
  else window.addEventListener("load", soon);
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

/** The option a repo sets, declared so `test.use({ sweepAllowlist })` type-checks. */
export interface InvariantSweep {
  /**
   * URLs whose console errors, page errors and overflow this run tolerates,
   * each against the reason it is tolerated. The key is a **regular
   * expression** tested against the URL, and it is **unanchored** — `"/checkout"`
   * also matches `/checkout-v2`, so write `"/checkout$"` when a page name is
   * meant. The value is why, which is the half a reviewer reads.
   */
  sweepAllowlist: Record<string, string>;
}

/**
 * The characters a terminal reads as instructions rather than as text: C0 and
 * the newline among them, DEL, and the C1 range some terminals still take as
 * escape sequences.
 */
// oxlint-disable-next-line eslint/no-control-regex -- the control characters are the subject: this expression is the whole of what stops a page writing an ANSI escape or a line break into a CI annotation
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * One line, printable, and no longer than a sentence.
 *
 * A page writes this string and a CI annotation prints it, so every control
 * character goes: an ANSI escape would colour somebody's log, and a newline is
 * what a `::error::` workflow command needs in order to start a line of its own.
 */
function sanitized(detail: unknown): string {
  const text = typeof detail === "string" ? detail : "";
  const printable = text.replaceAll(CONTROL, " ").replaceAll(/\s+/g, " ").trim();
  return printable.length > DETAIL_LIMIT ? `${printable.slice(0, DETAIL_LIMIT)}…` : printable;
}

/** The first http(s) URL a stack names, which is the script the error came out of. */
function scriptIn(stack: string | undefined): string | undefined {
  return /https?:\/\/[^\s)]+?(?=:\d+:\d+|\s|\)|$)/.exec(stack ?? "")?.[0];
}

function describe({ kind, at, detail }: Violation): string {
  return `${kind} at ${at} — ${detail}`;
}

/**
 * Gives one page the chance to report what it has measured, and never costs the
 * assertion.
 *
 * A report crosses from the page on the frame after the check runs, so a spec
 * that ends the instant `goto` resolves would be asserted against an empty list
 * — the sweep's answer would depend on how long the spec happened to take. Two
 * frames: the first lets a pending check run, the second lets a check that
 * frame scheduled land.
 *
 * A page that navigates on a timer destroys the context this runs in, and a page
 * the spec closed has none. Both are pages with nothing left to drain, and
 * letting either throw here would replace the sweep's verdict — the list it
 * spent the whole test collecting — with a message about the flush.
 */
async function drain(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    await page.evaluate(FLUSH);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(DESTROYED)) throw error;
  }
}

/**
 * Playwright's `test`, with the browser context replaced by one that watches
 * every page it opens. A repo swaps its import and every spec it already has is
 * swept:
 *
 * ```ts
 * import { test } from "@gokayo43/dev-config/invariant-sweep.ts";
 * import { expect } from "@playwright/test";
 * ```
 */
export const test = base.extend<InvariantSweep>({
  sweepAllowlist: [{}, { option: true }],

  context: async ({ context, sweepAllowlist }, provide) => {
    const allowed = Object.keys(sweepAllowlist).map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (cause) {
        // The keys are written by hand in a config file, and a bad one would
        // otherwise surface as a bare SyntaxError from a fixture nobody knew
        // was compiling a pattern.
        throw new Error(
          `sweepAllowlist key ${JSON.stringify(pattern)} is not a regular expression — the keys are patterns tested against the URL a violation came from, so a literal URL works as one and an unbalanced \`(\` does not`,
          { cause },
        );
      }
    });

    const violations: Violation[] = [];
    /** Every URL the browser actually loaded a document or a script from. */
    const fetched = new Set<string>();

    const record = (violation: Violation): void => {
      if (allowed.some((pattern) => pattern.test(violation.at))) return;
      violations.push(violation);
    };

    /**
     * The URL to attribute this to: what was claimed, but only where the browser
     * reports having loaded it. A `//# sourceURL=` comment is a claim any script
     * can make about itself, and honouring it unchecked lets an inline script of
     * ours land in a vendor's allowlist bucket.
     */
    const from = (claimed: string | undefined, page: Page): string =>
      claimed !== undefined && fetched.has(claimed) ? claimed : page.url();

    const watch = (page: Page): void => {
      page.on("response", (response) => {
        if (ADDRESSABLE.has(response.request().resourceType())) fetched.add(response.url());
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        record({
          kind: "console.error",
          at: from(message.location().url, page),
          detail: sanitized(message.text()),
        });
      });
      page.on("pageerror", (error) => {
        // Playwright hands a `pageerror` no frame, so where it came from is read
        // out of the stack — and honoured on the same terms as any other claimed
        // URL. That is what lets an embed's own thrown error be allowlisted by
        // the embed's address rather than by the page carrying it.
        record({
          kind: "pageerror",
          at: from(scriptIn(error.stack), page),
          detail: sanitized(error.message),
        });
      });
    };

    // Exposed before the init script is added, because the script the next
    // navigation runs calls it in its first frame. A *binding* rather than a
    // plain exposed function: a binding is told which frame called it, and a
    // page is not a trusted narrator — the frame's own URL and the fixed
    // `overflow` kind are the harness's, and only the sentence is the page's.
    await context.exposeBinding(REPORTER, ({ frame, page }, detail: unknown) => {
      if (frame !== page.mainFrame()) return;
      record({ kind: "overflow", at: frame.url(), detail: sanitized(detail) });
    });
    await context.addInitScript(WATCH);
    context.on("page", watch);
    for (const open of context.pages()) watch(open);

    await provide(context);

    await Promise.all(context.pages().map(async (page) => await drain(page)));

    expect(
      violations.map(describe),
      "pages visited by this test broke an invariant every page holds; fix it, or name the URL in `sweepAllowlist` with the reason it is tolerated",
    ).toEqual([]);
  },
});
