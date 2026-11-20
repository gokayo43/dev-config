import type { KnipConfig } from "knip";

import { base, mutationLaneDependencies } from "./knip.base.ts";

const config: KnipConfig = {
  ...base,
  // A gate's `*.main.ts` is what GitHub runs, so nothing in this repo imports
  // it. Splitting the entry point out of the gate module is also what lets the
  // coverage floor mean something: a module the suite drives reports its own
  // coverage, rather than carrying an entry block no test can reach.
  // The Next.js fixture app's route files and config are Next's to load, and
  // the TanStack Start fixture's server entry and Start instance are found by
  // the Start plugin at their paths, as an app's are: nothing imports them.
  entry: [
    ".github/actions/*/*.main.ts",
    "tests/*.ts",
    "tests/request-timing-next-app/next.config.ts",
    "tests/request-timing-next-app/app/**/route.ts",
    "tests/request-timing-start-app/src/{server,start}.ts",
  ],
  project: [".github/actions/**/*.ts", "anti-slop/**/*.js", "tests/**/*.ts"],
  // The mutation lane's own two packages, which its suite drives against this
  // repo's install. The names come from the base rather than from here;
  // knip.base.ts says why the spread is the repo's.
  // tailwindcss beside them, which nothing here imports: the design-system
  // suite links it into its fixture, because no-unknown-classes asks the
  // project's own Tailwind which classes exist. The package also switches on
  // knip's Tailwind plugin, which compiles stylesheets this repo does not have.
  ignoreDependencies: [...mutationLaneDependencies, "tailwindcss"],
  tailwind: false,
};

export default config;
