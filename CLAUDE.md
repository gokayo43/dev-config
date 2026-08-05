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
  module the suite drives, and a `*.main.ts` that GitHub runs; `_lib/gate.ts`
  and `_lib/gh.ts` are what they share.
- `tests/` — a fixture suite per gate, driving it against a violating tree and a
  clean one. A gate without one is a claim.
- `docs/gates/*.md` — a reference page per gate. README holds the map.

## Commands

```sh
bun run check   # format:check + lint + typecheck + knip
bun test        # the gate suites, coverage-floored
```

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
`setup/ci.yml`, `.github/workflows/template.yml`, and `DEV_CONFIG` in
`setup.ts`.

## Adding a gate

Write the check as `.github/actions/<name>/<name>.ts`, exporting a function that
returns `Problem[]` and takes whatever it reads — a root path, injected
fetchers — as arguments. The entry point is a separate `<name>.main.ts` that
`action.yml` runs: it reads the inputs through `inputs()`, which throws on a
missing one, and calls `report()`. Splitting them is what lets the coverage
floor mean something, since nothing can drive an entry point from a test.

Add the fixture suite and the `docs/gates/` page in the same change, then wire
it into `check.yml`. A diagnostic names what to do, not what went wrong.
