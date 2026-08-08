# @gokayo43/dev-config

One source of truth for the tooling policy shared by my Bun projects: TypeScript
strictness, the oxlint rule set including its type-aware rules, the architecture
boundaries wiring, the formatter width, the workspace-agnostic knip settings, the
Renovate policy, the coverage floor, the secret-scanning gate, the stack
denylist, the contract a repo declares about itself, and the CI workflow every
repo calls.

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

| File                           | Consumed by    | How                                        |
| ------------------------------ | -------------- | ------------------------------------------ |
| `tsconfig.base.json`           | `tsc`          | `extends` by package name                  |
| `oxlint.base.json`             | `oxlint`       | `extends` by `node_modules` path           |
| `knip.base.ts`                 | `knip`         | imported by `knip.ts`                      |
| `lighthouserc.json`            | `lhci`         | `configPath` into `node_modules`           |
| `default.json`                 | Renovate       | `extends` by GitHub preset name            |
| `.github/workflows/*.yml`      | GitHub Actions | `uses` by repository path, pinned to a SHA |
| `.github/actions/*/action.yml` | GitHub Actions | `uses` by repository path, pinned to a SHA |

Each gate has a reference page of its own. This file holds the map and the
settings every repo shares; what a single gate asserts, and why, lives beside it:

| Gate                  | Page                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo-contract`       | [docs/gates/repo-contract.md](docs/gates/repo-contract.md)                                                                                                                          |
| `stack-gate`          | [docs/gates/stack-gate.md](docs/gates/stack-gate.md)                                                                                                                                |
| `suppression-hygiene` | [docs/gates/suppression-hygiene.md](docs/gates/suppression-hygiene.md)                                                                                                              |
| `compose-lint`        | [docs/gates/compose-lint.md](docs/gates/compose-lint.md)                                                                                                                            |
| `db-gate`             | [docs/gates/db-gate.md](docs/gates/db-gate.md), plus [upgrade-path.md](docs/gates/upgrade-path.md) and [capacity.md](docs/gates/capacity.md) for the replay and the ramp it can add |

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

**`warn` is advisory and cannot fail a build.** `oxlint` exits 0 with warnings
outstanding, and no `--max-warnings` is passed anywhere in this repo's CI. So the
deny tier is the gate and the warn tier is a report: a rule that has to hold goes
to `error`, and a rule at `warn` is a hint whose count nobody is required to
drive to zero. Moving something from `warn` to `error` is the whole of the
decision — there is no middle setting that stops a merge.

A config's own `plugins` array replaces oxlint's built-in defaults rather than
adding to them, which is why the base names every plugin it wants including the
defaults `oxc`, `unicorn` and `typescript`. Across `extends` the arrays are
unioned, so a repo that adds `plugins` of its own keeps the base's.

The one rule the base switches off is `oxc/no-map-spread`, whose advice is to
mutate in place — wrong for the copy-on-write style these codebases are written
in.

### The escape hatches, and their price

Every way of telling the compiler or the linter to look away is denied, because
each one converts a question into silence:

- `typescript/no-explicit-any` — `unknown` forces the narrowing that `any`
  skips, and the unsafe-`any` family below only fires on values that are already
  `any`.
- `typescript/no-non-null-assertion` — `!` asserts an invariant to the compiler
  and to no one else. `noUncheckedIndexedAccess` is on, so array and record reads
  are the common case: handle the `undefined` or prove it away with a check.
- `typescript/ban-ts-comment` — `@ts-ignore` and `@ts-nocheck` are out;
  `@ts-expect-error` is allowed with a description of at least 12 characters,
  which is long enough that a real reason fits and `// @ts-expect-error fix` does
  not.
- `no-empty` — an empty block is either a swallowed failure or a deliberate
  no-op, and only one of those is defensible. A comment inside the block
  satisfies the rule, so an intentionally empty `catch` says what it is
  intentionally ignoring.
- `unicorn/no-abusive-eslint-disable` — a bare `oxlint-disable` with no rule
  named turns off everything on that line, including the rules nobody has written
  yet.
- `eslint/no-warning-comments` — `TODO`, `FIXME`, `XXX` and `HACK` anywhere in a
  comment. The register is GitHub issues in the repo the work belongs to; a
  marker in a file is invisible to anyone who is not already reading that file.

### Overrides

Two facts are true of a file because of where it sits, not what it contains:

```json
{
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.test.tsx"],
      "rules": {
        "no-restricted-globals": [
          "error",
          { "name": "setTimeout", "message": "…" },
          { "name": "setInterval", "message": "…" }
        ]
      }
    },
    { "files": ["src/server/**", "server/**", "apps/api/**"], "rules": { "no-console": "error" } }
  ]
}
```

A test that sleeps is slow and flaky, so tests drive virtual time instead of the
wall clock. And server code writes through the structured logger, so `no-console`
rises from `warn` to `error` on the server globs — a one-shot CLI under those
paths carries a file-level disable with its reason, which is the shape the
directive rule below already requires.

`overrides` survive `extends`, so a consuming repo inherits both without naming
them.

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

A disable without a reason is a suppressed bug, and the `suppression-hygiene`
action fails a run over one. The directive has to be one line — a wrapped second
comment line becomes the "next line" and the suppression misses.

The lint script also passes
`--report-unused-disable-directives-severity=error`, which turns a directive that
no longer suppresses anything into a failure. Without it, a disable outlives the
finding it was written for and quietly widens: the rule it names stops applying
to that line for the next person who writes there.

Type-aware rules need resolved types, so a repo whose types come from generated
code runs its codegen before linting, exactly as it does before `tsc`.

### What the linter cannot see

oxlint ships `jest` and `vitest` rule sets, and none of them fire on a `bun test`
suite: they key off imports from `jest`/`vitest`, and these repos import from
`bun:test`. Turning them on produces a config that reports nothing and looks like
coverage.

So the properties those rules would have checked — that a test asserted
something, that nothing was skipped — are enforced by the JUnit greps in the
`test-suite` action instead, on the report of a run that actually happened. That
is the correct layer and the only one available: do not "improve" the gate by
moving it into the linter.

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
    "boundaries/dependencies": [
      "error",
      {
        "default": "allow",
        "policies": [
          {
            "from": { "element": { "type": "domain" } },
            "disallow": [{ "to": { "element": { "type": "http" } } }],
            "message": "domain must not import http"
          }
        ]
      }
    ]
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
rather than a report. Two properties of it cost a probe to discover: the breach
is not printed — a run that reports every test passing and still exits 1 is
this — and the threshold is applied to **every file**, not to the total. So the
floor goes below the least-covered file, and a repo whose summary line reads 86%
can still be failing on one file at 64%.

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

Two families move as a unit rather than as packages. Every `expo*`,
`@expo/*` and `react-native*` pin belongs to one Expo SDK release, and a partial
bump builds and then fails on a device, so they group into one "Expo SDK" PR that
is never automerged. `better-auth` and its `@better-auth/*` plugins are versioned
in lockstep, and a plugin ahead of its core fails at import.

The file is named `default.json` because that is the name Renovate resolves for a
bare `github>owner/repo`; `renovate.json` as a preset name is deprecated.

### The pinned-binary custom manager

Every other pin in these repos sits somewhere a manager already looks. A released
binary pinned by tag and archive checksum sits in a `run:` block, which no
built-in manager reads, so the preset adds a `customManagers` entry — one entry
for every tool pinned this way, because the dependency names itself in a comment
directly above the pair:

```json
{
  "customType": "regex",
  "managerFilePatterns": [
    "/^\\.github/workflows/[^/]+\\.ya?ml$/",
    "/^\\.github/actions/[^/]+/action\\.ya?ml$/",
    "/^\\.github/actions/_lib/[^/]+\\.sh$/"
  ],
  "matchStrings": [
    "# renovate: datasource=(?<datasource>\\S+) depName=(?<depName>\\S+)\\s+\\w+_VERSION[:=] ?(?<currentValue>v\\S+)\\s+\\w+_SHA256[:=] ?(?<currentDigest>[0-9a-f]{64})"
  ]
}
```

```yaml
env:
  # renovate: datasource=github-release-attachments depName=owner/tool
  TOOL_VERSION: v1.2.3
  TOOL_SHA256: <sha256 of the release archive>
```

A tool more than one caller needs is fetched by a shell library under
`.github/actions/_lib/` instead, and the pin goes there — beside the fetch, so
it is written once however many callers there are. The one manager reads a shell
assignment as readily as a YAML key:

```sh
# renovate: datasource=github-release-attachments depName=owner/tool
TOOL_VERSION=v1.2.3
TOOL_SHA256=<sha256 of the release archive>
```

`_lib/k6.sh` is the live one: db-gate's ramp, this repo's own execution of the
shipped script, and `project-template`'s ramp against a preview stack are three
callers of one pin, and a ramp is only comparable with another ramp of the same
k6.

The shape above is illustrative on purpose: this file is not in the manager's
patterns, so a real version and checksum written here would be the one pin
nobody moves. The live ones sit in `.github/actions/secret-scan/action.yml`,
`.github/actions/lint-workflows/action.yml` and `.github/actions/_lib/k6.sh` —
all of which the patterns cover, and they cover the next tool without touching
the preset.

One pin does live in this README and is managed: the `GITLEAKS_VERSION=` line in
the local install snippet below, which carries no checksum and has a second,
tiny manager of its own.

The datasource is what makes this safe. `github-releases` would move the version
and leave the checksum, and a version bumped past a stale `sha256sum -c` fails
every CI run until someone hashes the archive by hand.
`github-release-attachments` instead searches the current release for the file
the current checksum belongs to — matching the line in `*_checksums.txt` — then
reads the same file's line out of the new release's checksums file. The version
and the checksum are one dependency with one `replaceString` spanning all three
lines, so they cannot land apart.

Finding the release means `currentValue` has to be a tag: a bare `8.30.1` is a
404 on `releases/tags/`, which drops the update. So the pin is written `v8.30.1`
and the URL strips the prefix for the asset name.

### Gating this repo

This repo runs its own gates on itself, from the working tree — a gate its
author's repo cannot pass is a gate nobody should be asked to — and then
typechecks, lints, formats and tests the code that implements them, parses every
JSON file, validates the preset, checks the Lighthouse budget, and lints the half
of it that executes.

Three contract facts are exempted in `ci.yml`, each structural: the configs
inherit from this repo's own bases by relative path because a package cannot
extend itself by name, CI is that file rather than a call into `check.yml`
because a commit cannot pin its own SHA, and there is no runtime environment to
shape.

The gates are TypeScript under `.github/actions/*/`, and `bun test` is what
proves each one refuses a violating tree and passes a clean one — the suites
build a real git repository per case, because the gates ask git what is tracked
and what is ignored. Every other repo's gate is only as honest as those two
lanes, which is why they run first.

The replay suite needs a real Postgres, since what it asserts is what two
databases end up holding. CI publishes one as a service on 5432, which is where
the suite looks unless `TEST_DATABASE_URL` says otherwise; locally that is

```sh
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
```

It creates and drops databases on whatever it is pointed at, so point it at a
throwaway. Two runs may share one: every name either the suite or the gate puts
on that server carries what tells the runs apart — the process for the suite's
own databases, the checkout being replayed for the gate's.

The linting is the `lint-workflows` action — actionlint, pinned by version and
archive checksum exactly like gitleaks, with shellcheck over every `run:` block.
It runs here from the working tree, and `check.yml` runs it for every consuming
repo, so a scaffolded repo's own workflows are held to the same schema and the
same pins as this one's.

actionlint only understands workflows: handed an `action.yml` it reports a
workflow with no `jobs`. So the composites get a pass of their own, asserting
what silently breaks them — a `run` step with no `shell` never runs the script
it carries — and their scripts go through the same shellcheck.

actionlint is also silent on a floating tag, so the action carries a second step
that reads every `uses:` in the workflows, in the composite actions, and in
`extra-paths`, and fails anything whose ref is not a 40-character commit SHA. A
tag is a name its owner can repoint at any commit, including after the version
was read here. Only a local `./…` reference is skipped, because it is this
repo's own tree at this commit and has no ref to pin.

The images a job runs are read the same way: a `docker://` action, a job's
`container:` in either spelling, every `services.*.image`, and the `runs.image`
of a Docker container action. Each is held to the digest rule — `@sha256:` and
not a tag — since an image is as much of a dependency as an action is, and its
tag moves whenever it is repushed. An action's `runs.image` that names a
`Dockerfile` is skipped: that is a build from this tree at this commit, with no
registry reference to pin.

There is no standalone `renovate-config-validator` package on npm; the binary
ships inside `renovate`:

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
    uses: gokayo43/dev-config/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      build: true
      database: true
```

| Input                 | Default                            | Effect                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`               | `false`                            | Runs `bun run build` before the static gate and before the boot gate.                                                                                                                                                                          |
| `database`            | `false`                            | Adds the database job: an empty Postgres, the migrations replayed onto it twice, the app booted against the result, and a k6 ramp over every route it serves. Also makes `db:migrate` part of the repo contract.                               |
| `compose`             | `false`                            | Holds `docker-compose.yml` to the deployment shape.                                                                                                                                                                                            |
| `upgrade-gate`        | `false`                            | Also proves that a database upgraded from the base ref's migrations reaches the schema a fresh one gets. Needs `database: true`; for repos whose database is deployed.                                                                         |
| `contract-exemptions` | `""`                               | Repo-contract facts this repo is structurally unable to satisfy, space-separated. A marketing site names `docs-spine`; a repo being wound down names `lifecycle-retire`.                                                                       |
| `stack-allowlist`     | `""`                               | Packages this repo keeps against the stack denylist, as `<package> -- why` entries, one per line; an entry is refused when it carries no reason, when nothing here declares the package any more, or when the denylist has stopped denying it. |
| `start-command`       | `bun run start`                    | How the boot gate starts the app.                                                                                                                                                                                                              |
| `health-url`          | `http://localhost:3000/api/health` | What the boot gate polls until it answers 200.                                                                                                                                                                                                 |
| `timestamp-allowlist` | `""`                               | `schema.table.column -- why` entries whose value really is a wall-clock reading rather than an instant, one per line; one without a reason is refused.                                                                                         |
| `capacity-path`       | `""`                               | Paths to ramp alongside the health route, one per line.                                                                                                                                                                                        |
| `capacity-script`     | `""`                               | A k6 script of the repo's own, replacing the shipped ramp.                                                                                                                                                                                     |
| `db-gate-evidence`    | `db-gate-evidence`                 | The artifact name for the k6 summary, the two route-log snapshots and the app's output, for a matrix that runs more than one leg.                                                                                                              |
| `route-allowlist`     | `""`                               | Routes the ramp cannot cover, as `METHOD /path -- why` entries, one per line; one without a reason, and one the ramp did reach, are both refused.                                                                                              |
| `test-suite-evidence` | `test-suite-evidence`              | The artifact name for the junit report, for a matrix that runs more than one leg.                                                                                                                                                              |

Both evidence names default to a constant, and an artifact name may be claimed
once per run — so a caller that runs `check.yml` as a **matrix** has to give each
leg its own `db-gate-evidence` and `test-suite-evidence`, or the second leg to
upload fails on the duplicate. The two have to differ from each other as well as
between legs: one value used for both hands a single leg's static and database
jobs the same artifact name, which is the same collision one job later. Prefix
with the input's own name — `db-gate-evidence-<leg>` — and both are covered.

The defaults are constants deliberately: the alternative is deriving them from
the matrix index, which GitHub does not
document as reachable from inside a composite action, and a context that is not
reachable evaluates to an empty string rather than to an error — so the derived
name would collide exactly as quietly as the constant, with a trailing dash.

Six inputs are aimed at steps of the database job — `upgrade-gate`,
`capacity-path`, `capacity-script`, `db-gate-evidence`, `route-allowlist` and
`timestamp-allowlist` — and each fails the run when passed with
`database: false`, saying which: being quietly ignored is how a ramp somebody
asked for turns out never to have run.

The call is pinned by commit SHA with the release as the trailing comment — the
same contract the actions inside it carry, and the reason a change here reaches
a repo when its pin moves and not before. The example above is deliberately not
a real SHA: nothing keeps a README snippet current, so the pin worth copying is
the live one in `project-template`'s `setup/ci.single.yml` or
`setup/ci.monorepo.yml`. Renovate's github-actions manager
reads a job-level `uses:` exactly as it reads a step's, so the pin moves in a PR
like any other dependency.

In order, the pinned workflow runs the gitleaks scan, the declarative gates
(repo contract, stack denylist, suppression hygiene, and the compose lint when
asked), `bun install`, the optional build, `format:check`, `lint`, `typecheck`,
`knip`, the test suite, and the assertion that the suite ran. Everything from
`format:check` to the test suite is the local `bun run check`, so a green
pre-push is a green CI run; the rest is what only CI has.

The declarative gates come before `bun install` deliberately. They read the tree
as committed, so a repo that has drifted out of the contract says so in seconds
rather than after a full dependency resolution.

The steps that are shell or a script rather than a `bun run` live in
`.github/actions/` as composite actions — `secret-scan`, `repo-contract`,
`stack-gate`, `suppression-hygiene`, `compose-lint`, `test-suite`, `db-gate`,
`lint-workflows` — so the workflow above and any
repo that has to run the same thing outside it share one copy.
`check.yml` references them by full path and SHA rather than `./`: inside a
called workflow a relative `uses:` resolves against the _caller's_ checkout, and
the alternative — checking this repo out into the caller's workspace — puts its
files under the caller's linter, which is a real failure and not a theoretical
one. Renovate reads the self-reference like any other action pin and keeps it
current.

The matching scripts:

```json
{
  "scripts": {
    "format": "oxfmt",
    "format:check": "oxfmt --check",
    "lint": "oxlint --report-unused-disable-directives-severity=error",
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
digest pins are — the version string beside it is the label, and the preset's
pinned-binary manager moves the two in one PR.

The fetch behind it retries, and fetches each pin once per job. A release CDN
resets a connection now and then — this pipeline has taken one — and that is a
retry rather than a supply-chain event; the checksum is still what decides
whether what arrived is the pinned artefact, however many attempts it took. A
job with two callers for one tool downloads it once: the second finds a receipt
naming the checksum already verified, and a caller asking for a different pin
fetches again. A fetch that dies part-way takes the receipt with it, so the next
caller re-fetches rather than trusting a claim about a tool that is not there.

`fetch-depth: 0` is what makes the scan worth running. `gitleaks git` reads
history, and the default shallow checkout hands it exactly one commit — a secret
committed and then deleted further along the same branch would go unreported,
even though pushing it had already burned the key. A full-history scan costs
about a second on repos this size. Since the checkout belongs to the caller and
the scan does not, the action asks git whether the clone is shallow and fails
with that instruction rather than scanning one commit and reporting nothing.

`working-directory` defaults to the checkout, which is the whole story for a
repo gating itself. A caller that generates a tree and then gates it — the
template's scaffolder is the one here — points this at that tree as well: a
secret written by a generator is in no commit the checkout's scan will ever
read.

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

### Where each gate is written down

`repo-contract`, `stack-gate`, `suppression-hygiene`, `lint-workflows` and
`compose-lint` run in the static job; `db-gate` is the database job, and the
capacity ramp is a step of it. Each has its page under
[`docs/gates/`](docs/gates/), listed in the table at the top of this file.

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
