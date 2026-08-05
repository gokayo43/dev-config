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
    "/^\\.github/actions/[^/]+/action\\.ya?ml$/"
  ],
  "matchStrings": [
    "# renovate: datasource=(?<datasource>\\S+) depName=(?<depName>\\S+)\\s+\\w+_VERSION: (?<currentValue>v\\S+)\\s+\\w+_SHA256: (?<currentDigest>[0-9a-f]{64})"
  ]
}
```

```yaml
env:
  # renovate: datasource=github-release-attachments depName=owner/tool
  TOOL_VERSION: v1.2.3
  TOOL_SHA256: <sha256 of the release archive>
```

The shape above is illustrative on purpose: this file is not in the manager's
patterns, so a real version and checksum written here would be the one pin
nobody moves. The live ones sit in `.github/actions/secret-scan/action.yml` and
this repo's own CI, which the patterns do cover, and it covers the next tool
without touching the preset.

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

The linting is the `lint-workflows` action — actionlint, pinned by version and
archive checksum exactly like gitleaks, with shellcheck over every `run:` block —
used here from the working tree and by the template repo at a SHA, so the pin has
one home.

actionlint only understands workflows: handed an `action.yml` it reports a
workflow with no `jobs`. So the composites get a pass of their own, asserting
what silently breaks them — a `run` step with no `shell` never runs the script
it carries — and their scripts go through the same shellcheck.

actionlint is also silent on a floating tag, so the action carries a second step
that reads every `uses:` in the workflows, in the composite actions, and in
`extra-paths`, and fails anything whose ref is not a 40-character commit SHA. A
tag is a name its owner can repoint at any commit, including after the version
was read here. Local (`./…`) and `docker://` references carry no git ref and are
skipped.

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

| Input                 | Default                            | Effect                                                                                                                                                                     |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`               | `false`                            | Runs `bun run build` before the static gate and before the boot gate.                                                                                                      |
| `database`            | `false`                            | Adds the database job: an empty Postgres, the migrations replayed onto it twice, and the app booted against the result. Also makes `db:migrate` part of the repo contract. |
| `compose`             | `false`                            | Holds `docker-compose.yml` to the deployment shape.                                                                                                                        |
| `contract-exemptions` | `""`                               | Repo-contract facts this repo is structurally unable to satisfy, space-separated. A marketing site names `docs-spine`.                                                     |
| `start-command`       | `bun run start`                    | How the boot gate starts the app.                                                                                                                                          |
| `health-url`          | `http://localhost:3000/api/health` | What the boot gate polls until it answers 200.                                                                                                                             |
| `timestamp-allowlist` | `""`                               | `table.column` entries whose value really is a wall-clock reading rather than an instant.                                                                                  |

The call is pinned by commit SHA with the release as the trailing comment — the
same contract the actions inside it carry, and the reason a change here reaches
a repo when its pin moves and not before. The example above is deliberately not
a real SHA: nothing keeps a README snippet current, so the pin worth copying is
the live one in `project-template`'s `setup/ci.yml`. Renovate's github-actions manager
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
`lint-workflows`, `queue-guard`, `queue-audit` — so the workflow above and any
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

`fetch-depth: 0` is what makes the scan worth running. `gitleaks git` reads
history, and the default shallow checkout hands it exactly one commit — a secret
committed and then deleted further along the same branch would go unreported,
even though pushing it had already burned the key. A full-history scan costs
about a second on repos this size. Since the checkout belongs to the caller and
the scan does not, the action asks git whether the clone is shallow and fails
with that instruction rather than scanning one commit and reporting nothing.

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

### The repo contract

Every gate above rests on a string somewhere: a `packageManager` field, an
`extends` path, a `[test]` block, a hook definition. Each of those can be
deleted, renamed or never written, and when one is, the gate it feeds does not
fail — it stops existing. `repo-contract` reads them and says so.

| Fact                                                                                                            | Why it is load-bearing                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packageManager` reads `bun@<version>`                                                                          | `setup-bun` takes the runner's Bun from it; without it CI and the dev machine drift               |
| No `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`                                                         | a second lockfile installs a second dependency tree                                               |
| Every spec outside `peerDependencies` resolves to one thing                                                     | a lockfile refresh must not be able to change what is installed                                   |
| `typescript` major ≥ 7                                                                                          | the shared tsconfig is written against TypeScript 7                                               |
| `oxlint-tsgolint` present, when `.oxlintrc.json` extends the base                                               | without it oxlint runs the base's type-aware rules over nothing and reports clean                 |
| `tsconfig.json` extends this repo, `.oxlintrc.json` extends this repo, the knip config imports `knip.base.ts`   | a repo that stopped inheriting stops inheriting silently                                          |
| `bunfig.toml` declares `minimumReleaseAge`, `saveExact`, and a `[test] coverageThreshold`                       | the supply-chain window and the coverage floor are per-repo copies with no `extends` to hold them |
| `lefthook.yml` runs a staged gitleaks scan pre-commit and typecheck + tests pre-push                            | the hooks are the half of the gate that runs before a push                                        |
| `.env` untracked and ignored, `.env.example` tracked, neither `.env.example` nor `.env.enc` caught by a pattern | a blanket `.env.*` rule silently deletes the two files that have to ship                          |
| `CONTEXT.md` (or `CONTEXT-MAP.md`), `docs/adr/`, `CLAUDE.md`                                                    | the docs spine                                                                                    |
| `db:migrate` exists, when `database: true`                                                                      | the database gate replays migrations through it                                                   |
| a job `uses:` this repo's `check.yml` at a 40-hex SHA                                                           | a tag is a name someone else can repoint                                                          |

The knip case is the one that reads as arbitrary and is not: knip resolves
`knip.json` before `knip.ts`, and a JSON config cannot import anything. A repo
that answers "why isn't the shared base applying?" by adding a `knip.json`
produces a config that works and inherits nothing, so the JSON forms are refused
outright rather than merely unrecommended.

The pin check is an allowlist rather than a list of the ways a spec can float.
`^1.2.3` is the obvious one; `18`, `next`, `1.x`, `*` and `latest` float exactly
as much, and the set of spellings is open-ended. So a spec passes only by
proving it resolves to one thing: an exact semver, or a protocol that is exact
by construction — `workspace:`, `file:`, `link:`, `catalog:`, an `npm:` alias
whose own spec is exact, or a git dependency **carrying a ref**. A
`github:owner/repo` with no `#ref` is a branch that moves, and it is refused.

### Exemptions

Some facts a repo cannot satisfy because of what it is, not because nobody got
round to it — this repo cannot extend itself by package name, and its CI cannot
pin a commit it is in the middle of making. Those are named at the call site:

```yaml
with:
  contract-exemptions: config-lineage ci-call secrets
```

| Exemption        | Waives                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `config-lineage` | _where_ the configs inherit from — not whether they exist                 |
| `ci-call`        | the SHA-pinned call into `check.yml`                                      |
| `docs-spine`     | the glossary, `docs/adr/` and `CLAUDE.md`                                 |
| `secrets`        | the `.env` / `.env.example` shape, for a repo with no runtime environment |

Every exemption is echoed as a `::notice` in the run, and a name outside the
table fails rather than waiving anything — a typo cannot quietly turn a check
off. The list is the whole mechanism: there are no per-repo special cases inside
the gate.

The gate reads tracked files plus untracked ones git would keep — the set
`.gitignore` already describes. That is what lets it run against a tree a
scaffolder has just written into, where every new file is untracked, without
reading build output.

### The stack denylist

`STACK.md` picks one library per slot. `stack-gate` is that document with an exit
code: one `stack-denylist.json` in this repo, read against every `package.json`
in the tree.

An entry is a set of package names and the reason they lost, so the diagnostic
teaches the rule rather than only refusing the package:

```
::error file=package.json::dependencies.dayjs is not the house pick — Temporal on the server, @date-fns/tz in the client
```

An entry lists `names`, matched exactly, and `patterns`, which are regular
expressions over the package name. Two fields rather than one convention,
because the distinction is load-bearing in both directions: `^@radix-ui/` has to
take a whole scope, and `jest` must not take `jest-expo` — the Expo test preset
is the only way to run a React Native suite, and it is not the thing the entry
is about.

One kind of pick is a judgement call rather than a rule, and its entry carries an
`adr` glob: the packages unlock once that file exists. Client state management is
the case the canon names. The escape hatch is deliberately the same work as
writing the decision down, which is the only form of exception worth having.

### Suppression hygiene

Two ways work hides in a tree rather than in the queue, both a failed step:

- a lint directive with no ` -- reason` after the rule names, in either
  spelling: oxlint honours `eslint-disable` exactly as it honours
  `oxlint-disable`, so a gate that knew only its own name left the other one
  unreasoned and unreported.
- a tracked `TODO.md`, `BACKLOG.md`, `TASKS.md`, `ISSUES.md` or `ROADMAP.md`.

The second one is not about the filename. A list in a file has no labels, no
assignee, no close, and no one who has agreed to drain it; the register is GitHub
issues in the repo the work belongs to, and a second register is deletion that
feels responsible.

A suite that tests this gate necessarily contains directives that are fixture
text rather than suppressions. Those files are named in the `fixtures` input —
narrower than teaching the scan enough TypeScript to tell a comment from a
string literal, and visible in the caller's diff rather than hidden in a
heuristic.

### Repos this box runs as containers

`compose: true` reads `docker-compose.yml` and holds it to the deployment shape
every stack on this box shares:

- every published port bound to `127.0.0.1` — nginx is the only thing that should
  reach them, and the host firewall is not the only line of defence.
- a `mem_limit` on every service — several unrelated stacks share the box, and
  without caps the kernel OOM killer picks its victim by score rather than by who
  caused the spike.
- a healthcheck on every service, or `x-no-healthcheck: "<why it can never answer
one>"`. A one-shot job that exits is the honest case; "we did not get round to
  it" is the case the key is there to make visible.
- a `migrate` service with `restart: "no"`, and every service that builds from
  this repo waiting on it with `condition: service_completed_successfully`. A
  failed migration then keeps the old container running rather than starting a
  new one against a schema it does not match, and a restart policy on a migration
  is a crash loop.

Services that only pull an image are infrastructure and are not asked to wait on
the migration they host.

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

The database is then asked directly, through `information_schema.columns`,
whether any column is `timestamp without time zone` — an ORM's `timestamp` is a
hint and the database is the fact, and it will answer without anything having to
parse a schema dump. A wall-clock
column stores the digits someone typed and forgets which clock produced them, so
one row means two different instants either side of a DST boundary or a server
move, and nothing fails until it does. `timestamp-allowlist` takes
`table.column` entries for the columns where a wall-clock reading is the point —
an opening time that is 09:00 wherever the shop is.

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

## Queue integrity

The issue queue is the register for everything not being done right now, and it
decays quietly: a label outside the vocabulary, an issue in no state, a
commitment whose trigger nobody wrote down. Two reusable workflows hold it.

Two triggers, so two files: one `if:` at a call site to sort out which half of
a merged workflow is meant to run is a branch that only exists because the
files were merged.

```yaml
# .github/workflows/queue-promotion.yml
name: Queue promotion
on:
  issues:
    types: [labeled]
permissions:
  contents: read
jobs:
  guard:
    permissions:
      contents: read
      issues: write
    uses: gokayo43/dev-config/.github/workflows/queue-guard.yml@<commit sha> # <release tag>
```

```yaml
# .github/workflows/queue-weekly.yml
name: Queue weekly
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  audit:
    permissions:
      contents: read
      issues: read
    uses: gokayo43/dev-config/.github/workflows/queue-audit.yml@<commit sha> # <release tag>
```

`queue-guard` takes the promotion back when anyone but the repo owner adds
`ready-for-agent` or `ready-for-human`: the label comes off, the issue gets a
comment saying why, and the run still fails. Agents file proposals freely and
never approve their own; the `labeled` event carries the actor, so that rule is
enforced rather than reported, and the invalid state does not survive the run.
The caller grants the job `issues: write` for exactly that reason.

`queue-audit` reads the labels and every open issue on a schedule and asserts
three things: the vocabulary is exactly the canon set and nothing else, every open
issue carries exactly one state label, and every issue labelled `commitment`
states a `**Trigger:**` in its body. Its inputs carry the canon defaults:

| Input              | Default                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `vocabulary`       | `needs-triage needs-info ready-for-agent ready-for-human roadmap commitment wontfix` |
| `state-labels`     | `needs-triage needs-info ready-for-agent ready-for-human roadmap wontfix`            |
| `commitment-label` | `commitment`                                                                         |

`commitment` is the marker orthogonal to the state machine: a commitment is
already in one of the six states, and the label is how the issues with a trigger
are found on the day their trigger may have fired. GitHub's own starter labels —
`bug`, `enhancement`, `duplicate` and the rest — are a taxonomy nobody drains, so
the audit refuses them; the scaffolder deletes them when it creates the canon
set.

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
