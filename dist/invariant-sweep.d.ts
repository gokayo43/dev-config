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
import { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from "@playwright/test";
/** The option a repo sets, declared so `test.use({ sweepAllowlist })` type-checks. */
export interface InvariantSweep {
  /**
   * Violations this run tolerates, keyed on the URL each came from: the
   * script's for a console error or a thrown error, the page's for overflow and
   * a layout shift. Each key is against the reason it is tolerated. The key is
   * a **regular expression** tested against that URL, and it is **unanchored**
   * — `"/checkout"` also matches `/checkout-v2`, so write `"/checkout$"` when a
   * page name is meant. The value is why, which is the half a reviewer reads.
   */
  sweepAllowlist: Record<string, string>;
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
export declare const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & InvariantSweep, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;