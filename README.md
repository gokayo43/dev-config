# @gokayo43/dev-config

One source of truth for the tooling policy shared by my Bun projects: TypeScript
strictness, the oxlint rule set, the workspace-agnostic knip settings, and the
CI workflow every repo runs.

Repos install it straight from GitHub — no registry, no build step, the files
are consumed exactly as they are committed:

```sh
bun add -d github:gokayo43/dev-config
```

Consuming repos keep only their own facts locally (paths, JSX, globals, entry
points, ignore globs) and inherit everything else. If a repo has to override a
shared setting, the override carries a comment naming the reason.

## TypeScript

`tsconfig.base.json` resolves through Node module resolution, so it is referenced
by package name:

```json
{
  "extends": "@gokayo43/dev-config/tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "bun"],
    "paths": { "~/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

The base turns on `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax` and `isolatedModules`, and targets ES2023 with
`module: "preserve"` + `moduleResolution: "bundler"` — the pairing TypeScript 7
expects when a bundler (Vite, Bun) owns the emit. `skipLibCheck` is on: the
dependency trees here are large and third-party `.d.ts` noise is not this
project's bug to fix.

## oxlint

`.oxlintrc.json` cannot resolve package names — its `extends` entries are paths
relative to the config file — so the base is referenced through `node_modules`:

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "extends": ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
  "env": { "browser": true, "node": true, "es2024": true },
  "ignorePatterns": ["node_modules/**", "dist/**"]
}
```

Configs merge first-to-last, so anything the local file declares wins over the
base. The base sets `correctness: error`, `suspicious: warn`, `perf: warn`,
`no-console: warn`, and the two `react-hooks` rules.

## knip

Only a TypeScript or JavaScript knip config can import from a package, so repos
use `knip.ts` rather than `knip.json`:

```ts
import type { KnipConfig } from "knip";
import { base } from "@gokayo43/dev-config/knip.base.ts";

const config: KnipConfig = {
  ...base,
  entry: ["src/router.tsx", "src/routes/**/*.tsx"],
  project: ["src/**/*.{ts,tsx}"],
};

export default config;
```

Everything knip keys off file paths stays local — a base glob that matches
nothing in the consuming repo is itself reported as a configuration hint.

## CI

Copy this into `.github/workflows/ci.yml`. It is the same gate as the local
`bun run check` plus the test suite, so a green pre-push is a green CI run:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile

      - run: bun run format:check
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run knip
      - run: bun test
```

`setup-bun` is given no version input on purpose: with none it reads the repo's
`packageManager` field from `package.json`, so CI and the dev machine never
drift.

## Version policy

Dependencies are pinned exactly — no ranges, no carets — and a version is only
adopted once it has been on npm for at least seven days. Both halves are
enforced by `bunfig.toml` in the consuming repos:

```toml
[install]
minimumReleaseAge = 604800 # 7 days, in seconds
saveExact = true
```

A package published minutes ago cannot be installed, so a compromised release
that is detected and yanked within hours never reaches a lockfile. Upgrades take
the newest version that clears the window, which is why this repo's baseline is
TypeScript 7.0.x rather than a `7.1.0-dev` build.
