import type { KnipConfig } from "knip";

import { base } from "./knip.base.ts";

const config: KnipConfig = {
  ...base,
  // A gate's `*.main.ts` is what GitHub runs, so nothing in this repo imports
  // it. Splitting the entry point out of the gate module is also what lets the
  // coverage floor mean something: a module the suite drives reports its own
  // coverage, rather than carrying an entry block no test can reach.
  entry: [".github/actions/*/*.main.ts", "tests/*.ts"],
  project: [".github/actions/**/*.ts", "tests/**/*.ts"],
  // knip reads every `run:` block for the binaries it invokes, which is worth
  // having — it is how a workflow reaching for an undeclared tool gets caught.
  // `let` is bash's arithmetic builtin inside an inlined JS snippet, not a tool.
  ignoreBinaries: ["let"],
  // capacity.js is not this repo's program: it runs inside k6, against modules
  // built into that runtime and resolvable from no package.json anywhere. The
  // linter skips it for the same reason, and tests/capacity-script.ts executes
  // it so that skipping is not the same as never running it.
  ignore: [".github/actions/db-gate/capacity.js"],
};

export default config;
