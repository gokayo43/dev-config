import type { KnipConfig } from "knip";

import { base, mutationLaneDependencies } from "./knip.base.ts";

const config: KnipConfig = {
  ...base,
  // A gate's `*.main.ts` is what GitHub runs, so nothing in this repo imports
  // it. Splitting the entry point out of the gate module is also what lets the
  // coverage floor mean something: a module the suite drives reports its own
  // coverage, rather than carrying an entry block no test can reach.
  // `anti-slop/index.js` is the same kind of entry from the other direction:
  // oxlint loads it by the path in `oxlint.base.json`, which knip does not read.
  entry: [".github/actions/*/*.main.ts", "anti-slop/index.js", "tests/*.ts"],
  project: [".github/actions/**/*.ts", "anti-slop/**/*.js", "tests/**/*.ts"],
  // The mutation lane's own two packages, which its suite drives against this
  // repo's install. The names come from the base rather than from here;
  // knip.base.ts says why the spread is the repo's.
  ignoreDependencies: [...mutationLaneDependencies],
  // capacity.js is not this repo's program: it runs inside k6, against modules
  // built into that runtime and resolvable from no package.json anywhere. The
  // linter skips it for the same reason, and tests/capacity-script.ts executes
  // it so that skipping is not the same as never running it.
  ignore: [".github/actions/db-gate/capacity.js"],
};

export default config;
