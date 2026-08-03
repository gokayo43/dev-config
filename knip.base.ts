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
