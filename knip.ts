import type { KnipConfig } from "knip";

import { base } from "./knip.base.ts";

const config: KnipConfig = {
  ...base,
  // Each action's script is an entry point: GitHub runs it directly, so nothing
  // in this repo imports it and knip would otherwise report the whole gate as
  // unreachable.
  entry: [".github/actions/*/*.ts", "tests/*.test.ts"],
  project: [".github/actions/**/*.ts", "tests/**/*.ts"],
  // knip reads every `run:` block for the binaries it invokes, which is worth
  // having — it is how a workflow reaching for an undeclared tool gets caught.
  // `let` is bash's arithmetic builtin inside an inlined JS snippet, not a tool.
  ignoreBinaries: ["let"],
};

export default config;
