import { notice, type Problem, report } from "../_lib/gate.ts";

/**
 * What the gates in this directory report, and how their entry points say it.
 *
 * Beside `database.ts` rather than in `_lib/` for the reason that file gives:
 * `_lib/` is what more than one *action* reads, and every consumer of this is a
 * step of this one. A third action that proves a property the same way is when
 * it moves, and not before.
 */

/**
 * What a gate that proves a property reports, rather than a bare `Problem[]`:
 * the claim it established, or the evidence behind one it could not.
 *
 * The two are exclusive by construction — `passed` and `refused` below are the
 * only ways to build one — because a step that failed has already said so in
 * its annotations, and a summary beside them would be the step paraphrasing its
 * own error back at the reader.
 */
export interface Verdict {
  /** What holding proved, for the log. Absent when it did not hold: the problems are the report. */
  readonly summary: string | undefined;
  /** What the two sides do not share — a diagnostic that only says "they differ" is not one. */
  readonly divergence: string[];
  readonly problems: Problem[];
}

/** A verdict with nothing to report, which is every passing one. */
export function passed(summary: string): Verdict {
  return { summary, divergence: [], problems: [] };
}

/** A verdict that fails the step. There is no summary: what happened is the problem. */
export function refused(problems: Problem[], divergence: string[] = []): Verdict {
  return { summary: undefined, divergence, problems };
}

/**
 * The whole of what a `*.main.ts` does with one. Here rather than copied into
 * each entry point because it is the same three writes every time and their
 * order is load-bearing: the divergence goes to the log as it stands, before
 * the annotation summarising it, so a reader who scrolls to the error finds
 * what it was about above rather than somewhere below.
 *
 * The divergence is log lines rather than annotations because an annotation is
 * one line rendered on the step, and evidence that runs to hundreds — every
 * line two dumps disagree about — has to go somewhere a message that stays
 * short enough to read cannot.
 */
export function reportVerdict({ summary, divergence, problems }: Verdict): void {
  for (const line of divergence) console.log(line);
  if (summary !== undefined) notice(summary);
  report(problems);
}
