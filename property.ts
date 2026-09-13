/**
 * The house property budget: the call every property test makes instead of
 * fast-check's `assert`, so that one run can be given a hundred times the work
 * of another without a line of any test changing.
 *
 * How many inputs a property is run over is the whole of what it is worth — a
 * property at 100 runs and the same property at 5 000 are two different
 * searches — and written per test that number is one nobody can move. The
 * fleet's properties today sit anywhere between a dozen runs and twenty
 * thousand, each decided by whoever wrote the file and none of them reachable
 * from outside it. So the dial is here, in the one call they all go through: a
 * developer waits for the small search, and a run with the whole night gets the
 * large one by setting two variables.
 *
 * A budget is deliberately not a bar to clear: the long budget can only ever
 * find more, never fail a suite for being slow on a loaded box. Holding that
 * takes more than `markInterruptAsFailure: false`, which only covers a run
 * interrupted after at least one success — fast-check reads an interruption
 * with *no* completed run as a failure whatever that flag says
 * (`considerInterruptedAsFailure = interruptedAsFailure || numSuccesses === 0`,
 * 4.9.0). One async property whose single run outlasts two minutes would
 * therefore have filed "Nightly is red" every night, which is the outcome this
 * module exists to prevent. So the run goes through `fc.check` and the one
 * outcome that is the budget's own is reported as a skipped property rather
 * than thrown.
 *
 * Everything else is fast-check's and passes through untouched. A failure's
 * seed, path and shrunk counterexample are what replay it, and a wrapper
 * standing between a failing property and the line that reproduces it would be
 * worth more than the dial it added.
 */

import {
  asyncDefaultReportMessage,
  check as ran,
  defaultReportMessage,
  readConfigureGlobal,
} from "fast-check";
import type { IAsyncProperty, IProperty, IRawProperty, Parameters, RunDetails } from "fast-check";

/**
 * The factor every property's run count is multiplied by: a whole number,
 * one or more. Unset is 1, which is the run a developer makes.
 *
 * Exported as its name rather than read as a literal wherever it is written,
 * because the variable is a protocol between this module and whoever sets it —
 * `test-suite`'s action.yml is the one place it is spelled out rather than
 * imported, for the reason the ramp's route-log endpoint is: that end is bash.
 */
export const RUNS_FACTOR = "PROPERTY_RUNS_FACTOR";

/**
 * How many milliseconds one property may spend generating before fast-check
 * stops and takes what it has. Unset is no bound, which is what a run that
 * multiplied nothing needs.
 *
 * It is what makes a large factor safe to set fleet-wide: the factor alone
 * turns one slow property into a job that never ends, and the pair says "as
 * many runs as you can fit in two minutes" instead.
 */
export const TIME_LIMIT = "PROPERTY_TIME_LIMIT_MS";

/**
 * fast-check's own default, which is what a factor multiplies when neither the
 * caller nor the repo's global configuration names a count. Written out because
 * the library documents the number on `Parameters.numRuns` and exports no
 * constant holding it.
 */
const DEFAULT_RUNS = 100;

const WHOLE = /^\d+$/u;

/**
 * A budget variable as the whole number it has to be, or nothing where the run
 * set none. Anything else throws: a factor of `fifty` read as "no factor" is a
 * nightly that quietly ran the developer's search all night and reported it as
 * the long one, which is the failure this whole module exists to make visible.
 */
function budgetIn(name: string): number | undefined {
  const written = (Bun.env[name] ?? "").trim();
  if (written === "") return undefined;
  if (!WHOLE.test(written) || Number(written) < 1) {
    throw new Error(
      `${name} is ${JSON.stringify(written)} — it takes a whole number of at least 1, and a budget nothing can read is a budget nobody applied`,
    );
  }
  return Number(written);
}

/**
 * The caller's parameters with the run's budget applied. The two the budget
 * owns are written after the spread on purpose: where a run names a time limit
 * that limit is the one in force, since the point of it is to bound what this
 * process spends rather than to honour what each test hoped to.
 */
function budgeted<Ts>(params: Parameters<Ts> | undefined): Parameters<Ts> {
  const limit = budgetIn(TIME_LIMIT);
  const runs = params?.numRuns ?? readConfigureGlobal().numRuns ?? DEFAULT_RUNS;
  return {
    ...params,
    numRuns: runs * (budgetIn(RUNS_FACTOR) ?? 1),
    ...(limit === undefined
      ? {}
      : { interruptAfterTimeLimit: limit, markInterruptAsFailure: false }),
  };
}

/**
 * What a finished run does, which is what `fc.assert` does with the same
 * details — except for the one outcome that belongs to the budget rather than
 * to the property.
 *
 * A failure is rethrown with fast-check's own report, so the seed, the path and
 * the shrunk counterexample reach the reader unchanged. An interruption that
 * completed no run at all, under a time limit this module set, is the budget
 * saying "not enough time for one run of this" — a fact about the run and not
 * about the code, and one that must not turn a nightly red. It is announced
 * rather than swallowed: a property nobody searched is worth knowing about.
 */
function settled<Ts>(
  details: RunDetails<Ts>,
  message: string | undefined,
  limit: number | undefined,
): void {
  if (!details.failed) return;
  if (details.interrupted && details.counterexample === null && limit !== undefined) {
    // oxlint-disable-next-line no-console -- the run's own log is the only place this can be said: it is not a failure, and a property that was never searched has no assertion to carry the news
    console.log(
      `property skipped: ${TIME_LIMIT} is ${limit}ms and no run of this property finished inside it (seed ${details.seed}) — one run costs more than the whole budget, so nothing was searched`,
    );
    return;
  }
  throw new Error(
    message ?? `the property failed and fast-check wrote no report (seed ${details.seed})`,
    ...(details.errorInstance === null ? [] : [{ cause: details.errorInstance }]),
  );
}

/**
 * `fc.assert` with the run's budget applied — the same three signatures, so
 * that adopting this is a change of import and nothing else, and so that an
 * async property still hands back the promise a caller has to await. A wrapper
 * answering `void` there would let a suite finish before the property had run,
 * which is the assertion-free pass the test-suite gate refuses.
 */
export function check<Ts>(property: IAsyncProperty<Ts>, params?: Parameters<Ts>): Promise<void>;
export function check<Ts>(property: IProperty<Ts>, params?: Parameters<Ts>): void;
export function check<Ts>(
  property: IRawProperty<Ts>,
  params?: Parameters<Ts>,
): Promise<void> | void;
export function check<Ts>(
  property: IRawProperty<Ts>,
  params?: Parameters<Ts>,
): Promise<void> | void {
  const limit = budgetIn(TIME_LIMIT);
  const details = ran(property, budgeted(params));
  // `check` answers a promise for an async property and a value for a sync one,
  // exactly as `assert` does, and the caller's own signature above is what says
  // which. The async report is awaited rather than the sync one because
  // stringifying an async counterexample is itself async — using the sync
  // reporter there prints a promise where the value should be.
  return details instanceof Promise
    ? details.then(async (out) => {
        settled(out, await asyncDefaultReportMessage(out), limit);
      })
    : settled(details, defaultReportMessage(details), limit);
}
