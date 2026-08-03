# @gokayo43/dev-config

One source of truth for the tooling policy shared by my Bun projects: TypeScript
strictness, the oxlint rule set including its type-aware rules, the architecture
boundaries wiring, the formatter width, the workspace-agnostic knip settings, the
Renovate policy, the coverage floor, and the CI workflows every repo runs.

Repos install it straight from GitHub — no registry, no build step, the files are
consumed exactly as they are committed:

```sh
bun add -d github:gokayo43/dev-config \
  typescript oxlint oxlint-tsgolint oxfmt knip \
  eslint-plugin-boundaries eslint-import-resolver-typescript
```

The tools are peer dependencies, all optional: a repo installs the ones it uses.
`oxlint-tsgolint` is not optional in practice — without it `oxlint` skips every
type-aware rule (see below).

Consuming repos keep only their own facts locally (paths, JSX, globals, entry
points, ignore globs, the layer matrix) and inherit everything else. If a repo has
to override a shared setting, the override carries a comment naming the reason.

| File | Consumed by | How |
| --- | --- | --- |
| `tsconfig.base.json` | `tsc` | `extends` by package name |
| `oxlint.base.json` | `oxlint` | `extends` by `node_modules` path |
| `knip.base.ts` | `knip` | imported by `knip.ts` |
| `lighthouserc.json` | `lhci` | `configPath` into `node_modules` |
| `default.json` | Renovate | `extends` by GitHub preset name |

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

`paths` stands on its own — TypeScript 7 removed `baseUrl`, and a config that
still sets it fails the build.

The base targets ES2023 with `module: "preserve"` + `moduleResolution: "bundler"`
— the pairing TypeScript 7 expects when a bundler (Vite, Bun) owns the emit — and
turns on:

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- `noPropertyAccessFromIndexSignature` — index-signature reads use `obj["key"]`,
  so a typo in a dotted read stays a type error instead of silently widening
- `noUncheckedSideEffectImports` — a bare `import "./thing"` must resolve
- `allowUnreachableCode: false`, `allowUnusedLabels: false`
- `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` — enums,
  parameter properties and namespaces are errors, because Bun and Vite strip
  types rather than compile them

`noUnusedLocals` and `noUnusedParameters` are deliberately absent: unused code is
the linter's report to make, and having both tools flag it means every dead
binding is two diagnostics with two different suppression syntaxes.

`skipLibCheck` is on: the dependency trees here are large and third-party `.d.ts`
noise is not this project's bug to fix.

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
base.

The base sets `correctness: error`, `suspicious: warn`, `perf: warn`,
`no-console: warn`, and the hooks rules — which oxlint configures under the
`react` plugin as `react/rules-of-hooks` and `react/exhaustive-deps`. Their
diagnostics are labelled `react-hooks`, but there is no `react-hooks` plugin to
name in a config, and a config naming one silently lints nothing.

A config's own `plugins` array replaces oxlint's built-in defaults rather than
adding to them, which is why the base names every plugin it wants including the
defaults `oxc`, `unicorn` and `typescript`. Across `extends` the arrays are
unioned, so a repo that adds `plugins` of its own keeps the base's.

The one rule the base switches off is `oxc/no-map-spread`, whose advice is to
mutate in place — wrong for the copy-on-write style these codebases are written
in.

### Architecture rules

`max-lines` denies at 1000: a file crossing 1000 lines is a presumptive blocker,
and the linter is where that gets said out loud. `max-depth` (4) and `complexity`
(20) warn at oxlint's own defaults, pinned so an upstream default change cannot
move the gate. `import/no-cycle` denies.

### Type-aware rules

`options.typeAware` is set in the base and survives `extends`, so a consuming
repo gets type-aware linting from `oxlint` with no flag and no local config. The
analysis runs in `oxlint-tsgolint`; without that package installed, oxlint runs
and reports nothing from the rules below.

Denied: `typescript/no-floating-promises`, `typescript/no-misused-promises`,
`typescript/await-thenable`, `typescript/no-unnecessary-condition`,
`typescript/switch-exhaustiveness-check`,
`typescript/no-unnecessary-type-assertion`, and the unsafe-`any` family —
`no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-call`,
`no-unsafe-enum-comparison`, `no-unsafe-member-access`, `no-unsafe-return`.
Warned: `typescript/prefer-nullish-coalescing`.

`no-unnecessary-condition` fires on any check TypeScript already proved
redundant, which includes real validation at a trust boundary — a parsed JSON
body, a `process.env` read, a value crossing the FFI edge — where the declared
type is a promise the runtime has not made. Those get a targeted disable carrying
the reason:

```ts
// oxlint-disable-next-line typescript/no-unnecessary-condition -- typed from the schema, arrives unvalidated over the wire
if (payload.items) {
```

A disable without a reason is a suppressed bug. The directive has to be one line
— a wrapped second comment line becomes the "next line" and the suppression
misses.

Type-aware rules need resolved types, so a repo whose types come from generated
code runs its codegen before linting, exactly as it does before `tsc`.

## Architecture boundaries

`eslint-plugin-boundaries` runs under oxlint's JS-plugin support. The element and
layer matrix is a per-repo fact and lives in `.oxlintrc.json`:

```json
{
  "jsPlugins": ["eslint-plugin-boundaries"],
  "settings": {
    "import/resolver": { "typescript": { "project": "./tsconfig.json" } },
    "boundaries/elements": [
      { "type": "domain", "pattern": "src/domain" },
      { "type": "http", "pattern": "src/http" }
    ]
  },
  "rules": {
    "boundaries/no-unknown-dependencies": "error",
    "boundaries/dependencies": ["error", {
      "default": "allow",
      "policies": [
        {
          "from": { "element": { "type": "domain" } },
          "disallow": [{ "to": { "element": { "type": "http" } } }],
          "message": "domain must not import http"
        }
      ]
    }]
  }
}
```

Both settings keys are load-bearing:

- `import/resolver` is what turns an import specifier into a file path. Without
  it only specifiers carrying an explicit extension resolve; extensionless and
  `~/`-aliased imports resolve to nothing and every violation through them passes
  silently.
- `boundaries/no-unknown-dependencies` turns an unresolved import into an error,
  so a resolver that stops working announces itself instead of quietly disabling
  the layer matrix.

An element `pattern` names a folder, not a file glob: `src/domain` classifies
everything under it, while `src/domain/*.ts` matches nothing and leaves the files
unclassified.

## Formatting

`oxfmt` has no `extends`, so the config is copied into each repo as
`.oxfmtrc.json`:

```json
{ "printWidth": 100 }
```

100 is also oxfmt's default; writing it down pins the width against a default
that could move.

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

## Tests and coverage

`bunfig.toml` cannot be extended across packages, so this block is copied into
each repo:

```toml
[test]
coverage = true
coverageThreshold = { lines = 0.75, functions = 0.75 }
coverageSkipTestFiles = true
```

`bun test` exits non-zero below the threshold, which is what makes it a gate
rather than a report.

0.75 is a floor, not a target: it is set at or below what the repo already
covers, and it is raised only after the coverage is there. A floor above current
reality is a red CI run that teaches everyone to ignore red CI runs.

## Renovate

`default.json` at this repo's root is a shareable preset. Consuming repos are one
line:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>gokayo43/dev-config"]
}
```

The preset runs weekly, holds every release for 7 days, groups patch, minor, pin
and digest updates into one automerging PR, opens majors as plain PRs to read,
keeps lockfile maintenance on, and pins GitHub Action digests.

The file is named `default.json` because that is the name Renovate resolves for a
bare `github>owner/repo`; `renovate.json` as a preset name is deprecated.

## CI

Copy this into `.github/workflows/ci.yml`. It is the same gate as the local
`bun run check` plus the test suite, so a green pre-push is a green CI run:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0

      - run: bun install --frozen-lockfile

      - run: bun run format:check
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run knip
      - run: bun test
```

The matching scripts:

```json
{
  "scripts": {
    "format": "oxfmt",
    "format:check": "oxfmt --check",
    "lint": "oxlint",
    "typecheck": "tsc --noEmit",
    "knip": "knip",
    "check": "bun run format:check && bun run lint && bun run typecheck && bun run knip"
  }
}
```

Actions are pinned to digests, so the tag in the trailing comment is a label and
the SHA is the contract; Renovate moves both together.

`setup-bun` is given no version input on purpose: with none it reads the repo's
`packageManager` field from `package.json`, so CI and the dev machine never
drift.

A repo whose types depend on generated code that is not committed — a TanStack
route tree, a codegen client — adds `bun run build` before the gate, since a
clean checkout has none of it and both `tsc` and the type-aware lint rules would
report the generated symbols as missing.

### Static sites

Static sites add `.github/workflows/lighthouse.yml`, which builds the site and
holds every Lighthouse category at 100:

```yaml
name: Lighthouse

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: lighthouse-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0

      - run: bun install --frozen-lockfile
      - run: bun run build

      - uses: treosh/lighthouse-ci-action@3e7e23fb74242897f95c0ba9cabad3d0227b9b18 # 12.6.2
        with:
          configPath: ./node_modules/@gokayo43/dev-config/lighthouserc.json
          uploadArtifacts: true
```

`lighthouserc.json` asserts performance, accessibility, best-practices and SEO at
`minScore: 1` over three runs of `./dist`. A repo that builds somewhere else
copies the file and changes `staticDistDir`.

## Version policy

Dependencies are pinned exactly — no ranges, no carets — and a version is only
adopted once it has been on npm for at least seven days. Both halves are enforced
by `bunfig.toml` in the consuming repos, and again by the Renovate preset:

```toml
[install]
minimumReleaseAge = 604800 # 7 days, in seconds
saveExact = true
```

A package published minutes ago cannot be installed, so a compromised release
that is detected and yanked within hours never reaches a lockfile. Upgrades take
the newest version that clears the window, which is why this repo's baseline is
TypeScript 7.0.x rather than a `7.1.0-dev` build.
