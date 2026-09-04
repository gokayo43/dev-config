/**
 * What a repo's `lifecycle` field says: the two words it takes, and the reading
 * of a manifest for one.
 *
 * Here rather than beside the rules it switches on, because a second action
 * reads it. `repo-contract/live.ts` derives everything a repo owes because it
 * carries people; `db-gate/route-compat.ts` holds such a repo to the routes the
 * base ref served. Both hang on the same question — is anyone on the other end
 * of this — and two readings of one key are two answers to it.
 */
import { type ConfigObject, oneOf } from "./gate.ts";

/**
 * Whether the repo is deployed and carrying people, said by the repo about
 * itself rather than inferred from anything. Nothing derives it — a repo with a
 * hostname, a compose file and a backup script is indistinguishable from one
 * three days away from its first deploy — so it is declared, and moving it to
 * `live` is the owner's own commit.
 */
const LIFECYCLES = ["dev", "live"] as const;

export type Lifecycle = (typeof LIFECYCLES)[number];

/**
 * The field as written and as read, derived once. Two readings of one manifest
 * key are two places for it to mean different things, and the diagnostics need
 * the raw value as much as the graded one.
 */
export interface Declared {
  /** What the manifest holds, phrased the way a diagnostic has to say it. */
  readonly found: string;
  /** That value as one of the two words, or nothing — its own problem, never a default. */
  readonly is: Lifecycle | undefined;
}

/** The field as one of those, or nothing — which is its own problem and never a default. */
export function lifecycleOf(value: unknown): Lifecycle | undefined {
  return oneOf(LIFECYCLES, value);
}

export function declaredIn(contents: ConfigObject): Declared {
  const value = contents["lifecycle"];
  return {
    found: value === undefined ? "is absent" : `reads ${JSON.stringify(value)}`,
    is: lifecycleOf(value),
  };
}
