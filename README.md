# @gokayo43/dev-config

One source of truth for the tooling policy shared by my Bun projects: TypeScript
strictness, the oxlint rule set including its type-aware rules, the architecture
boundaries wiring, the formatter width, the workspace-agnostic knip settings, the
Renovate policy, the coverage floor, the secret-scanning gate, and the CI
workflow every repo calls.

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
| `.github/workflows/check.yml` | GitHub Actions | `uses` by repository path, pinned to a SHA |

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

### The gitleaks custom manager

Every other pin in these repos sits somewhere a manager already looks. The
gitleaks version and archive checksum sit in a `run:` block, so the preset adds
a `customManagers` entry that reads them out of a workflow file or a README.
Both patterns earn their place here: the pair lives in this repo's `check.yml`,
which every repo runs by reference, and the version alone lives in this README's
local install snippet for the pre-commit hook.

```json
{
  "customType": "regex",
  "managerFilePatterns": ["/^\\.github/workflows/[^/]+\\.ya?ml$/", "/(^|/)README\\.md$/"],
  "matchStrings": [
    "GITLEAKS_VERSION: (?<currentValue>v\\S+)\\s+GITLEAKS_SHA256: (?<currentDigest>[0-9a-f]{64})",
    "GITLEAKS_VERSION=(?<currentValue>v\\S+)"
  ],
  "depNameTemplate": "gitleaks/gitleaks",
  "datasourceTemplate": "github-release-attachments"
}
```

The datasource is what makes this safe. `github-releases` would move the version
and leave the checksum, and a version bumped past a stale `sha256sum -c` fails
every CI run until someone hashes the archive by hand.
`github-release-attachments` instead searches the current release for the file
the current checksum belongs to — matching the line in `gitleaks_*_checksums.txt`
— then reads the same file's line out of the new release's checksums file. The
version and the checksum are one dependency with one `replaceString` spanning
both lines, so they cannot land apart.

Finding the release means `currentValue` has to be a tag: a bare `8.30.1` is a
404 on `releases/tags/`, which drops the update. So the pin is written `v8.30.1`
and the URL strips the prefix for the asset name. The second `matchString` picks
up the unhashed `GITLEAKS_VERSION=` line in the local install instructions, which
is the same dependency and rides along in the same PR.

### Validating the preset

This repo's own CI parses every JSON file it ships and validates the preset on
every push. There is no standalone `renovate-config-validator` package on npm;
the binary ships inside `renovate`:

```sh
npx --package renovate renovate-config-validator --strict --no-global default.json
```

`--no-global` is load-bearing. Handed a filename the validator assumes
self-hosted global configuration, and in that mode a global-only option like
`binarySource` validates clean — in a shared preset every repo extending it
would drop the option on the floor. `--strict` makes warnings and a pending
config migration exit non-zero rather than print.

## Secret scanning

`gitleaks` guards both ends: a pre-commit hook so a key never reaches a commit,
and a CI step so nothing slips through a push that skipped the hooks.

It is a Go binary, not an npm package, so it installs outside the lockfile:

```sh
GITLEAKS_VERSION=v8.30.1
curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz" \
  | tar -xz -C ~/.local/bin gitleaks
```

The hook goes in `lefthook.yml`:

```yaml
pre-commit:
  commands:
    secrets:
      run: gitleaks git --staged --redact --no-banner .
```

`--staged` scans the index rather than the working tree, which is the whole
point: every one of these repos keeps a real `.env` gitignored in its working
tree, so a working-tree scan would fail every commit over secrets that were never
going anywhere. The command deliberately carries no `glob` — a leaked key is as
likely in a `.yml`, a fixture or a `.env` as in a `.ts`. `--redact` keeps the
secret out of the hook output and the CI log; a leak printed by CI is already
readable by anyone who can see the run.

The default rule set is what runs — there is no `gitleaks.toml` here. Scanned
across these repos it reports zero false positives on tracked files, so a shared
allowlist would be configuration guarding a problem that does not exist. A real
false positive is pinned by its fingerprint in a repo-local `.gitleaksignore`,
which keeps the exception next to the file that earned it instead of loosening a
rule for every repo at once.

Two properties of the default rules cost a probe to discover. Keys from providers
with no dedicated rule are caught by the entropy-based `generic-api-key` rule
rather than a named one — that is what matches `RESEND_API_KEY=re_…`. And the AWS
documentation key `AKIAIOSFODNN7EXAMPLE` is allowlisted upstream, so testing the
hook with it reports nothing and looks exactly like a broken hook.

## CI

The gate is a workflow in this repo — `.github/workflows/check.yml` — and repos
call it instead of retyping it. A consuming repo's `.github/workflows/ci.yml` is
the whole of its CI:

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
    uses: gokayo43/dev-config/.github/workflows/check.yml@<commit sha> # v0.3.1
    with:
      build: true
      database: true
```

| Input | Default | Effect |
| --- | --- | --- |
| `build` | `false` | Runs `bun run build` before the static gate and before the boot gate. |
| `database` | `false` | Adds the database job: an empty Postgres, the migrations replayed onto it twice, and the app booted against the result. |
| `start-command` | `bun run start` | How the boot gate starts the app. |
| `health-url` | `http://localhost:3000/api/health` | What the boot gate polls until it answers 200. |

The call is pinned by commit SHA with the release as the trailing comment — the
same contract the actions inside it carry, and the reason a change here reaches
a repo when its pin moves and not before. The example above is deliberately not
a real SHA: nothing keeps a README snippet current, so the pin worth copying is
the live one in `project-template`'s `setup/ci.yml`. Renovate's github-actions manager
reads a job-level `uses:` exactly as it reads a step's, so the pin moves in a PR
like any other dependency.

In order, the pinned workflow runs the gitleaks scan, `bun install`, the
optional build, `format:check`, `lint`, `typecheck`, `knip`, the test suite, and
the assertion that the suite ran. Everything up to the test suite is the local
`bun run check`, so a green pre-push is a green CI run; the two steps after it
are what only CI has.

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

Everything the workflow reaches for is pinned by content, not by a name someone
else can repoint: actions and the workflow call by commit SHA, the gitleaks
archive by SHA-256, the Postgres and Redis service images by digest. The tag in
the trailing comment — or beside the digest, for the images — is the label and
the hash is the contract; Renovate moves both together. Service images are
written `postgres:16-alpine@sha256:…` rather than digest-only because that is
the form its docker datasource maintains, and the manager reads a job's
`services:` block for exactly this.

The secret scan downloads the released binary instead of using
`gitleaks/gitleaks-action`, which since v2 is not open source: it ships under a
Gitleaks LLC EULA that requires a license key for repositories owned by an
organization and enforces that requirement in the action itself. The pipeline
would keep working right up to the day one of these repos moved under an org.
The CLI it wraps is MIT, so running it directly sheds the licence question
entirely and puts the scanning version in the diff rather than inside a
third-party action's bundled `dist/`. `GITLEAKS_SHA256` is the same contract the
digest pins are — the version string beside it is the label. No built-in manager
reads a `run:` block; the preset's gitleaks custom manager does, and moves the
version and the checksum in one PR. It finds the release by tag, which is why the
pin is written `v8.30.1` and the asset name in the URL strips the prefix again.

`fetch-depth: 0` is what makes the scan worth running. `gitleaks git` reads
history, and the default shallow checkout hands it exactly one commit — a secret
committed and then deleted further along the same branch would go unreported,
even though pushing it had already burned the key. A full-history scan costs
about a second on repos this size.

`setup-bun` is given no version input on purpose: with none it reads the repo's
`packageManager` field from `package.json`, so CI and the dev machine never
drift.

A repo whose types depend on generated code that is not committed — a TanStack
route tree, a codegen client — passes `build: true`, since a clean checkout has
none of it and both `tsc` and the type-aware lint rules would report the
generated symbols as missing.

### The suite has to have run

A lane that can silently not run is not a gate, so the test step writes a JUnit
report and the step after it reads the run out of that report. Both ways a suite
disappears are visible there: `test.skipIf(!process.env.TEST_DATABASE_URL)` and
friends report `<skipped/>`, while a test body that returns early on the same
condition reports `assertions="0"`. Without the check, CI stays green while
nothing below the pure-unit layer has executed since whenever the connection
string stopped being set.

The rule the gate enforces is that a test needing infrastructure fails without
it: read the connection string through something that throws, or use an
in-process engine — PGlite — that is always present. `test.todo` counts as
skipped, deliberately. An assertion-free test fails the same step, which the
house testing rules already reject in review and which costs nothing to reject
here.

That last one binds property tests too, and it is the rule worth writing down
because fast-check does not require it: a predicate that returns a boolean
records no assertion, so a property that never actually ran looks identical to
one that passed. Properties assert with `expect` inside the predicate — and
then a suite that silently stopped running is a red build rather than a number
nobody reads.

### Repos with a database

`database: true` adds a second job: an empty Postgres — plus a Redis, for the
shapes whose health route pings one — the migrations replayed onto it, and the
app booted against the result. `start-command` and
`health-url` are how a repo names its own app; everything else is the same for
every repo, which is why it lives in the workflow rather than at the call site.

An empty database is the one state no developer machine is ever in, and it is
the state every deploy to a new box and every restore drill starts from. A
migration carrying `ALTER TABLE ... DROP CONSTRAINT` for a constraint an earlier
`DROP TABLE ... CASCADE` has already taken is the shape that gets through: it
succeeds on the database it was written against, where that constraint was still
there, and aborts the first time the history runs onto nothing — a database that
cannot be rebuilt, discovered at the worst possible moment. Replaying from empty
on every push is what turns that into a red build.

The migrations then run a second time, and the gate is not the exit code but
`pg_dump --schema-only` before and after: the schema has to come out
identical. An exit code only says the second run did not error; the dump
says the database came out in the same state, which a `push`-style sync or a
hand-rolled runner can exit 0 without doing. With a journalled migrator the pass
is cheap and proves the journal is honest; with anything that re-executes SQL,
it proves the SQL is re-runnable.

Booting is the half that migrations succeeding does not prove. Health answers
200 only after the process has started against that schema and a query has
round-tripped, so a migration that applies but leaves the app unable to run
fails here. The server environment the job sets is the house contract with
dummy secrets — a real secret in a workflow file is a leaked secret — and a repo
whose contract needs more than that extends the workflow rather than the call.

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
