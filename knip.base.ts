import type { KnipConfig } from "knip";

// Only options that are true regardless of layout live here: everything knip
// keys off file paths (entry, project, ignore*) is a per-repo fact, and a glob
// that matches nothing in the consuming repo is itself reported as a hint.
// `satisfies` rather than an annotation: KnipConfig is a union with knip's
// function form, and an annotated export is a function to every caller that
// spreads it.
export const base = {
  treatConfigHintsAsErrors: true,
} satisfies KnipConfig;

/**
 * What a repo running the mutation lane has to ignore, for the repo to spread
 * into its own `ignoreDependencies`:
 *
 * ```ts
 * ignoreDependencies: [...mutationLaneDependencies],
 * ```
 *
 * Nothing imports either package and no `run:` block names them — the gate
 * resolves `node_modules/.bin/stryker` by path and Stryker loads the runner
 * plugin by name through its own loader — so knip reports both as unused in
 * every repo that declares them.
 *
 * The names live here because they are the gate's own constants, identical for
 * every consumer. The *spread* is the repo's because whether it runs the lane
 * is not: `treatConfigHintsAsErrors` above turns an ignore matching no declared
 * dependency into an error, so putting these in `base` would fail knip in every
 * repo that does NOT run the lane — the fleet going red on a pin bump, which is
 * the one thing the release contract exists to prevent.
 */
export const mutationLaneDependencies = [
  "@stryker-mutator/core",
  "@hughescr/stryker-bun-runner",
] as const;
