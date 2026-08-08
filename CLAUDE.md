# dev-config

The tooling policy for every Bun repo here, in one place: the shared configs
repos inherit, and the CI gates they call. `CONTEXT.md` is the vocabulary,
`docs/adr/` holds the decisions that were hard to reverse, and `README.md` is
the reference for how each piece is consumed.

## Canon

The house rules live outside this repo and win over anything here:
`~/claude-shared/STACK.md` (one pick per slot), `architecture.md`, `testing.md`,
`principles.md`. This repo is where several of those rules become executable, so
a change to a rule usually lands here too.

## Layout

- `*.base.json` / `knip.base.ts` / `lighthouserc.json` — the bases repos inherit.
  Anything keyed to a repo's own paths does not belong in one.
- `default.json` — the Renovate preset, resolved by a bare `github>owner/repo`.
- `.github/workflows/check.yml` — the gate every repo calls.
- `.github/actions/*/` — the executable gates. Each is an `action.yml`, a gate
  module the suite drives, and a `*.main.ts` that GitHub runs. `_lib/gate.ts` is
  what they share. The shell helpers beside it are `pinned-tool.sh` — the
  verified fetch every pinned binary goes through — and `k6.sh`, which is that
  fetch plus the one k6 pin, so the three ramps in this house run one binary.
- `route-log.ts` at the root is the protocol between an app and the
  route-coverage floor: the two strings and the three shapes, exported so that
  neither end reproduces them. It is in `files` and `exports` because a
  consuming repo's app imports the types.
- `db-gate/capacity.js` is the exception: it runs inside k6, not under this
  repo's compiler or linter, which is why `.oxlintrc.json` ignores it. A JSON
  config cannot carry the reason, so it is here.
- `tests/` — a fixture suite per gate, driving it against a violating tree and a
  clean one. A gate without one is a claim. `action-evidence.test.ts` is the one
  suite that is not a gate's: it holds every action publishing an artifact to
  keeping the runner-temp paths its own YAML names. `repo-contract-fixture.ts`
  is the clean tree that gate's two suites share.
- `docs/gates/*.md` — a reference page per gate. README holds the map.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test        # the gate suites, coverage-floored
```

`bun test` needs a Postgres: the replay gate's property is what two databases
end up holding. It looks at `TEST_DATABASE_URL`, or localhost:5432, and creates
and drops databases there — README's "Gating this repo" has the one-liner.

Run one suite at a time against a given Postgres. `replay.test.ts` builds the
upgrade path in a database whose name is fixed — `upgrade_path`, because that is
the name the gate itself uses — and drops it at both ends, so two runs sharing a
server delete each other's database mid-migration and report failures neither
tree has. Give a second run its own `TEST_DATABASE_URL`.

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
exactly the commit its pins name. After tagging, bump `project-template`'s pins:
`setup/ci.single.yml` and `setup/ci.monorepo.yml` (one per shape, and both carry
the workflow call), `.github/workflows/template.yml`, and `DEV_CONFIG` in
`setup.ts`.

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
