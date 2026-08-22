/**
 * Where a repo's CI lives, which both halves of the contract have an opinion
 * about and neither owns.
 *
 * `repo-contract.ts` asks whether the file calls the shared check.yml at a
 * pinned SHA — a fact about every repo. `live.ts` names the same file in two
 * problems about what that call has to ask for — facts about a repo with users.
 * Either module could hold the string and import it to the other; both
 * directions read as one of them owning a path it merely mentions, and one of
 * them is the cycle. So it is here, the way `db-gate` keeps what two of its
 * gates share inside its own directory rather than in `_lib`.
 */
export const CI_WORKFLOW = ".github/workflows/ci.yml";
