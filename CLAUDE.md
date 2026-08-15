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
- `.github/actions/*/` — the executable gates. Each is an `action.yml`, a gate
  module the suite drives, and a `*.main.ts` that GitHub runs. What more than
  one **action** reads lives in `_lib/`: `gate.ts`, and `dependency-specs.ts` —
  the version grammar the repo contract grades every spec by and the stack
  denylist asks which package a spec installs. What two gates of one action
  share stays in that action's directory instead — `db-gate/database.ts`, the
  database those gates build for themselves and the one derivation of "these
  two dumps came out the same", and `db-gate/verdict.ts`, what they report and
  how their entry points say it. Either moves to `_lib/` when a second action
  reads it, and not on the argument that one might.
  The shell helpers beside them are `pinned-tool.sh` — the verified fetch
  every pinned binary goes through — and `k6.sh`, which is that fetch plus the
  one k6 pin, so the three ramps in this house run one binary.
  Actions, rather than scripts run out of the package every repo already
  installs: a gate in `node_modules` runs only if the repo's own workflow
  remembers to run it, and it moves whenever the lockfile moves — including on
  a Renovate automerge nobody reads. It costs the release pair under
  "Releasing", and it is why gate code is not importable by the repos it
  gates: anything they call directly is a package export instead, which is
  what `route-log.ts` below is.
- `route-log.ts` at the root is the protocol between an app and the
  route-coverage floor: the two strings and the three shapes, exported so that
  neither end reproduces them. It is in `files` and `exports` because a
  consuming repo's app imports the types.
- `db-gate/capacity.js` is the exception: it runs inside k6, not under this
  repo's compiler or linter, which is why `.oxlintrc.json` ignores it. A JSON
  config cannot carry the reason, so it is here.
- `tests/` — a fixture suite per gate, driving it against a violating tree and a
  clean one. A gate without one is a claim; `anti-slop.test.ts` holds every lint
  rule in `anti-slop/` to the same bar — a block of cases per rule, plus
  upstream's own fixtures as a differential oracle over the three rules it ships
  tests for. Two suites are not a gate's: `oxlint-base.test.ts` holds what the
  base config itself must, since an override REPLACES a list-shaped rule rather
  than adding to it, and `action-evidence.test.ts` holds every action publishing
  an artifact to keeping the runner-temp paths its own YAML names.
  `repo-contract-fixture.ts` is the clean tree the repo contract's two suites
  share.
- `docs/gates/*.md` — a reference page per gate. README holds the map.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test        # the gate suites, coverage-floored
```

`bun test` needs a Postgres: the replay gate's property is what two databases
end up holding. It looks at `TEST_DATABASE_URL`, or localhost:5432, and creates
and drops databases there — README's "Gating this repo" has the one-liner.

Two runs may share one server, which is what two worktrees under review are.
Every database either end makes is named for what tells the runs apart: the
suite's own carry the process that created them, and the two the gates build for
themselves — `upgrade_path_<digest>` and `backfill_<digest>` — carry the
checkout they are working on.

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
returns `Problem[]` and takes whatever it reads — a root path, injected
fetchers — as arguments. The entry point is a separate `<name>.main.ts` that
`action.yml` runs: it hands its whole body to `entry()`, so that a throw reaches
the log as an annotation rather than a stack trace, reads the inputs through
`inputs()`, which throws on a missing one, and calls `report()`. Splitting them
is what lets the coverage floor mean something, since nothing can drive an entry
point from a test.

Add the fixture suite and the `docs/gates/` page in the same change, then wire
it into `check.yml`. A diagnostic names what to do, not what went wrong.
