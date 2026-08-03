import type { KnipConfig } from "knip";

// Only options that are true regardless of layout live here: everything knip
// keys off file paths (entry, project, ignore*) is a per-repo fact, and a glob
// that matches nothing in the consuming repo is itself reported as a hint.
export const base: KnipConfig = {
  treatConfigHintsAsErrors: true,
};
