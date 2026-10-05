import { InvariantSweep } from "./invariant-sweep.js";
import { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from "@playwright/test";
//#region count-ceilings.d.ts
declare const COUNTS: readonly ["reactCommits", "mutationRecords", "requests", "bodyBytes", "scriptBytes"];
type Count = (typeof COUNTS)[number];
/**
 * One phase's counts, which is also the shape of the `count-budget` attachment
 * each budgeted test carries, by phase. `reactCommits` is absent, never zero, on
 * a phase no React renderer ran in.
 */
type Counts = Partial<Record<Count, number>>;
//#endregion
//#region count-budget.d.ts
export interface Budget {
  /**
   * Waits for the page to go still, runs `action`, waits again, and records
   * what the page did between the two. A phase that throws, refusals included,
   * fails the test even where the test catches it.
   */
  phase<Answer>(name: string, action: () => Promise<Answer>): Promise<Answer>;
}
/** The fixture and the option a repo sets, declared so `test.use({ servedOrigins })` type-checks. */
export interface CountBudget {
  /**
   * Origins the test serves itself beyond its `baseURL`'s, such as an API it
   * started on a port of its own. A request to any other origin has to be
   * fulfilled by a route.
   */
  servedOrigins: readonly string[];
  budget: Budget;
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
export declare const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & InvariantSweep & CountBudget, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
//#endregion
export type { Counts };