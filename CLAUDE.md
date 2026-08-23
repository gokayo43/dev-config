# dev-config

The tooling policy for every Bun repo here, in one place: the shared configs
repos inherit, and the CI gates they call. `CONTEXT.md` is the vocabulary and
`README.md` is the reference for how each piece is consumed.

## Canon

The house rules live outside this repo and win over anything here:
`~/claude-shared/STACK.md` (one pick per slot), `architecture.md`, `testing.md`,
`principles.md`. This repo is where several of those rules become executable, so
a change to a rule usually lands here too.

## Layout

- `*.base.json` / `knip.base.ts` / `lighthouserc.json` — the bases repos inherit.
  Anything keyed to a repo's own paths does not belong in one.
- `anti-slop/` — the oxlint JS plugin `oxlint.base.json` names in `jsPlugins`,
  ported from dmmulroy/anti-slop (README has the rule table and the credit).
  `shared/` holds the three questions more than one rule asks: `syntax.js` what
  was written, `bindings.js` what a name stands for and whether it can change,
  and `types.js` what a type finally means — `resolveType` is the one walk
  through parentheses, type arguments, transparent built-ins and aliases, and
  every classification is a switch over the node it stops at.
  Its specifier is relative to the base config, so consuming repos need no line
  of their own. It is JavaScript with JSDoc types, not TypeScript, because Node
  refuses to strip types under `node_modules` — which is where every consumer
  has it; `checkJs` in `tsconfig.json` is what type-checks it here.
- `default.json` — the Renovate preset, resolved by a bare `github>owner/repo`.
- `.github/workflows/check.yml` — the gate every repo calls.
- `.github/actions/*/` — the executable gates. Each is an `action.yml`, the gate
  modules the suite drives, and a `*.main.ts` that GitHub runs. An action holds
  more than one module when it holds more than one subject:
  `repo-contract/live.ts` is what the word "live" derives — everything a repo
  owes because it carries people — beside the contract every repo satisfies
  whether or not anyone is on the other end.
  `db-gate` holds three beside its replay: `semantic-fixtures.ts`, since what
  the base ref's replay proves about a _schema_ and what it proves about the
  _rows_ are two subjects and the second is the only gate here that grades data;
  `base-lineage.ts`, the lineage as the base ref carried it and the rollback that
  puts a checkout back onto one, which both of those need and neither is about;
  and `capacity.ts` for the ramp. What more than
  one **action** reads lives in `_lib/`: `gate.ts` — which is where `plainly`
  sits, the environment a child whose output a gate reads is given, now that two
  actions spawn one — and `dependency-specs.ts` —
  the version grammar the repo contract grades every spec by and the stack
  denylist asks which package a spec installs. What two gates of one action
  share stays in that action's directory instead — `db-gate/database.ts`, the
  scratch database its three data gates each build for themselves and the one
  derivation of "these two dumps came out the same", and
  `repo-contract/ci-workflow.ts`, the one
  path both halves of that contract have an opinion about and neither owns. Any
  of them moves to `_lib/` when a second action reads it, and not on the
  argument that one might.
  The shell helpers beside them are `pinned-tool.sh` — the verified fetch
  every pinned binary goes through — and, on top of it, `k6.sh` and
  `shellcheck.sh`, each that fetch plus one pin: the three ramps in this house
  run one k6, and everything here that reads shell reads it with one shellcheck.
  Actions, rather than scripts run out of the package every repo already
  installs: a gate in `node_modules` runs only if the repo's own workflow
  remembers to run it, and it moves whenever the lockfile moves — including on
  a Renovate automerge nobody reads. It costs the release pair under
  "Releasing", and it is why gate code is not importable by the repos it
  gates: anything they call directly is a package export instead, which is
  what `route-log.ts` below is.
  `mutation-lane` is the one gate that runs a tool out of the gated repo's own
  install rather than a binary it pins itself: Stryker resolves its runner
  plugin from the working directory, and declaring the two packages in the
  repo's manifest is what puts them under its lockfile, its exact pins and its
  release-age window.
- The `*.ts` at the root are the package's **exports** — what a consuming repo
  imports and calls, as against the gates, which run over it from CI. Each is in
  `files` and `exports`, and each is here rather than in an action for the same
  reason: what it grades is only visible from inside the repo. `route-log.ts` is
  the protocol between an app and the route-coverage floor;
  `invariant-sweep.ts` is a Playwright fixture that watches every page a spec
  visits; `limiter-conformance.ts` is STACK's rate-limit rule as a `describe`
  block a repo's limiter has to pass; `response-schema.ts` grades an Elysia
  app's own route table; `characterization-net.ts` is the harness under a golden
  suite. Their pages are `docs/exports/`.
  Two of them register tests rather than answering with problems, and the split
  is by subject rather than by taste: a route table is a value one call can
  grade, and a limiter is a sequence of attempts against a live Redis that only
  a test framework can sequence.
- `db-gate/capacity.js` is the exception: it runs inside k6, not under this
  repo's compiler or linter, which is why `.oxlintrc.json` ignores it. A JSON
  config cannot carry the reason, so it is here.
- `tests/` — a fixture suite per gate, driving it against a violating tree and a
  clean one. A gate without one is a claim; `anti-slop.test.ts` and
  `anti-slop-test-smells.test.ts` hold every lint rule in `anti-slop/` to the
  same bar — a block of cases per rule, split where the base splits, since the
  rules scoped to test files have a second question to answer about every case
  and the ones that apply everywhere do not. Neither file states how many there
  are: `anti-slop.test.ts` asks the plugin and the base for their rule names and
  requires the two sets to be equal, which is the check a count would replace
  with a number to forget. Both run through `lint-fixture.ts`,
  which owns the case shape and lints a whole block in one oxlint spawn, and
  refuses a run whose plugin threw or whose exit status and diagnostics
  disagree, both of which otherwise read as a clean tree.
  `anti-slop-upstream.test.ts` is
  upstream's own fixtures, as a differential oracle over every rule it ships
  tests for. Two suites are not a gate's: `oxlint-base.test.ts` holds what
  the base config itself must — an override REPLACES a list-shaped rule rather
  than adding to it, which it proves against a config it builds itself and then
  holds every override in the base to — and `action-evidence.test.ts` holds every action
  publishing an artifact to keeping the runner-temp paths its own YAML names.
  `repo-contract-fixture.ts` is the clean tree the repo contract's two suites
  share; `journalled-migrator.ts`, `replaying-migrator.ts` and
  `schema-migrator.ts` are the three `db:migrate` shapes the database gates are
  written for — a journalled one, a hand-rolled runner with no journal, and the
  per-lineage journals a repo with more than one lineage has to have; and `mutation-lane.test.ts` links this repo's own `node_modules` into
  each fixture and runs Stryker for real — a stubbed mutation run would prove
  nothing about the tool that gate exists to drive. `test-suite.test.ts` is the
  same argument one level down: that gate is a shell script rather than a
  module, so the suite extracts the step out of the shipped `action.yml` and
  runs it over fixture suites of its own. It needs passwordless sudo, because
  what it is grading is a network namespace.
  The exports' suites are the same shape once more. `house-limiter.ts` is
  STACK's limiter plus every named way of building a wrong one, and
  `limiter-conformance.test.ts` spawns a `bun test` per build and asserts that
  the house one passes and that each flaw fails the case paired with it — a
  pairing the compiler requires to be total, so a wrong implementation nobody
  wrote a case for does not exist. `sweep-fixture.ts` serves the pages the
  invariant sweep is driven over and runs one Playwright process across every
  spec: a browser and a server, because every fact that fixture claims is a
  browser fact.
- `docs/gates/*.md` — a reference page per gate; `docs/exports/*.md` — one per
  package export. README holds both maps.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test        # the gate suites, coverage-floored
```

`anti-slop/**` sits outside that floor, in `bunfig.toml`: its rules run inside a
spawned oxlint and never execute in the test process, so the runner instruments
them and then watches them run nowhere. What carries their duty instead is
`tests/anti-slop*.test.ts`, which lints fixture trees with the shipped binary —
a block of cases per rule, and a check that the base enables exactly the rules
the plugin defines.

`bun test` needs a Postgres, a Redis, a chromium and passwordless sudo. The
first because the replay gate's property is what two databases end up holding
and the semantic fixtures' is what a real migration does to a real row; the
second because a limiter's bucket is shared by two processes and its Redis can
be gone; the third because what the invariant sweep claims is what a browser
reports; the fourth because the test-suite gate seals a run in a network
namespace and nothing short of taking one says whether it holds. The suite looks
at `TEST_DATABASE_URL` or localhost:5432 and creates and drops databases there,
and at `TEST_REDIS_URL` or localhost:6379, which it **flushes** — README's
"Gating this repo" has the one-liners, including the browser install.

Two runs may share one server, which is what two worktrees under review are.
Every database either end makes is named for what tells the runs apart: the
suite's own carry the process that created them, and the three the gates build
for themselves — `upgrade_path_<digest>`, `semantic_fixtures_<digest>` and
`backfill_<digest>` — carry the checkout they are working on.

This repo runs its own gates on itself in CI, from the working tree, with three
exemptions named in `ci.yml`: it cannot extend itself by package name, its CI
cannot pin a commit it is making, and it has no runtime environment.

## Releasing

Every change to a composite action needs **two** tagged commits, because a
commit cannot reference its own SHA:

1. the commit that ships the actions — bump `version`, tag it;
2. the commit that repoints `check.yml` at (1) — bump `version` again, tag
   that.

Consumers pin the actions at (1) and the workflow call at (2). A tag must sit on
exactly the commit its pins name. A change here reaches a repo when its pin
moves and not before, which is the point: a new gate cannot turn the fleet red
overnight, and the diff that adopts it is one line someone reviewed.

After tagging, bump `project-template`'s pins: `setup/ci.single.yml` and
`setup/ci.monorepo.yml` (one per shape, and both carry the workflow call),
`.github/workflows/template.yml`, and `DEV_CONFIG` in `setup.ts`.

## Adding a gate

Write the check as `.github/actions/<name>/<name>.ts`, exporting a function that
answers with the problems the step reports, and takes whatever it reads — a
root path, injected fetchers — as arguments. `Problem[]` is the whole answer for
a gate that only refuses; one that also publishes answers with `_lib`'s
`Verdict` — the note for the log, the table for the run summary, whatever the
run wrote, and the problems — and its entry point hands that whole to
`publish()`, which is the one place the order of those writes is decided. The
entry point is a separate `<name>.main.ts` that `action.yml` runs: it hands its
whole body to `entry()`, so that a throw reaches the log as an annotation rather
than a stack trace, reads the inputs through `inputs()`, which throws on a
missing one, and calls `report()` or `publish()`. Splitting them is what lets the
coverage floor mean something, since nothing can drive an entry point from a
test.

Add the fixture suite and the `docs/gates/` page in the same change, then wire
it into `check.yml`. A diagnostic names what to do, not what went wrong.
