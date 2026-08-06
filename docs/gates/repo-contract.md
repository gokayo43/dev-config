# The repo contract

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
| `lifecycle` reads `"dev"` or `"live"`                                                                           | it is what every rule under "Going live" below reconfigures off                                   |

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
whose own spec is exact, or a git dependency **whose ref is a commit**. A tag
can be repointed and `#main` moves by design, so `github:owner/repo#v1.2.3` is
refused exactly as `github:owner/repo` with no ref is — only a 40-character
commit names one tree for good.

# Going live

Nothing can derive whether a repo is carrying real people. A repo with a
hostname, a compose file and a backup script looks exactly like one three days
from its first deploy, and the difference is the whole difference — so the repo
declares it, in one field of its root `package.json`:

```json
{ "lifecycle": "dev" }
```

`project-template` scaffolds `"dev"`. Moving it to `"live"` is the owner's own
commit, made when the repo starts serving users, and it is the only thing that
has to be remembered: everything below is derived from that word rather than
turned on one gate at a time, because a checklist is something you can do half
of.

| What `"live"` requires                              | When                     | Why it cannot wait                                                                                                                                              |
| --------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a Sentry SDK among what the workspace ships         | always                   | a failure only the user sees is one nobody fixes                                                                                                                |
| the `check.yml` call passes `database: true`        | the repo owns migrations | nothing replays the schema otherwise, and the gate below has no job to run in                                                                                   |
| the `check.yml` call passes `upgrade-gate: true`    | the repo owns migrations | from the first deploy the migration lineage is a one-way record — editing a migration that has already run is a silent no-op on every database that has seen it |
| `scripts/backup.sh` exists and is executable        | the repo owns migrations | a systemd timer runs it directly, and an undumped database is one nobody has                                                                                    |
| `scripts/restore-drill.sh` exists and is executable | the repo owns migrations | a backup nobody has restored is a backup nobody has                                                                                                             |

Only crash reporting is owed by every live repo. The rest is about a database,
and half this fleet is a static site with a hostname and no schema — demanding a
backup script of one would teach people to write a script that does nothing in
order to get past a gate. The upgrade gate is scoped the same way for a harder
reason than symmetry: `check.yml` **refuses** `upgrade-gate: true` without
`database: true`, so asking for it there would be this contract demanding the
one configuration the shared workflow rejects.

**"Owns migrations" is read from the repo, never from the `database` input.**
The signal is a `db:migrate` script, which is the entry point every database
gate here drives. That input says which CI job runs, and it lives in the very
file these rules are about — so keying off it would let a live repo shed its
backup script, its rehearsed restore and its upgrade gate by deleting one line
of its own workflow. A repo that owns migrations and passes `database: false` is
told so by name rather than quietly excused.

Any `@sentry/*` package satisfies the first, in any manifest in the workspace,
and only among what that manifest ships — `dependencies` and
`optionalDependencies`. Sentry ships one SDK per runtime (`@sentry/bun`,
`@sentry/astro`, `@sentry/tanstackstart-react`, `@sentry/react-native`) and the
fact asserted is that something in the repo reports its crashes, not which
package a given program reaches for; a list of the ones this house uses today
would fail the first repo on a runtime nobody had thought of. A devDependency
builds and tests the repo and reaches no deployment, and a peer range states
what a consumer may bring, so an SDK in either is a repo whose crashes nobody
hears.

A field that is absent, or reads anything but those two words, is its own
problem and the only one reported — a repo that has not said which it is gets
graded against neither set of rules, because choosing for it is exactly what the
field exists to prevent.

# Exemptions

Some facts a repo cannot satisfy because of what it is, not because nobody got
round to it — this repo cannot extend itself by package name, and its CI cannot
pin a commit it is in the middle of making. Those are named at the call site:

```yaml
with:
  contract-exemptions: config-lineage ci-call secrets
```

| Exemption        | Waives                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-lineage` | _where_ the configs inherit from — not whether they exist                                                                                   |
| `ci-call`        | the SHA-pinned call into `check.yml`, and with it the `upgrade-gate: true` a live repo passes to that call — there is no call to pass it to |
| `docs-spine`     | the glossary, `docs/adr/` and `CLAUDE.md`                                                                                                   |
| `secrets`        | the `.env` / `.env.example` shape, for a repo with no runtime environment                                                                   |

Every exemption is echoed as a `::notice` in the run, and a name outside the
table fails rather than waiving anything — a typo cannot quietly turn a check
off. The list is the whole mechanism: there are no per-repo special cases inside
the gate.

The gate reads tracked files plus untracked ones git would keep — the set
`.gitignore` already describes. That is what lets it run against a tree a
scaffolder has just written into, where every new file is untracked, without
reading build output.
