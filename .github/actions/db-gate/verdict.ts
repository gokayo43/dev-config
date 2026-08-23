import type { Problem, Verdict } from "../_lib/gate.ts";

/**
 * How the two gates in this directory that prove a property answer. The shape
 * itself is no longer theirs: a third action reported the same way, which is the
 * move this file used to say it was waiting for, and `Verdict` is in `_lib/`.
 *
 * What stays is the invariant those two share and nobody else does. The claim
 * and the refusal are exclusive by construction — these are the only ways either
 * gate builds one — because a step that failed has already said so in its
 * annotations, and a note beside them would be the step paraphrasing its own
 * error back at the reader.
 */

/** A verdict with nothing to report, which is every passing one. */
export function passed(note: string): Verdict {
  return { note, table: undefined, log: undefined, problems: [] };
}

/**
 * A verdict that fails the step. There is no note: what happened is the problem.
 *
 * The divergence — what the two sides do not share, since a diagnostic that only
 * says "they differ" is not one — is handed over as the log rather than as
 * annotations, because it runs to every line two dumps disagree about and an
 * annotation is one line rendered on the step.
 */
export function refused(problems: Problem[], divergence: readonly string[] = []): Verdict {
  return {
    note: undefined,
    table: undefined,
    log: divergence.length > 0 ? divergence.join("\n") : undefined,
    problems,
  };
}
