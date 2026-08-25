/**
 * The repo's CI call — where it lives and what it asks for — which both halves
 * of the contract have an opinion about and neither owns.
 *
 * `repo-contract.ts` asks whether the file calls the shared check.yml at a
 * pinned SHA, and whether the repo exposes the migration entry point that call
 * implies — facts about every repo. `live.ts` names the same file in two
 * problems about what that call has to ask for — facts about a repo with users.
 * Either module could hold them and import them to the other; both directions
 * read as one of them owning something it merely mentions, and one of them is
 * the cycle. So they are here, the way `db-gate` keeps what two of its gates
 * share inside its own directory rather than in `_lib`.
 */
import { oneOf } from "../_lib/gate.ts";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * Which database gates a caller's `check.yml` call runs, as the call spells it.
 *
 * Three values rather than a boolean, because "no Postgres job here" and "no
 * database gates anywhere" are different facts and only the second excuses a
 * repo from replaying its schema. `postgres` is check.yml's own job. `external`
 * is what a wrapper workflow passes when it calls check.yml for every static
 * gate and replaces the Postgres job with its own dialect's — `gokayo43/dev-config-db`
 * is the case, and under a boolean its consumers were refused for a job the
 * wrapper had deliberately taken over. `none` is a repo with no schema at all.
 */
const DATABASE_GATES = ["postgres", "external", "none"] as const;

export type DatabaseGates = (typeof DATABASE_GATES)[number];

/** The input as one of those, or nothing — which is the caller's problem and never a default. */
export function databaseGatesOf(value: string): DatabaseGates | undefined {
  return oneOf(DATABASE_GATES, value);
}

/** What a caller is told when it wrote something else. */
export function notDatabaseGates(value: string): string {
  return `database reads ${JSON.stringify(value)} — it is one of ${DATABASE_GATES.join(
    ", ",
  )}: postgres runs check.yml's own database job, external says a wrapper workflow runs the database gates instead of it, and none is a repo with no schema`;
}
