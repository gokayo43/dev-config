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
- `.github/workflows/check.yml` — the gate every repo calls. `queue-guard.yml`
  and `queue-audit.yml` are the same idea for the issue queue.
- `.github/actions/*/` — the executable gates. Each is an `action.yml` plus a
  TypeScript entry point; `_lib/gate.ts` is what they share.
- `tests/` — a fixture suite per gate, driving it against a violating tree and a
  clean one. A gate without one is a claim.

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
2. the commit that repoints `check.yml` and the queue workflows at (1) — bump
   `version` again, tag that.

Consumers pin the actions at (1) and the workflow call at (2). A tag must sit on
exactly the commit its pins name. After tagging, bump `project-template`'s pins:
`setup/ci.yml`, `setup/queue-*.yml`, `.github/workflows/template.yml`, and
`DEV_CONFIG` in `setup.ts`.

## Adding a gate

Write the check as `.github/actions/<name>/<name>.ts` exporting a pure function
that returns `Problem[]`, with a thin `import.meta.main` block reading its
inputs through `_lib/gate.ts`'s `inputs()`. Add the fixture suite in the same
change, then wire it into `check.yml`. A diagnostic names what to do, not what
went wrong.
