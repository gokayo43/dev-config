import { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from "@playwright/test";
//#region invariant-sweep.d.ts
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
 * Playwright's `test`, with the browser context replaced by one that watches
 * every page it opens. A repo swaps its import and every spec it already has is
 * swept:
 *
 * ```ts
 * import { test } from "@gokayo43/dev-config/invariant-sweep";
 * import { expect } from "@playwright/test";
 * ```
 */
export declare const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & InvariantSweep, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
//#endregion