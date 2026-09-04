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
| `anti-slop/`                   | `oxlint`       | `jsPlugins` in `oxlint.base.json`          |
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
| `shell-scripts`       | [docs/gates/shell-scripts.md](docs/gates/shell-scripts.md)                                                                                                                          |
| `compose-lint`        | [docs/gates/compose-lint.md](docs/gates/compose-lint.md)                                                                                                                            |
| `db-gate`             | [docs/gates/db-gate.md](docs/gates/db-gate.md), plus [upgrade-path.md](docs/gates/upgrade-path.md) and [capacity.md](docs/gates/capacity.md) for the replay and the ramp it can add |
| `mutation-lane`       | [docs/gates/mutation-lane.md](docs/gates/mutation-lane.md)                                                                                                                          |
| `test-suite`          | [docs/gates/test-suite.md](docs/gates/test-suite.md)                                                                                                                                |

Beside the gates CI runs are the modules a consuming repo **imports**. A gate
refuses a tree from the outside; an export is code the repo calls, and it is the
shape a rule takes when what it grades is only visible from inside the repo — an
app's own route table, its own limiter, its own browser. Each is in `files` and
`exports`, and each has a page of its own:

| Export                                                            | Imported by                    | What it holds                                                          |
| ----------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| [`route-log.ts`](docs/exports/route-log.md)                       | the app, for the capacity ramp | the protocol between an app and the route-coverage floor               |
| [`invariant-sweep.ts`](docs/exports/invariant-sweep.md)           | the Playwright specs           | zero console errors and no sideways scroll, on every page a test opens |
| [`limiter-conformance.ts`](docs/exports/limiter-conformance.md)   | the rate limiter's own suite   | STACK's rate-limit rule, executable                                    |
| [`response-schema.ts`](docs/exports/response-schema.md)           | the API's own suite            | every Elysia route declares a `response` schema, or is a named skip    |
| [`characterization-net.ts`](docs/exports/characterization-net.md) | a golden suite and its updater | the harness rules that keep a large golden net honest                  |

Gate code is deliberately **not** importable by the repos it gates — a gate in
`node_modules` runs only if the repo's workflow remembers to, and it moves
whenever the lockfile does. Anything a repo calls directly is one of these
instead.

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

The base sets `correctness: error`, `suspicious: error`, `perf: warn`,
`no-console: error`, and the hooks rules — which oxlint configures under the
`react` plugin as `react/rules-of-hooks` and `react/exhaustive-deps`, both at
`error`. Their diagnostics are labelled `react-hooks`, but there is no
`react-hooks` plugin to name in a config, and a config naming one silently lints
nothing.

`suspicious` denies rather than warns because every repo here is template-born
and greenfield: there is no inherited violation count for a warn tier to report
on, so it would only be a list nobody is required to drive to zero. A rule in
that tier which is genuinely wrong for a repo becomes a disable carrying its
reason, or an `overrides` entry — both visible, and both expiring the moment the
finding does.

**`warn` is advisory and cannot fail a build.** `oxlint` exits 0 with warnings
outstanding, and no `--max-warnings` is passed anywhere in this repo's CI. So the
deny tier is the gate and the warn tier is a report: a rule that has to hold goes
to `error`, and a rule at `warn` is a hint whose count nobody is required to
drive to zero. Moving something from `warn` to `error` is the whole of the
decision — there is no middle setting that stops a merge.

Which is why almost nothing is left at `warn`. `no-console` and
`typescript/prefer-nullish-coalescing` were both advisory and are now denied: a
stray `console.log` and a `||` that should have been `??` are each a decision, not
a taste. The `perf` **category** is the one deliberate exception, and it stays
advisory for a reason that does not generalise — a perf rule's advice is a claim
about shared state and input size the rule cannot see, so at `error` it would be
answered by disables carrying a measurement nobody took. `no-await-in-loop` is
that tier's general case, off outright a few lines below rather than warned. The
exception is graded by severity in `tests/lint-policy.test.ts`, so promoting the
tier is a decision someone has to take deliberately rather than tidily.

A config's own `plugins` array replaces oxlint's built-in defaults rather than
adding to them, which is why the base names every plugin it wants including the
defaults `oxc`, `unicorn` and `typescript`. Across `extends` the arrays are
unioned, so a repo that adds `plugins` of its own keeps the base's.

The rules the base switches off: `no-await-in-loop` (a sequential loop is
usually the correct one here, and the fan-out it asks for is a design call about
shared state the rule cannot see), `react/react-in-jsx-scope` (the automatic JSX
runtime imports nothing), `oxc/no-map-spread` (its advice is to mutate in place,
wrong for the copy-on-write style these codebases are written in), and
`typescript/no-unsafe-type-assertion` (a subset of the rule below it, which is
why it is stated only where that one is off). Then, in an override:
`unicorn/consistent-function-scoping` and
`typescript/consistent-type-assertions` in a suite, and
`anti-slop/no-unnamed-effects` under `hooks/`. The reason in full sits beside
each entry, which is where the repo contract requires it — see
[the repo contract](docs/gates/repo-contract.md). No count is given here on
purpose: a number in prose is one nobody updates, and the list is the answer.

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
- `typescript/no-restricted-types` — `Record<string, unknown>` and
  `Record<string, any>`. The bag with no keys is how a shape nobody modelled
  travels: it type-checks everywhere and asserts nothing. It is legal exactly
  once per boundary, as a **named alias at the module that owns that boundary**,
  carrying one disable with the why — `type ConfigObject = Record<string,
unknown>` in `_lib/gate.ts` here, for config files this repo reads and does
  not own. Everything else is one of: model the shape, parse the input, or
  delete the cast. A fleet-wide escape alias re-exported everywhere is the one
  thing this must not become; the linter cannot see the difference, so review
  does. Inline `{ [k: string]: unknown }` is not matched — the rule reads type
  references, not shapes — but `anti-slop/no-unsafe-dictionary-type` below is,
  and catches it along with aliases and mapped types.
- `typescript/consistent-type-assertions`, at `assertionStyle: "never"` — an
  assertion tells the compiler to stop checking at the one place the answer was
  still available. An annotation makes the same claim and is checked, and
  `satisfies` makes it without widening. `as const` is not an assertion in this
  sense and stays legal, whatever the literal-shaped options beside it say: it
  narrows a literal rather than overriding an inference. A suite is where the
  rule is off — see the overrides below, and with it goes the only reason
  `typescript/no-unsafe-type-assertion` is stated at all: that rule refuses the
  subset of assertions that widen or narrow unsafely, so wherever the stronger
  one is on it is a second name on every disable and a reader of one cannot tell
  which fact it is about. It is therefore off at the top level and `error` in the
  suite override, where it is the whole of what still holds.
- `no-restricted-globals` — `__dirname`, `__filename` and `require`. Every repo
  here is ESM, where none of the three exists; the entries name the replacement
  (`import.meta.dir`, `import.meta.url`, `import`) so the diagnostic is the fix.
- `eqeqeq`, at `always` with `{ "null": "ignore" }` — `==` coerces instead of
  deciding, and the coercion table is the thing nobody has in their head. It sits
  in `pedantic`, which this base does not take, so it is stated. `null` is the
  one exception, and it is not a softening: `x == null` asks about both nullish
  values at once, which is a question `===` cannot put in one comparison and
  `x === null || x === undefined` answers at twice the length.
- `preserve-caught-error` — a `catch` that throws something new without passing
  the original as `cause` deletes the only record of what actually failed. It
  arrives through `suspicious`, and the base does not restate it: a rule the tier
  already denies is one the base agrees with, and restating those is a list with
  no end. `tests/lint-policy.test.ts` grades that the ban is live, through the
  tier that carries it.

### What the React Compiler declines to optimize

Every repo here builds with the React Compiler, which is why the memo pair below
is banned outright. The compiler earns that ban by optimizing what it can prove
pure — and it skips what it cannot, silently, per component. So the mandate was
the one stack pick nothing in the gate could see: a component that rolled a die
during render passed clean.

`react/react-compiler` is the rule that ends that, at `error`. It is one rule
covering what `eslint-plugin-react-hooks` splits across a dozen names, because
oxlint ports the **compiler** rather than the rules — there is no `react/purity`
to write, and a config that writes one is refused at parse time rather than
ignored. Which judgement was made is the prefix on the message:

| Judgement            | Prefix                 | The code it refuses                                            |
| -------------------- | ---------------------- | -------------------------------------------------------------- |
| purity               | `Purity:`              | `Math.random()`, `Date.now()` and friends called during render |
| immutability         | `Immutability:`        | writing through props, or through a value a hook returned      |
| set-state-in-render  | `RenderSetState:`      | a setter called in the render body                             |
| set-state-in-effect  | `EffectSetState:`      | a setter called synchronously in an effect body                |
| refs                 | `Refs:`                | reading or writing `.current` during render                    |
| globals              | `Globals:`             | reassigning a binding declared outside the component or hook   |
| static-components    | `StaticComponents:`    | a component declared inside another one's render               |
| error-boundaries     | `ErrorBoundaries:`     | JSX constructed inside a `try`, where its errors never land    |
| use-memo             | `UseMemo:`             | a dependency list that is not an array of simple expressions   |
| void-use-memo        | `VoidUseMemo:`         | a `useMemo` callback that returns nothing                      |
| preserve-manual-memo | `PreserveManualMemo:`  | a hand-written memo whose deps the compiler infers differently |
| hooks                | `Hooks:`               | a hook called conditionally, so the call order can change      |
| capitalized-calls    | `CapitalizedCalls:`    | a capitalized function called directly instead of rendered     |
| incompatible-library | `IncompatibleLibrary:` | an API returning functions that cannot be memoized safely      |
| (no rule upstream)   | `Invariant:`           | an upstream assertion — see below; not a judgement about you   |
| unsupported-syntax   | `Todo:`                | syntax the compiler stopped at — see the bail-outs below       |

Two of those need a word beyond the row.

`Hooks:` reports the same conditional call, at the same line and column, as
`react/rules-of-hooks`. Both stay anyway, which is the one place this base
accepts two rules over one line. The settling fact is that `rules-of-hooks`
catches a hook called from a function that is neither a component nor a hook —
and that function is not a component, so the compiler never analyses it and says
nothing. Dropping the older rule would trade a duplicated diagnostic for a
missing one. `react/exhaustive-deps` is beside them for the same reason: the
compiler's own `Effect` judgements do not report a missing dependency, and that
rule is the only thing that does.

`Invariant:` is the sharp edge, and it is not a judgement about your code at all.
A class declared inside a component draws `Invariant:
[InferMutationAliasingEffects] Expected value kind to be initialized` — an
upstream assertion firing, with no
user-facing rule behind it and no advice in the message. The fix is to hoist the
class to module scope, which is where a class wants to be regardless. It is in
the table's suite as a fixture so that the day upstream turns it into a real
diagnostic, the change is visible here rather than surprising in a consuming
repo.

#### The bail-outs

The last row is the one the rule is **configured** for rather than merely
switched on. A bail-out is not a violation: it is the compiler saying it declined
to optimize the whole component, so every memo it would have inserted is simply
absent. With `reportAllBailouts` off that is silent — exactly the components
nothing optimized are the ones that draw nothing — and every other row above
holds with the option missing, which is why the base configures the rule instead
of setting a bare `"error"`.

The construct the diagnostic names is usually a shape one of the house picks
already owns, so the fix is to restore the house shape rather than to disable the
rule; the diagnostic names the compiler's problem and never that shape, which is
the one thing to know before reading one. Measured against the fleet's real
React, all 22 bail-outs are two shapes: a `try`/`finally` in a component, and an
`await import(...)` inside one. A generator body and a logical assignment bail
out too and occur nowhere in the fleet.

Every row above is driven against a fixture in `tests/lint-policy.test.ts`,
`IncompatibleLibrary:` excepted — none of the shapes tried here provoked it, so
it carries the row a reader who hits it needs and no case claiming a check
nothing drives. A judgement oxlint's port stops carrying fails there rather than
going quiet under a rule name still switched on.

### The imports a pick has already answered

Four of the stack's picks are decisions about which import to reach for, and
this is where they stop being a thing to remember. Each diagnostic names **what
the import lost to**, because it is the only place the loser of that decision is
standing:

| Import                                                 | From                    | Where                 | Instead                                                 | Carrier                        |
| ------------------------------------------------------ | ----------------------- | --------------------- | ------------------------------------------------------- | ------------------------------ |
| `useMemo`, `useCallback`                               | `react`                 | everywhere            | the React Compiler inserts the memo; delete the wrapper | `no-restricted-imports`        |
| `beforeEach`, `afterEach`                              | `bun:test`              | everywhere            | a call the case makes itself, and `await using`         | `no-restricted-imports`        |
| `useEffect`, `useLayoutEffect`, `useSyncExternalStore` | `react`                 | outside `**/hooks/**` | a named hook whose name says what it subscribes to      | `anti-slop/no-unnamed-effects` |
| `useQuery`, `useInfiniteQuery`                         | `@tanstack/react-query` | under `**/routes/**`  | the loader's `ensureQueryData` and `useSuspenseQuery`   | `anti-slop/no-raw-query-hooks` |

The suspense pair, `beforeAll`/`afterAll`, and every other React hook are
untouched: what is banned is the name, not the module.

**Why two carriers.** A ban that holds in every file is an entry in
`no-restricted-imports`, which is what that rule is for. A ban a file's position
decides cannot be: an override REPLACES a list-shaped rule rather than adding to
it, so scoping one that way would take away every entry it did not restate — a
consuming repo's [own lock](#locking-a-settled-decision) among them, wherever the
block reached. A plugin rule's scalar `"off"` replaces only itself, so the two
positional bans are rules of the plugin and no block in the base redefines a
list-shaped rule at all. `tests/oxlint-base.test.ts` holds it to both halves.

The two carriers differ in what they can see, and both differences are graded in
`tests/lint-policy.test.ts`:

- The plugin rules follow the name past every spelling that reaches it without
  importing it — renamed, off a namespace, destructured off one, through
  `await import`, and re-exported from a barrel (`export { useEffect } from
"react"` is refused at the barrel, which is the end that can still tell). They
  also leave a **type-only** import alone: `import type { useEffect }` borrows
  the signature without reaching the value.
- `no-restricted-imports` refuses a namespace import and a renamed one, and
  refuses a type-only import as well, which it gives no way to allow. Neither
  `useMemo` nor `beforeEach` has a use as a type, so that costs nothing here —
  and the day a name on that list does, it is the carrier that has to change.

The grant is the directory, which is the limit both scoped rules carry: inside
`hooks/` every spelling of the effect trio is allowed, a barrel re-exporting it
included, exactly as `env.ts` may re-export what `no-env-access` refuses
everywhere else.

### Overrides

Some facts are true of a file because of where it sits, not what it contains:

```json
{
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
      "rules": {
        "unicorn/consistent-function-scoping": "off",
        "anti-slop/no-call-log-assertions": "error",
        "anti-slop/no-local-module-mocks": "error",
        "anti-slop/no-mock-assertions": "error",
        "anti-slop/no-real-timers": "error"
      }
    },
    { "files": ["src/server/**", "server/**", "apps/api/**"], "rules": { "no-console": "error" } },
    { "files": ["**/env.ts"], "rules": { "anti-slop/no-env-access": "off" } },
    {
      "files": ["**/*.test.ts", "**/*.spec.ts", "**/tests/**", "**/e2e/**"],
      "rules": {
        "anti-slop/no-env-access": "off",
        "typescript/consistent-type-assertions": "off",
        "typescript/no-unsafe-type-assertion": "error"
      }
    },
    { "files": ["**/routes/**"], "rules": { "anti-slop/no-raw-query-hooks": "error" } },
    {
      "files": ["**/hooks/**"],
      "rules": {
        "anti-slop/no-unnamed-effects": "off",
        "anti-slop/no-raw-query-hooks": "off"
      }
    }
  ]
}
```

A test file is where the four scoped rules of [the plugin](#the-anti-slop-plugin)
apply, and where a helper one `describe` uses belongs inside it rather than
hoisted to module scope. Server code writes through the structured logger, so
`no-console` rises from `warn` to `error` on the server globs — a one-shot CLI
under those paths carries a file-level disable with its reason, which is the shape
the directive rule below already requires. And `env.ts` is [the one module that
reads the environment](#the-environment-is-read-in-one-module), while a suite is
where a variable is set for a spawned process rather than read for its value, and
where a case asserts about a value nothing typed — which is why that block names
**directories** as well as suffixes: a suite's helpers are that same code one
file over, under no suffix at all.

The last two blocks are the [import bans](#the-imports-a-pick-has-already-answered)
that depend on where a file sits, each a scalar on a rule of its own. `hooks/`
comes last of the two, so that a hook colocated under `routes/` is graded as a
hook — an effect belongs there, and so does the fetch-on-interaction the raw
query pair is for — and a `routes/` directory nested under `hooks/` reads the
same way, for the same reason.

**An override replaces a rule's whole configuration; it does not add to it**
(oxc#12179). An override that says nothing about a rule inherits it whole, so the
cost lands only where one is redefined: an override restating a list-shaped rule
to change a single thing about it silently exempts every file it matches from
every entry it did not restate, in every repo extending the base. That is why the
two blocks above spell out every entry they owe their files rather than the one
they were written for, and `tests/oxlint-base.test.ts` is what keeps them honest
— it proves the semantics against a config it builds itself, then holds every
override that redefines a list-shaped rule to carrying every entry the top level
states.

The list an override replaces includes **the consuming repo's own entries**,
which is why no block in the base redefines one at all: any that did would take
every repo's [settled-decision lock](#locking-a-settled-decision) away wherever
it reached, from a file nobody in that repo is reading. A ban a file's position
decides is carried as a rule of its own instead, and `oxlint-base.test.ts` grades
both halves — that no override in the base states a list-shaped rule, and that a
repo's own lock survives inside the directories the base scopes a ban to.

`overrides` survive `extends`, so a consuming repo inherits both without naming
them.

### Locking a settled decision

A stack decision that has been made — this driver, not that one; this call, not
the property that silently does the wrong thing — is worth exactly as much as
the next person's memory of it. So it goes in the repo's own `.oxlintrc.json` as
a `no-restricted-properties`, `no-restricted-imports` or `no-restricted-globals`
entry whose message says **why it is settled** and **where the choke point is**:
not "don't use X" but "use `mysqlAffectedRows()` from `~/lib/db-result` — reading
`.affectedRows` off the wrapped object silently yields 0". Violations that
predate the lock go in a per-file `overrides` whitelist, so a new one fails
immediately while the old ones drain, and the whitelist going empty is what
deletes the block — a ratchet, tracked by an issue, not a permanent carve-out.
The reference example for the choke messages is nfp-elysia's `.oxlintrc.json`.

A lock like that is **per-repo**: a decision settled for one repo's stack is not
settled for another's, and a base that carried it would be answering a question
nobody in the consuming repo asked.

One thing to know before writing one: a rule's configuration is **replaced across
`extends`**, not merged, so a repo stating `no-restricted-imports` or
`no-restricted-globals` of its own drops every entry the base states for it — the
memoisation and `bun:test` bans, and the three ESM globals, become unenforced in
that repo, silently. (The two positional bans are unaffected: they are rules of
their own, and a repo redefining a list-shaped rule cannot reach them.) Restate
the entries beside your own until
[dev-config#86](https://github.com/gokayo43/dev-config/issues/86) makes that a
gate rather than a thing to remember. What the base does carry is the other kind —
[a pick STACK.md makes for the whole fleet](#the-imports-a-pick-has-already-answered),
where the question is the same in every repo and the answer is the same too. The
test is which document the message would cite, not which rule it is written as.

### Architecture rules

`max-lines` denies at 1000: a file crossing 1000 lines is a presumptive blocker,
and the linter is where that gets said out loud. `max-depth` (4) and `complexity`
(20) deny at oxlint's own thresholds, pinned so an upstream default change cannot
move the gate. Complexity is counted in the **`modified`** variant, which charges
a whole `switch` one decision rather than one per `case`: an exhaustive switch
over a discriminated union is the house shape for a total mapping — it is what
`typescript/switch-exhaustiveness-check` asks for — and under the classic count a
union of two dozen members is over the limit by being answered at all.
`import/no-cycle` denies.

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
`no-unsafe-enum-comparison`, `no-unsafe-member-access`, `no-unsafe-return`, and
`typescript/prefer-nullish-coalescing` — `||` treats `0` and `""` as absent,
which is a bug wherever either is a legal value, and `??` is what the code
almost always meant. Nothing here is warned.

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

### The anti-slop plugin

Type-aware rules catch what `any` touches; they do not see a plain `as`. So
`admin as User as object`, an `unknown` parameter that never gets parsed, a
function that hands `unknown` back, and a `Record<string, unknown>` value
contract all pass a fully type-aware run — and assertion laundering is precisely
the move an agent makes to silence the rules above. These rules close that,
shipped in this package as an oxlint JS plugin and enabled at `error` by the
base:

| Rule                         | What it rejects                                                        |
| ---------------------------- | ---------------------------------------------------------------------- |
| `no-chained-type-assertions` | `x as object as User` — nested assertions that fabricate evidence      |
| `no-known-value-widening`    | a broad annotation over a known initializer; use `satisfies`           |
| `no-unsafe-dictionary-type`  | dictionary contracts whose value type is `unknown`/`any`/`object`/`{}` |
| `no-unknown-type-aliases`    | an alias that only renames `unknown`                                   |
| `no-object-parameters`       | the broad `object` type on an input                                    |
| `no-unknown-parameters`      | an `unknown` parameter, except the `cause` convention                  |
| `no-unknown-returns`         | a declared return of `unknown` or `Promise<unknown>`                   |
| `no-reflect-apply`           | `Reflect.apply`, which launders past a typed call                      |
| `no-reflect-get`             | `Reflect.get`, which answers `any` for a property read                 |

Where a ported rule overlapped oxlint's own `typescript/no-unsafe-type-assertion`
both were run over the same fixtures and only the stronger one kept.

Two more rules are this repo's own, and answer a different question again — not
what a type says, but which import a settled pick already answered:

| Rule                 | What it rejects                                                            |
| -------------------- | -------------------------------------------------------------------------- |
| `no-unnamed-effects` | React's effect trio outside `hooks/`, where the hook's name states the job |
| `no-raw-query-hooks` | `useQuery`/`useInfiniteQuery` in a route, whose data the loader owns       |

They are rules rather than `no-restricted-imports` entries because their answer
depends on where the file sits — see [the two
carriers](#the-imports-a-pick-has-already-answered) for why that decides it — and
each follows its names through every spelling that reaches the value without
importing it, a re-exporting barrel included, while leaving a type-only import
alone.

`no-chained-type-assertions` is the one that overlaps and stays. The native
rule covers every chain that fabricates a type, because such a chain has a
narrowing link in it for the checker to refuse. A chain whose every link widens
has none: `admin as User as object` draws nothing from the native rule, nothing
from `no-unnecessary-type-assertion`, and nothing else in the base says the type
it started from was discarded. Widening a binding and asserting it back needs no
rule of its own — that is an assertion to a narrower type by construction, which
is the whole of what the native rule reads, and `oxlint-base.test.ts` grades the
base on those shapes directly.

Four more are enabled only over `*.test.ts`, `*.test.tsx`, `*.spec.ts` and
`*.spec.tsx`, because every one of them is ordinary code anywhere else: a source
file counts calls, sleeps, reaches into a module of its own and hands a function
to `expect` in a helper, and none of that is a smell until it is a test's whole
evidence.

| Rule                     | What it rejects                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `no-call-log-assertions` | `toHaveBeenCalled*` on an `expect()` chain — that it was called, how often, in what order, with what |
| `no-mock-assertions`     | `expect()` on a stand-in, or on anything read through one                                            |
| `no-local-module-mocks`  | `mock.module()` or `spyOn()` over a relative import                                                  |
| `no-real-timers`         | the timer globals, `Bun.sleep`, and the `node:timers` modules                                        |

What they have in common is that each of them passes against an implementation
nobody would ship. A call log grades the collaborator calls an implementation
happens to make and stays green when it never uses what it got back; a stand-in
is the test's own object, so an assertion about it is about what the test
already did; a fake over a module in this repo grades the fake rather than the
module, and the real one is right there to call; and a suite that waits for real
time is slow in proportion to how much of it it waits for and flaky in
proportion to how loaded the runner is.

All four recognise their subject **through the import**, never through the name
written at the call site. `import { mock as m }`, `import * as bt from
"bun:test"`, `import bt from "bun:test"` — a default import is the same object
under Bun's CJS interop — and vitest's or jest's spelling of the same call are
one rule and one diagnostic. A gate keyed to the written name is a gate an `as`
turns off, which is a one-token edit that reads as style. `bun:test`, `vitest`
and `@jest/globals` are the modules; `jest` and `vi` are also read as globals,
because two of the three runners inject them.

Two boundaries are worth stating, because both rules are wrong without them.
`no-mock-assertions` asks what the subject of the assertion is _reached
through_: every way of reading a call log by hand — `.mock.calls.length`,
`.mock.calls[0]`, `.mock.calls.at(0)`, `.mock.lastCall` — is one spelling of
reaching through a stand-in, and a rule that matched chains would be one
spelling behind forever. Calling the stand-in is the other side of that line:
`expect(send())` is what the code under test would have got, which is the one
thing about a stand-in worth asserting on, and an object of the test's own with
a `mock` property on it is not a stand-in at all. For `no-local-module-mocks`
the line is the specifier: a package is a true external boundary, so
`mock.module("stripe", …)` is not what that rule is about.

#### The environment is read in one module

`no-env-access` answers a different question from the rules above: where
configuration comes from. It refuses `process.env`, `Bun.env` and
`import.meta.env` everywhere except `**/env.ts` and a suite.

| Where           | What it is                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `env.ts`        | the one module that reads the environment, and validates it             |
| a suite         | where a variable is _set_ for a spawned process, not read for its value |
| everywhere else | import the parsed value from `env.ts`                                   |

`env.ts` parses the whole environment through the repo's schema library — Effect
Schema or zod, per STACK — and throws on anything missing or malformed, at import
time. The two halves are one convention: the schema is what makes a missing
variable stop the process at startup, and the lint rule is what stops a second
place from reading around it. `process.env.PORT ?? "3000"` scattered through a
codebase is a deploy pointed at nothing that comes up green, and every default is
a fact about production written by whoever was editing that line.

The glob is `env.ts` exactly, in any directory, and deliberately nothing wider:
`env.client.ts` and `src/env/index.ts` are ordinary source files the rule still
grades. A repo that genuinely needs a second env module writes the switch-off and
its reason in its own `.oxlintrc.json`, which the repo contract's off-reason
walker holds to the same bar as any other — a decision a reader can find, rather
than a glob that forgave it silently.

The rule asks one question — **does this expression denote the environment
holder?** — and hangs every answer site off that one derivation, because a rule
deriving it twice catches a holder written one way and is silent on the next. The
holder is `process`, `Bun` or `import.meta`: read off the global object under any
of its four names, held by a `const` given one once, imported from `bun` or
`node:process` statically or dynamically. Off that, `env` is read as a member
(`process.env`), in brackets, in a substitution-free template, or by
**destructuring the holder** — `const { env: settings } = Bun` reads the
environment with no `.env` anywhere in the file — and is then handed on whole, or
written back into, each with its own diagnostic.

Two shapes are refused at the module edge rather than at a read, because by the
read there is nothing left to see: a named import of `env` binds it under a name
of the file's choosing, and `export { env } from "node:process"` — or `export *`
— creates no local binding at all while the far side imports a relative specifier
one file cannot read across. A re-export of anything else from the same module,
`export { cwd }`, is not laundering and is left alone.

So is a property called `env` on an object of the file's own, a parameter that
shadows `process`, another property of the holder (`const { argv } = process`),
and a key computed from a value, which has no name to read and is not guessed at.

#### What they do not see

A plugin reads one file at a time and has no type checker under it. Two
boundaries follow from that, and everything below is an instance of one of them
— written out because an undocumented limit is one people find by shipping past
it.

**Nothing crosses a module boundary.** A stand-in these rules recognise is one
whose import they can read in the file asserting on it. `export const send =
mock(…)` in a shared test-utils module, a local barrel that re-exports
`{ mock } from "bun:test"`, and `await import("bun:test")` all put the runner or
the stand-in on the far side of a boundary one file cannot see across. This is
the realistic gap: a suite that keeps its stand-ins in a helper gets none of
`no-mock-assertions`, and its call-log matchers are what is left holding the
line — which is why `toHaveBeenCalled` and `toHaveBeenCalledWith` are in the set
rather than only the counts.

**Every reach is one binding deep.** A name is followed to the `const` that gave
it its value, once, and a container is read at the slot written in the literal.
One step further in any direction and the answer is nothing: a nested literal
(`spies.deps.send`), a container behind a call (`Object.freeze({…})`) or a
factory's return value, a slot filled after the declaration, a `Map`, a second
name for the same container, or the call log itself lifted out
(`const log = send.mock`). The same limit is why `const { sleep } = Bun`,
`const later = setTimeout` and a namespace import of `node:timers` are past
`no-real-timers`, while the globals themselves — under all four of their names,
`globalThis`, `self`, `window`, `global` — and a named import of one are
refused.

Where a slot's final value is not the one written at the declaration, the reach
stops rather than guesses. A spread, a computed or repeated key, a getter, or
anything writing through the container (`spies.send = real`) all make the
literal a poor witness, and a rule that read it anyway would report a stand-in
that is not there by the time the assertion runs.

A **`let` given the holder** is the same limit and the same answer: `let p =
process; p.env.PORT` is past `no-env-access`, exactly as `let R = Reflect` is
past the reflect rules. The alternative is a rule that reports a name whose value
something later reassigned, which is a diagnostic about code that is not there —
and a repo can only be asked to keep a rule that is right about what it names.

**A key computed from a value** has no name to read: `expect(x)[matcher](1)` is
left alone, while `expect(x)["toHaveBeenCalledTimes"](1)` and
``expect(x)[`toHaveBeenCalledTimes`](1)`` both have one and are refused — a
template with no substitutions in it is a spelling, not a computation.

The one place a rule refuses rather than shrugs is a module specifier it cannot
read: `mock.module(import.meta.resolve("./x.ts"))` fails asking to be written as
a string, because "cannot tell one of ours from a package" is not a reason to
allow it.

One line can be two smells: `expect(send).toHaveBeenCalledTimes(1)` is both a
stand-in handed to `expect` and a call log asserted on, and it reports twice. A
directive names rules one at a time, so the escape from both is both names in
one — `oxlint-disable-next-line anti-slop/no-mock-assertions,
anti-slop/no-call-log-assertions -- <reason>`. As everywhere else here, the
reason is not optional; the suppression-hygiene gate holds every directive to
carrying one.

Ported from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT);
`anti-slop/index.js` names the upstream commit this port is level with, because
that file is the one a consuming repo can read. Upstream vendors the rules into each repo; they live here
because oxlint's `jsPlugins` API is alpha and explicitly outside semver, so the
rule code and the oxlint version have to move as one pin — which is what the
release pair already does. `no-conditional-empty-object-spread` is deliberately not ported: with
`exactOptionalPropertyTypes` the conditional spread is the only type-legal way
to conditionally include a field in an option bag you do not own. Two more are
not ported either: `require-safety-comment-for-type-assertion`, whose goal the
native rule and the reason-carrying disable already deliver in a form that is
counted and checked rather than syntactic, and `no-module-mocking`, which knows
`vi` and `jest` but not `bun:test` — `no-local-module-mocks` below covers all
three runners, and refuses a stand-in over a module of ours rather than over a
package, which is where a fake belongs.

Upstream's opt-in Effect rule, `no-service-constructor-imports`, was evaluated
and declined: it keys on a `make<Capability>` naming convention, and a
convention settled for one repo's stack is not a base rule — the same reason
the choke rules above stay per-repo. There is nowhere else for it to go
either. The base enables every rule this plugin defines, and the suite requires
those two sets to be equal, so the plugin has no opt-in half to put it in.

One rule answers differently from upstream, because a rule at `error` across
the fleet must refuse something the author can change:

- **`no-known-value-widening`** does not call an anonymous object type a
  widening when it names exactly the keys of the literal below it. Upstream
  does, and its only escapes are deleting the return type or inventing a name
  for it — the opposite of what this repo asks for everywhere else.

Two facts about how it is wired, both load-bearing:

- **The `jsPlugins` specifier is relative to `oxlint.base.json`**, so a repo that
  extends the base through `node_modules` resolves the plugin with no line of its
  own. There is nothing to scaffold per repo.
- **The plugin is JavaScript, not TypeScript.** Node refuses to strip types from
  any file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
  and this directory is inside `node_modules` for every repo that consumes it.
  `tsc` still checks it in this repo, through `checkJs` and JSDoc types.

`tests/anti-slop.test.ts` drives the unscoped rules with the real binary: a block of cases
per rule — alias chains, shadowed built-ins, type parameters bound by default,
permuted between two aliases and named for the aliases they shadow, the scope a
binding resolves in, and the clean tree each of those has to leave alone — plus
upstream's own fixtures for the six rules it ships tests for, run as a
differential oracle against this port. It also asks the plugin and the base for
their rule names and requires them to match: a rule the base does not enable is
a rule no repo runs, and a name in the base the plugin does not define is a rule
nobody notices is missing.

`tests/anti-slop-test-smells.test.ts` is the other four, which have a second
question to answer about every case — the base has to catch them in a
`.test.ts`, a `.spec.ts` and both `.tsx` spellings, and to say nothing about the
same source in a `.ts` or a `.tsx`, since a rule that fired everywhere is one
every repo would turn off. Most of its cases are the spellings that would
otherwise turn a rule off: an `as` on an import, a namespace, an optional link,
a global reached through `globalThis`, a matcher in brackets.

`tests/anti-slop-env.test.ts` is `no-env-access`, which has a third question
again: the base has to grade it in a source file, say nothing in an `env.ts` at
any depth or under a suite's suffixes and directories, and still grade
`env.client.ts`, `src/env/index.ts`, `test-utils.ts` and `src/testing/`. It also
takes the reason out from above each of the base's two switch-offs for it — found
by the `files` glob of the block that owns it, not by position — and requires the
contract's off-reason walker to find both: a plugin rule inside an `overrides`
block, which is what the fleet's own escape from this rule will be.

`tests/lint-policy.test.ts` is the same shape over the picks a file's position
decides, whichever of the two carriers states one: one tree under the shipped
base, a file per case, and an assertion about which of them drew what. It grades
the scoped bans on both sides of every glob — a hook at any depth, a name that
merely reads like one, a route under a hook and a hook under a route — every
spelling that reaches a banned name without importing it, and the **message**,
since a ban whose diagnostic does not name the pick the import lost to is a rule
the next person argues with rather than follows.

The harness in `tests/lint-fixture.ts` carries cases of its own, because a
plugin that throws and a config oxlint refuses both produce a run with no
diagnostics — which is exactly what a clean-tree case asserts.

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

The base also exports `mutationLaneDependencies`, the two packages a repo
running [the mutation lane](docs/gates/mutation-lane.md) declares and knip would
otherwise report as unused. A repo that runs the lane spreads it into its own
`ignoreDependencies`; the names live in one place and the spread stays per-repo,
because `treatConfigHintsAsErrors` makes an ignore matching no declared
dependency an error — carrying it in the base would fail knip in every repo that
does not run the lane.

## Tests and coverage

`bunfig.toml` cannot be extended across packages, so this block is copied into
each repo:

```toml
[test]
coverageThreshold = { lines = 0.75, functions = 0.75 }
coverageSkipTestFiles = true
```

The threshold is declared here and applied by the `--coverage` the
[test-suite](docs/gates/test-suite.md) action passes — which is also why
`[test] coverage` in a repo's own bunfig is refused rather than merely
unnecessary — either spelling, since `false` vetoes CI's flag outright; that
page has the argument.

The CI run exits non-zero below the threshold, which is what makes it a gate
rather than a report. Two properties of it cost a probe to discover: the breach
is not printed — a run that reports every test passing and still exits 1 is
this — and the threshold is applied to **every file**, not to the total. So the
floor goes below the least-covered file, and a repo whose summary line reads 86%
can still be failing on one file at 64%.

0.75 is a floor, not a target: it is set at or below what the repo already
covers, and it is raised only after the coverage is there. A floor above current
reality is a red CI run that teaches everyone to ignore red CI runs.

What coverage cannot say is whether the suite would have noticed had the line
been wrong. [The mutation lane](docs/gates/mutation-lane.md) asks that, over the
domain files a branch changed, and `mutation-floor` is the same paragraph again
for the number it publishes.

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

This repo consumes its own preset: the `renovate.json` beside `default.json` is
the one line above, so the policy the fleet inherits is the policy this repo is
held to. The two files are not the same subject — `default.json` is what other
repos extend, `renovate.json` is this repo extending it.

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

Two live ones sit there. `_lib/k6.sh`: db-gate's ramp, this repo's own execution
of the shipped script, and `project-template`'s ramp against a preview stack are
three callers of one pin, and a ramp is only comparable with another ramp of the
same k6. `_lib/shellcheck.sh`: the `shell-scripts` gate over a repo's tracked
scripts, and this repo's own pass over the scripts inlined in its composite
actions — and what the pin buys is
[docs/gates/shell-scripts.md](docs/gates/shell-scripts.md)'s "Which shellcheck".

The shape above is illustrative on purpose: this file is not in the manager's
patterns, so a real version and checksum written here would be the one pin
nobody moves. The live ones sit in `.github/actions/secret-scan/action.yml`,
`.github/actions/lint-workflows/action.yml`, `.github/actions/_lib/k6.sh` and
`.github/actions/_lib/shellcheck.sh` — all of which the patterns cover, and they
cover the next tool without touching the preset.

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
throwaway. Two runs may share one: every name either the suite or a gate puts on
that server carries what tells the runs apart — the process for the suite's own
databases, and the checkout being worked on for the two a gate builds for itself
(`upgrade_path_<digest>` and `backfill_<digest>`).

The limiter conformance suite needs a Redis, since what it grades is a bucket
shared by two processes and a limiter whose Redis is gone. It **flushes** what it
is given, so unlike the Postgres above it has no default at all: `TEST_REDIS_URL`
is required and the suite refuses to guess. A default address is how a suite
wipes the Redis four stacks on one box were sharing.

```sh
docker run --rm -d -p 6390:6379 redis:7-alpine
export TEST_REDIS_URL=redis://127.0.0.1:6390
```

The invariant sweep's suite drives a real browser against a real server, because
every part of what that fixture claims is a browser fact. It needs Playwright's
chromium, which CI installs and a machine gets with:

```sh
bunx playwright install --with-deps chromium-headless-shell
```

The test-suite gate's own suite needs passwordless `sudo`, which is what taking a
network namespace costs — a runner has it, and a machine that does not cannot run
that suite honestly. It is the one gate here whose subject is not a module, so
its cases extract the step out of the shipped `action.yml` and drive it over test
suites of their own.

The linting is the `lint-workflows` action — actionlint, pinned by version and
archive checksum exactly like gitleaks, with shellcheck over every `run:` block.
It runs here from the working tree, and `check.yml` runs it for every consuming
repo, so a scaffolded repo's own workflows are held to the same schema and the
same pins as this one's.

actionlint only understands workflows: handed an `action.yml` it reports a
workflow with no `jobs`. So the composites get a pass of their own, asserting
what silently breaks them — a `run` step with no `shell` never runs the script
it carries — and the scripts inlined in them go through the pinned shellcheck,
with `--shell=bash` because an extracted `run:` block has no shebang. The shell
libraries those blocks source are not extracted from anything, and are read by
the `shell-scripts` gate along with every other `*.sh` in the tree.

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

## One dev server per worktree

`dev-server.ts` is the one root module a repo **runs** rather than imports:
installing this package puts a `dev-server` binary in `node_modules/.bin`, so
every worktree of the repo has the same six commands without a script of its
own. `dev-server-derive.ts` beside it is the half that can be answered without a
machine — what a worktree's server is called, which port it gets, and what its
record has to be — and is imported by the bin and by nothing else.

| Command                     | What it does                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun run dev-server up`     | starts this worktree's server if it is not up, waits until it answers HTTP, prints its URL                |
| `bun run dev-server down`   | stops it — SIGTERM to its process group, SIGKILL ten seconds later; exit 0 whether or not one was running |
| `bun run dev-server status` | every server the repository has: branch, port, pid, whether the process is alive, and whether it answers  |
| `bun run dev-server url`    | this worktree's URL, or exit 1 when no server is up                                                       |
| `bun run dev-server logs`   | the tail of this worktree's log; `-f` follows it                                                          |
| `bun run dev-server sweep`  | stops and forgets the servers of worktrees that are gone, and collects records that will not decode       |

Stdout is the answer — a URL, the table, log lines — and everything a person
reads rather than pipes goes to stderr. So `open "$(bun run dev-server url)"` is
a thing that works, and `up` in a script hands back a URL rather than a
paragraph. A command refuses an argument it does not take rather than ignoring
it, and it does so before it reads anything off the machine: a typo outside a
repository prints the usage rather than git's complaint.

**Linux only.** The child is put in a session of its own with util-linux
`setsid`, and the proof that a recorded pid is still the process this tool
started is read out of `/proc`. Neither exists on macOS. Nobody on this fleet
runs one, so there is no second path here rather than an untested one.

**The whole contract with the repo is its `dev` script: it must bind `$PORT` on
`$HOST`.** Four names are handed to it and nothing is read back out —
`PORT`, `DEV_PORT`, `HOST=127.0.0.1` and `SITE_URL`, which are
`project-template`'s names, so a template repo needs no edit at all. Loading a
`.env` stays the repo's own business.

`HOST` is a request rather than a guarantee, so `up` asks the machine once the
server answers: if the port also answers on `127.0.0.2` or on any of this
machine's real addresses, the dev script is binding every interface instead of
`$HOST`, and the child is stopped. A dev server reachable from the LAN is
somebody else's code running on this machine's ports.

**Identity is the worktree, never a name derived from it.** The record and the
log are `<branch-slug>-<tag>.json` and `.log`, where the slug is for a reader
and the tag is a hash of the worktree's own path. Two branches that differ only
in punctuation or case reduce to one slug, and two detached worktrees share one
short commit — so anything keyed on a readable name is one record and one port
for two servers, which is one worktree serving another's code under a URL it
printed itself. Every command also checks the `worktree` field of what it reads
and refuses a record naming a different checkout, because a 32-bit tag is short
enough to owe that check.

**The port is derived, never allocated.** A worktree's block is ten ports, hashed
(FNV-1a) from `<package name>/<branch>` and landing between 20000 and 60000, and
the first port in that block nothing is holding is the one claimed. The branch is
hashed **as git spells it** — `feat/x` and `feat-x` are two worktrees and must be
two blocks — and a detached worktree hashes its path instead, since its name is
not its own. The package name is in the hash and not merely beside it: every repo
on a machine has a `main`. The range deliberately overlaps the ephemeral ports
the kernel hands out, which no span of this size could avoid, so every port is
probed before it is claimed rather than assumed free.

**A claimed port is refused, never stepped over.** If something else is listening
on the port a worktree already claimed, `up` says so, names the port and exits 1.
Falling forward to the next free one would keep `up` working and quietly break
the only property the derivation is for — that this worktree's URL is still this
worktree's URL tomorrow. `dev-server down` gives the claim up, and the next `up`
derives again.

**One `up` per worktree at a time**, held over the whole read-decide-spawn-write
with a lock file beside the record. Two of them racing that sequence both bind:
measured, five concurrent pairs left four servers running that no record named.
A lock whose holder is gone is taken rather than waited on — the holder is named
by pid, boot id and start tick, exactly as a server is — so a run killed
mid-`up` costs the next one nothing.

**A recorded pid is not trusted on its number.** A pid is reused, and a reboot
recycles every one of them at once, so the record carries the boot id it was
taken on and the tick the process started at (`/proc/<pid>/stat` field 22); all
three are re-read before any signal, and a mismatch means the record names
nobody. Since what gets signalled is a process _group_, the pid must also still
lead its own — which `setsid` guarantees for anything this tool started, and
nothing else. A record whose pid or port is a number no derivation here could
have produced is not a record at all.

**The records live in git's common directory** — `$(git rev-parse
--git-common-dir)/dev-server/`, mode 0700, with each record and log 0600 because
the log holds whatever the dev script printed, environment included. That is one
directory per repository whatever `git worktree` does to it: never tracked, so no
consumer is asked for a `.gitignore` line, and still there when a worktree's own
directory is not — which is the state `sweep` exists for. A record holds the
worktree path, the branch, the package name, the port, the pid, the boot id, the
start tick, the log path and when it started; it is written whole and moved into
place, and `up` writes it the moment there is a pid to write. The window that
remains is `up` itself dying between the spawn and that write: the child is then
orphaned with no record, and what surfaces it is the next `up` refusing the port
it is holding.

One unreadable record no longer takes the repository's tool down with it.
`status` lists it as junk with its path, `sweep` collects it, and the other
commands say so on stderr and carry on as if it were absent.

**`sweep` is the one command that reads `git worktree list`.** A record whose
worktree is no longer there — removed with `git worktree remove`, or deleted
outright, which git still lists as prunable — is a server nobody can stand in
front of any more, so it is stopped and its record and log are dropped. The rule
is "the path is not there", which a worktree on an unmounted volume also
satisfies: `sweep` would stop its server too. Every other record is left alone.

`up` waits two minutes for the first HTTP response before it gives up, stops the
child and prints the last 40 log lines. It stops waiting the moment the child
exits, rather than sitting out the clock for a process that is already gone.
`DEV_SERVER_READY_TIMEOUT_MS` shortens that and is read before anything is
started, which is what this repo's own suite sets. The log is appended to rather
than truncated, with a dated header per run, so a spawn that fails on its first
line does not destroy the log somebody came to read.

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
      database: postgres
```

| Input                 | Default                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`               | `false`                            | Runs `bun run build` before the static gate and before the boot gate.                                                                                                                                                                                                                                                                                                                                        |
| `affected`            | `false`                            | Runs the `typecheck` lane over the packages a pull request changed, via turbo's `--affected` with `TURBO_SCM_BASE` set to the pull request's base commit. Needs `turbo.json` at the root and is refused without one; ignored on a push, where `main` stays the full run.                                                                                                                                     |
| `database`            | `none`                             | `postgres` adds the database job: an empty Postgres, the migrations replayed onto it twice, the app booted against the result, and a k6 ramp over every route it serves. `external` says a workflow wrapping this one runs the database gates in that job's place. `none` is a repo with no schema. Anything but `none` makes `db:migrate` part of the repo contract; anything outside the three is refused. |
| `compose`             | `false`                            | Holds `docker-compose.yml` to the deployment shape.                                                                                                                                                                                                                                                                                                                                                          |
| `mutation-lane`       | `false`                            | Mutates the domain files this branch changed and fails on a mutant its own lines left undetected. Reads the pure domain from the `boundaries/elements` entry typed `domain`; needs `@stryker-mutator/core` and `@hughescr/stryker-bun-runner` among the repo's devDependencies.                                                                                                                              |
| `mutation-floor`      | `""`                               | The mutation score the changed domain files must hold, as a fraction between 0 and 1. Empty publishes the score and enforces nothing. Needs `mutation-lane: true`.                                                                                                                                                                                                                                           |
| `upgrade-gate`        | `false`                            | Also proves that a database upgraded from the base ref's migrations reaches the schema a fresh one gets. Needs `database: postgres`; for repos whose database is deployed.                                                                                                                                                                                                                                   |
| `semantic-fixtures`   | `""`                               | A directory of the repo's own holding the rows a deployed database already has, as base-compatible SQL, each with the assertion the current contract makes about them: written into the base ref's replay and graded after this branch's migrations run over them. Needs `upgrade-gate: true`.                                                                                                               |
| `contract-exemptions` | `""`                               | Repo-contract facts this repo is structurally unable to satisfy, space-separated. A marketing site names `docs-spine`; a repo being wound down names `lifecycle-retire`.                                                                                                                                                                                                                                     |
| `data-jobs-external`  | `""`                               | Where the deployment already runs a live repo's backup and restore drill, when they are not this repo's own scripts — the job, its schedule and the runbook. Empty asks for `scripts/backup.sh` and `scripts/restore-drill.sh` with their units. The reason is the waiver, so there is no way to claim it without naming the jobs.                                                                           |
| `stack-allowlist`     | `""`                               | Packages this repo keeps against the stack denylist, as `<package> -- why` entries, one per line; an entry is refused when it carries no reason, when nothing here declares the package any more, or when the denylist has stopped denying it.                                                                                                                                                               |
| `backfill-seed`       | `""`                               | Shell code putting a database into the state this repo's backfill was written for. Set it with `backfill-command` or not at all.                                                                                                                                                                                                                                                                             |
| `backfill-command`    | `""`                               | The backfill, as shell code: run twice against the state `backfill-seed` wrote, in a database of the check's own, with the data compared either side of the second run.                                                                                                                                                                                                                                      |
| `start-command`       | `bun run start`                    | How the boot gate starts the app.                                                                                                                                                                                                                                                                                                                                                                            |
| `health-url`          | `http://localhost:3000/api/health` | What the boot gate polls until it answers 200.                                                                                                                                                                                                                                                                                                                                                               |
| `probe-command`       | `""`                               | A command of the repo's own, run as shell against the booted app after it answers its health route and before the ramp, with the app's URL in `HEALTH_URL`. Its stdout is the verdict: every line it writes there is one problem, whatever it exits with.                                                                                                                                                    |
| `probe-timeout`       | `""`                               | How many seconds `probe-command` gets before it is killed. Empty takes the bound `db-gate/probe.ts` declares — 120 seconds today — which is where that number and the argument for it live. Needs `probe-command`.                                                                                                                                                                                           |
| `timestamp-allowlist` | `""`                               | `schema.table.column -- why` entries whose value really is a wall-clock reading rather than an instant, one per line; an entry is refused when it carries no reason, when the schema has no column of that name, or when that column is no longer a wall-clock one.                                                                                                                                          |
| `capacity-path`       | `""`                               | Paths to ramp alongside the health route, one per line.                                                                                                                                                                                                                                                                                                                                                      |
| `capacity-script`     | `""`                               | A k6 script of the repo's own, replacing the shipped ramp.                                                                                                                                                                                                                                                                                                                                                   |
| `db-gate-evidence`    | `db-gate-evidence`                 | The artifact name for the k6 summary, the two route-log snapshots, the backfill check's three data dumps and the app's output, for a matrix that runs more than one leg.                                                                                                                                                                                                                                     |
| `route-allowlist`     | `""`                               | Routes the ramp cannot cover, as `METHOD /path -- why` entries, one per line; one without a reason, and one the ramp did reach, are both refused.                                                                                                                                                                                                                                                            |
| `test-network`        | `""`                               | Why this repo's suite has to reach a real network. Empty runs the suite sealed in a network namespace with nothing but loopback in it, so a live call fails where it is written. The reason is the input, and it is read in review like the reason on a lint directive.                                                                                                                                      |
| `test-suite-evidence` | `test-suite-evidence`              | The artifact name for the junit report, for a matrix that runs more than one leg.                                                                                                                                                                                                                                                                                                                            |

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

`affected` is the seam turbo needs from a workflow that runs a repo's root
scripts by name. `--affected` is a CLI flag with no environment form, so a
monorepo whose `typecheck` is `turbo run typecheck` has nowhere else to say it.
The flag goes on **pull requests only**: on a push to `main` it diffs `main`
against itself and selects zero packages, and a change to a root file no
package's `inputs` name selects zero as well — so every lane would go green over
nothing. The full run on `main` is what makes handing it to a pull request safe
at all.

Two variables carry it, and the second is not optional. `TURBO_AFFECTED` is the
flag; `TURBO_SCM_BASE` is the commit it narrows against, set to
`github.event.pull_request.base.sha`. Without it the flag narrows nothing:
`actions/checkout` leaves a detached HEAD carrying `refs/remotes/origin/*` and
no local branch, so turbo resolving its base by ref name finds none, prints
"unable to detect git range, assuming all files have changed", and runs the
whole graph — green, and silent about having ignored the flag.

Only `typecheck` narrows. `build` does not, even with `affected: true`: a build
is what writes the generated sources the whole-repo lanes then read — a route
tree, a codegen client — and a build over the changed packages alone leaves
`lint`, `knip` and the root typecheck reading files nothing wrote this run.

A repo with no `turbo.json` is refused rather than handed the flag, since
without turbo it arrives at `tsc`. That check is the file, not the script: a
repo that has a `turbo.json` and a `typecheck` that is still `tsc --noEmit` gets
`--affected` passed to `tsc`, which fails with TS5023 — loudly, which is the
better half of a wrong answer, but a wrong answer.

`TURBO_TELEMETRY_DISABLED` needs no input. It is set in this workflow's own
`env:`, which is the only place a called workflow can be given one: `env:` is
not a permitted key on a job that `uses:` a reusable workflow, and a caller's
workflow-level `env` does not reach the workflow it calls. A scaffolded
monorepo's `.env` covers a checkout and nothing else, so without this every CI
run of every one of them was reporting usage counts.

Eleven inputs are aimed at steps of the database job — `upgrade-gate`,
`semantic-fixtures`, `capacity-path`, `capacity-script`, `db-gate-evidence`,
`route-allowlist`, `timestamp-allowlist`, `backfill-seed`, `backfill-command`,
`probe-command` and `probe-timeout` — and each fails the run when passed with
anything but `database: postgres`, saying which: being quietly ignored is how a
ramp somebody asked for turns out never to have run. `external` refuses them
exactly as `none` does, because the job they configure does not run here either
way — the wrapper that took that job over declares its own. Two of them ride on another input rather
than on the job, and are asked a second question for the same reason:
`semantic-fixtures` is refused without `upgrade-gate: true`, since the rows go
into the replay that input adds, and `probe-timeout` is refused without
`probe-command`, since on its own it bounds nothing. `mutation-floor` is refused
without `mutation-lane: true` on the same argument.

The call is pinned by commit SHA with the release as the trailing comment — the
same contract the actions inside it carry, and the reason a change here reaches
a repo when its pin moves and not before. The example above is deliberately not
a real SHA: nothing keeps a README snippet current, so the pin worth copying is
the live one in `project-template`'s `setup/ci.single.yml` or
`setup/ci.monorepo.yml`. Renovate's github-actions manager
reads a job-level `uses:` exactly as it reads a step's, so the pin moves in a PR
like any other dependency.

`semantic-fixtures` is the one input here that grades **data** rather than
shape. Everything else the database job does is a comparison of schemas, of
column types, of route tables or of rows either side of one command — and a
migration that converges on the right schema while rewriting what a value means
passes every one of them. The fixtures are the rows a deployed database already
holds, replayed through the base ref's migrations and then this branch's, with
the repo's own assertions asking what they now say; `probe-command` is the same
question asked of the booted app's answers rather than of its tables.
[docs/gates/upgrade-path.md](docs/gates/upgrade-path.md) and
[docs/gates/db-gate.md](docs/gates/db-gate.md) carry both, including what neither
can see.

In order, the pinned workflow runs the gitleaks scan, the declarative gates
(repo contract, stack denylist, suppression hygiene, shellcheck over the repo's
own scripts, and the compose lint when asked), `bun install`, the optional build,
`format:check`, `lint`, `typecheck`, `knip`, the test suite, the assertion that
the suite ran, and — where the repo asks for it — the mutation lane over the
domain files this branch changed.
Everything from
`format:check` to the test suite is the local `bun run check`, so a green
pre-push is a green CI run; the rest is what only CI has.

The declarative gates come before `bun install` deliberately. They read the tree
as committed, so a repo that has drifted out of the contract says so in seconds
rather than after a full dependency resolution.

The steps that are shell or a script rather than a `bun run` live in
`.github/actions/` as composite actions — `secret-scan`, `repo-contract`,
`stack-gate`, `suppression-hygiene`, `shell-scripts`, `compose-lint`,
`test-suite`, `db-gate`, `lint-workflows` — so the workflow above and any
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

`repo-contract`, `stack-gate`, `suppression-hygiene`, `shell-scripts`,
`lint-workflows` and `compose-lint` run in the static job; `db-gate` is the
database job, and the capacity ramp is a step of it. Each has its page under
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
exact = true
```

`exact`, and not `saveExact`: bun reads the first and ignores the second, so a
repo declaring the second pins nothing while carrying the field that says it
does. Probed as a matched pair on both ends of the range this fleet runs, with
`HOME` neutralised so no user bunfig decides it — `bun add lodash` writes
`4.18.1` under `exact = true` on bun 1.3.11 and 1.4.0, and `^4.18.1` under
`saveExact = true` on both, exactly as declaring neither does. The repo contract
grades the key bun actually reads.

A package published minutes ago cannot be installed, so a compromised release
that is detected and yanked within hours never reaches a lockfile. Upgrades take
the newest version that clears the window, which is why this repo's baseline is
TypeScript 7.0.x rather than a `7.1.0-dev` build.
