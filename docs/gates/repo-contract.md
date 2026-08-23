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
| Every `peerDependencies` range refuses some version                                                             | a range that accepts everything says what declaring no peer says, and `bun add` writes one        |
| `typescript` major ≥ 7                                                                                          | the shared tsconfig is written against TypeScript 7                                               |
| `oxlint-tsgolint` present, when `.oxlintrc.json` extends the base                                               | without it oxlint runs the base's type-aware rules over nothing and reports clean                 |
| `tsconfig.json` extends this repo, `.oxlintrc.json` extends this repo, the knip config imports `knip.base.ts`   | a repo that stopped inheriting stops inheriting silently                                          |
| `bunfig.toml` declares `minimumReleaseAge`, `saveExact`, and a coverage floor a run can fail                    | the supply-chain window and the coverage floor are per-repo copies with no `extends` to hold them |
| every rule, category and option `.oxlintrc.json` switches off carries a reason on the line above it             | a switch-off nobody wrote a reason for reads the same as one added to get a run green             |
| `.oxlintrc.json` `extends` the shared base and nothing else, and no oxlint config sits below the root           | a second config is read after the root's and wins over it, in a file this gate never opens        |
| `lefthook.yml` runs a staged gitleaks scan pre-commit and typecheck + tests pre-push                            | the hooks are the half of the gate that runs before a push                                        |
| `.env` untracked and ignored, `.env.example` tracked, neither `.env.example` nor `.env.enc` caught by a pattern | a blanket `.env.*` rule silently deletes the two files that have to ship                          |
| `CONTEXT.md` (or `CONTEXT-MAP.md`), `CLAUDE.md`                                                                 | the docs spine                                                                                    |
| `db:migrate` exists, when `database: true`                                                                      | the database gate replays migrations through it                                                   |
| a job `uses:` this repo's `check.yml` at a 40-hex SHA                                                           | a tag is a name someone else can repoint                                                          |
| `lifecycle` reads `"dev"` or `"live"`, and never moves back down                                                | it is what every rule under "Going live" below reconfigures off                                   |

## What decides which rules run

The gate reads one lint config and one bunfig, so the contract's job is to make
those two files the whole answer. Each rule below closes a way the answer could
live somewhere the gate never opens.

**The coverage floor is graded by what bun does with it, not by whether it is
there.** It has to be a number above 0, or a table whose every key is one of the
three floors bun reads — `lines`, `functions`, `statements` — each above 0. Bun
enforces none of the other ways of writing one: a floor at or below zero, an
empty table, and a key it does not recognise are all ignored in silence (probed,
bun 1.4.0). An unrecognised key is refused rather than skipped for the same
reason `0` is: it is a floor its author believes is being applied.

Two keys are graded and the rest of `[test]` is the repo's own: the threshold
above, and `coverage`, which must be **absent**. Either spelling of it is
refused, because each moves the decision of where the floor is applied out of
CI and into the repo — `true` collects on every run its author makes, so a
scoped `bun test <file>` exits 1 with nothing failing; `false` wins over the
`--coverage` CI passes (probed, bun 1.4.0 and 1.3.11), leaving a declared
threshold applied to nothing at all. The second is the one worth refusing
loudly: that repo passes this gate, reports a floor, and is graded by nothing.
[test-suite](test-suite.md) has the argument and the flag that applies the floor
instead.

`coveragePathIgnorePatterns` is deliberately not graded, though it can excuse a
file from the floor as surely as a low threshold can. Each entry is a line in
the repo's own bunfig with its reason beside it, which is where review already
reads it — the same bargain a lint directive gets. A gate deciding which files
may be excused would be deciding it once, centrally, for repos whose reasons it
cannot see.

**The hedge that leaves:** a repo exempt from `ci-call` does not call
`check.yml`, so nothing applies its floor unless its own workflow passes
`--coverage` by hand — and this gate cannot see that it did. This repo is the
case, and its `ci.yml` passes the flag; `dev-config#58` is where the wider
question of what else that hand-rolled step drops is answered.

**A switch-off carries a reason, and the reason is owed per switch-off.** What
is graded is every entry under `rules`, under any `overrides[].rules`, under
`categories`, and under `options` — a category switched off takes every rule in
it, and `options.typeAware: false` takes the twelve type-aware rules the base
sets at `error`, with no flag in `bun run lint` to put them back. Tightening a
rule or reconfiguring it argues its case in what the rule now demands; switching
one off argues nothing.

A comment above a line says nothing about which of that line's entries it
excuses, so a switch-off sharing its line with another entry a reason could be
about is refused outright rather than guessed at: one switch-off per line, its
reason above. A lone switch-off written inline is unambiguous and passes — what
is counted is a second thing a reason could be for, not a second token. And the
reason has to say something: `//` and `/**/` are comments that argue exactly
what no comment would, and are refused at the same bar `allowlistFrom` holds a
waiver to.

**Off is three spellings, not one.** A rule's setting is oxlint's
`AllowWarnDeny`, whose schema documents `"allow"` as the synonym of `"off"` and
`0` as the number that means it — any of the three also legal as the head of an
array carrying the rule's options. The config's strings are decoded before they
are compared, so `"\u006ff\u0066"` is the same switch-off as `"off"`: oxlint
decodes before it reads a setting, and a gate comparing raw bytes disagrees with
the linter about the file in front of both of them.

**One config, not a chain of them.** `extends` names the shared base and nothing
else, and no `.oxlintrc.*` or `oxlint.config.*` may sit below the repository
root. Both are ways a rule ends up switched off in a file this gate never opens:
a second `extends` target is read after the base and wins over it, and oxlint
resolves the config nearest the file it is linting, so a config in a
subdirectory REPLACES the root's rules for that whole subtree rather than adding
to them — an empty one turns the base off wherever it sits. Neither is followed,
because a per-directory difference already has a home the gate can read:
`overrides` in the root config. The `config-lineage` exemption waives _where_ a
config inherits from and never how many places it inherits from.

`ignorePatterns` is deliberately not graded, and the honest reason is not that it
is a different kind of setting — it silences every rule for the paths it names,
exactly as a switch-off does. It is left out because it is legible in the diff
the way a lint directive is: a path appearing in that list is a line a reviewer
reads as the waiver it is, whereas the settings above hide the same effect
behind a word (`"allow"`, `0`, `false`) or behind a second file. If that stops
being true — a glob broad enough that nobody reads it as a waiver — it belongs
under the same rule as the rest.

The comment is read out of the file's text, because the parse the rest of this
gate runs on is exactly what drops it. Off-ness is decided once, in a single
walk of that text: the walk carries the path it is inside, which is what tells a
`rules` block from a `globals` block, where `"off"` is a legitimate value of a
different vocabulary. `oxlint.base.json` follows the same convention for its own
switch-offs, and is held to this rule by a test that strips one of its reasons
and requires exactly that finding back.

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

`peerDependencies` is graded by the inverse rule, because it is the one field
where a range is the point: it states what a consumer may bring rather than what
this repo installs. The polarity inverts with it — a denylist here, where the pin
check is an allowlist, and the argument above read backwards.

It is not a list of spellings, though, because that set does not close. `*` and
`x` are two of them; so are `>=0`, `>=v0` — a leading `v` is legal range grammar
— `>0.0.0-0`, and every `||` union built out of any of those, since an `||`
takes whatever any one of its operands takes. So the question goes to Bun's own
semver, the engine that reads the range at install time, probed with two
versions no constraining range holds both of: `0.0.0` and `999999.0.0`. `^0` and
`0.x` hold the first and not the second; `>=19` holds the second and not the
first. Each of them constrains, and each passes.

An operand naming no version at all is refused beside those, and says why separately
— it is a dist tag, npm repoints those, and what it points at today is not in
this manifest. A protocol (`workspace:`, `github:owner/repo`) names a source
rather than a range and passes, since floating is the point of declaring one as
a peer — when it is the whole spec. A source is one place and cannot be one
alternative among versions, so `workspace:* || latest` is a union like any
other, graded operand by operand.

The empty range is the one nobody chooses, so it carries a diagnostic of its
own: `bun add <pkg>` for a package the manifest already lists as an **optional**
peer blanks that range and adds no devDependency (bun 1.3.11).

**What this cannot catch.** For a peer _without_ `peerDependenciesMeta.optional`,
the same `bun add` rewrites the range to the exact version it installed — `>=3`
becomes `3.0.1` — and adds no devDependency either. An exact peer range is
legitimate when someone means it, so one manifest cannot tell that rewrite from
a deliberate pin, and there is nothing here to check it against. What catches it
is review, or not running `bun add` for a package the manifest already declares.

Nor most dist tags. What is refused is an operand naming no version at all,
which catches the two people type — `latest` and `next`. A tag carrying a digit
reads as a range and passes: `next-13`, `beta2`. Nothing cheap tells them apart,
and `v2` is genuinely both — a tag someone publishes and the range for 2.x. The
semver above cannot settle it either, in the one direction that would matter: it
reads a string it cannot parse as matching everything, so
`Bun.semver.satisfies("99.0.0", "latest")` is `true` and a tag is
indistinguishable there from a range that takes anything. That is why the tag
check runs first, and why it reads every `||` operand: `latest` on its own would
at least be refused, with the wrong diagnostic, but `latest || 1` answers false
to both probes — so without the operand check it passes in silence, a range npm
cannot resolve with nothing said about it. A tag carrying a digit still draws
nothing.

Nor a range that is absurd rather than open. The probe is two versions, not a
proof, so something admitting everything under a ceiling nobody will reach —
`>=0.0.0 <999998` — passes it. Writing a semver solver of this repo's own is the
only thing that would close that, and no manifest has ever contained one.

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
| the `check.yml` call passes `database: true`        | the repo owns a database | nothing replays the schema otherwise, and the gate below has no job to run in                                                                                   |
| the `check.yml` call passes `upgrade-gate: true`    | the repo owns a database | from the first deploy the migration lineage is a one-way record — editing a migration that has already run is a silent no-op on every database that has seen it |
| `scripts/backup.sh` exists and is executable        | the repo owns a database | an undumped database is one nobody has                                                                                                                          |
| `scripts/restore-drill.sh` exists and is executable | the repo owns a database | a backup nobody has restored is a backup nobody has                                                                                                             |
| a timer/service pair that runs each of them         | the repo owns a database | a script nothing runs on a schedule is one that ran the day it was written (below)                                                                              |

Only crash reporting is owed by every live repo. The rest is about a database,
and half this fleet is a static site with a hostname and no schema — demanding a
backup script of one would teach people to write a script that does nothing in
order to get past a gate. The upgrade gate is scoped the same way for a harder
reason than symmetry: `check.yml` **refuses** `upgrade-gate: true` without
`database: true`, so asking for it there would be this contract demanding the
one configuration the shared workflow rejects.

**"Owns a database" is a fact of the tree, never a script name and never the
`database` input.** Four witnesses, any one of them enough: a script called
`db:migrate`, a script called `migrate`, a `drizzle.config.*` anywhere in the
workspace, or a `.sql` under a `drizzle/` or `migrations/` directory. The
diagnostic names the witness it found, so a repo that genuinely has no database
has something concrete to argue with.

A script name alone was the hole, and it was a wide one: `db:migrate` is what
this house asks for, `migrate` is what drizzle-kit's own template writes — and
what the live repo on this box with the most data actually runs. Under the old
rule that spelling answered "no" and the repo owed **nothing**: no backups, no
rehearsed restore, no upgrade gate, silently, because of a colon. The `database` input says which CI job runs, and it lives in
the very file these rules are about — so keying off it would let a live repo
shed its backup script, its rehearsed restore and its upgrade gate by deleting
one line of its own workflow. A repo that owns a database and passes
`database: false` is told so by name rather than quietly excused.

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

### A scheduled job is three files

Canon says a backup is taken and a restore is rehearsed _periodically_. A script
is only the program; what makes either of them periodic is a systemd timer on
the box, and a timer that exists only on the box is a schedule no diff has ever
been reviewed against and no rebuild reproduces. So a live repo tracks a
`.timer` and the `.service` it activates under `scripts/`, per job.

**The names are the repo's.** systemd's unit namespace is the whole box, so
every stack deployed beside another prefixes — `/opt/postpad/scripts/` holds
`postpad-backup.timer`, not `backup.timer` — and a gate demanding a fixed
filename would be one no repo on this box could satisfy while remaining
installable. What the gate looks for is a **pair**: any `scripts/*.service`
whose `ExecStart` runs `scripts/<job>.sh`, with a `scripts/*.timer` of the same
stem beside it. More than one pair may run one script — a nightly and a weekly,
say — and the job is scheduled if any of them schedules it.

Three facts are then read out of that pair, which are exactly the three that
decide whether the job ever runs:

- the `.timer` sets `OnCalendar=` or `OnUnitActiveSec=` under `[Timer]`. Not
  `OnBootSec`: a unit that runs once per boot is a startup task, and a box that
  stays up for a month runs it once — which is the state a backup and a
  rehearsed restore both exist to rule out.
- the `.timer` sets `WantedBy=` under `[Install]`. `systemctl enable` refuses a
  unit with no install section, so a timer without one is a schedule nobody can
  turn on. The section is read rather than the file: the same line under
  `[Timer]` is silently nothing, which is the unit that looks enabled in a diff
  and fails on the box.
- the `.service` **runs** the script it is the pair for. The first
  whitespace-separated word of `ExecStart=` is the program and the rest are
  arguments, so `env WRAPPED=backup.sh /usr/bin/true` names the script and never
  executes it, and `/bin/sh -c '…/backup.sh'` runs a shell — which is what then
  decides the exit status systemd reads, so a failing drill comes back green.
  `pre-backup.sh` is a different program whose name ends the same way. A
  substring test calls every one of those a match. systemd's `-@+!:` prefixes
  are stripped first, since they say how to run the command rather than what it
  is, and an empty `ExecStart=` is the list reset — a unit that sets one after
  its command runs nothing at all.

  The **path** matters as well as the name: `/usr/local/bin/backup.sh` is not
  this repo's script. What is checked is the trailing segments, `scripts/<job>.sh`,
  because that is the most a checkout can honestly assert — the unit on the box
  says `/opt/postpad/scripts/backup.sh` and the gate is looking at
  `/home/runner/work/postpad/postpad`, so "is this path inside the repo" has no
  answer here. What it cannot catch on its own is another stack's copy of the
  same relative path; see below.

A timer may point at a service of a different name with `[Timer] Unit=`, which
systemd honours and so does this — a gate matching only stems would call a
working schedule missing.

**Drop-in directories are refused rather than read.** A `*.timer.d/` beside a
unit is merged over it by systemd and ignored here, so a schedule living in one
is a schedule no diff of the unit file shows.

**The two jobs have to agree about where the repo lives.** A unit copied from
the stack next door keeps its neighbour's path, and that is the one wrong
location a checkout _can_ catch: `backup` pointing at `/opt/postpad/scripts/`
and `restore-drill` at `/opt/other/scripts/` means one of them is scheduling
somebody else's data. Nothing else here can see it, since a checkout has no idea
what directory it will be deployed into.

Both jobs, not just the drill. "The drill has a timer and the backup does not"
is the same hole from the other side.

**What the repo cannot say is whether the timer is enabled.** `systemctl enable
--now <repo>-restore-drill.timer` happens on the box, and no checkout can read
it — so that is the owner's step. What the gate closes is the state where nobody
ever wrote the schedule down.

What the gate also cannot say is anything about what the script _does_. It reads
that a `.service` execs `scripts/restore-drill.sh` and that a `.timer` activates
that service; whether the drill restores into a throwaway and never into the
live database is the script's own business, in the repo that owns it. That
belongs to the scaffold rather than to this gate:
[project-template#30](https://github.com/gokayo43/project-template/issues/30)
carries what the template owes here — the `restore-drill` unit pair (it ships
only `backup`'s today), and the drill dropping its throwaway when it passes.

A field that is absent, or reads anything but those two words, is its own
problem and the only one reported — a repo that has not said which it is gets
graded against neither set of rules, because choosing for it is exactly what the
field exists to prevent.

## It only moves up

`dev` is where every repo starts and says nothing about anyone, so anything is
reachable from it. `live` says people are on the other end, and that does not
stop being true because a line was tidied out of a manifest — so the tree in
front of the gate is not the only witness. The field is read at the **base ref**
as well, and the two are compared:

| Base ref | This tree | Verdict                                    |
| -------- | --------- | ------------------------------------------ |
| `dev`    | `live`    | the commit the field exists for            |
| `live`   | `live`    | every other commit a live repo makes       |
| `live`   | `dev`     | refused — name `lifecycle-retire` if meant |
| `live`   | absent    | refused — the same edit, less visible      |

Writing `dev` over `live`, or deleting the field, sheds backups, a rehearsed
restore, crash reporting and the upgrade gate in one edit that reviews as a
whitespace change. Deleting the manifest outright is refused a line earlier, by
the rule that a repo has a `package.json` at all.

The base ref is the merge base with the branch a pull request targets, or the
tip a push had before — the same resolution [the upgrade
gate](upgrade-path.md) uses, out of one module. It is read **relative to the
working directory**, so a monorepo's workspace is compared with its own earlier
manifest rather than with whatever the repository root happened to say. A
project the base ref did not carry has no earlier declaration to be held to, and
neither does a first commit: both pass.

Two things can stop the base ref being readable, and they are not the same
problem:

- **The base branch is not in the clone.** The run named a ref and the checkout
  does not carry it. That is a broken run, not a repo with nothing to be
  compared against, so it is **refused whoever is asking** — `dev` repos
  included. It is the same answer [the upgrade gate](upgrade-path.md) gives the
  identical condition.
- **The checkout has no history at all** — a shallow clone. Refused **while the
  repo is `live`**, which is the commit before the one that could violate the
  rule. A `dev` repo never needed history here and is not made to start failing
  on a depth it has always been gated on.

What that second rule does **not** do is make the check undefeatable, and it is
worth being plain about the residual. A repo whose CI is a call into `check.yml`
cannot reach it: `fetch-depth: 0` is set there, not by the caller. A repo
holding the `ci-call` exemption owns its own workflow, and can put
`fetch-depth: 1` and the flip to `"dev"` in the same pull request — the shallow
checkout silences the comparison in the very commit that needs silencing. The
rule raises the cost of moving the field down from an invisible diff to a
visible change of the workflow's checkout depth. It does not make it impossible,
and nothing in this gate can: a repo that owns its own CI can always decline to
run the gate at all.

A directory that is not a repository never reaches any of this. `manifests`
cannot list a tree git will not read, so the contract has already refused it.

## Retiring one

A repo really is wound down sometimes, and that is a decision rather than a
diff. `lifecycle-retire` at the call site is where it gets written down:

```yaml
with:
  contract-exemptions: lifecycle-retire
```

It waives the comparison with the base ref and nothing else. The repo still has
to say which of the two words it is, because retiring is moving the field down
rather than deleting it — and once it reads `"dev"`, the rules under "Going
live" stop applying because the repo is a `dev` repo, which is correct: a `dev`
repo owes none of them. The exemption did not excuse the backups; the lifecycle
did.

**It is refused the moment it is waiving nothing.** Every other exemption here
states something permanent about what a repo _is_. This one states that a repo
is in the middle of being wound down, which stops being true — and left behind
it becomes a standing licence to move the field back down, granted once and
never looked at again. So it is satisfied by exactly one state, base `live` and
this tree not `live`, and reported otherwise:

| The state                                      | What the gate says                        |
| ---------------------------------------------- | ----------------------------------------- |
| base `live`, tree `dev`                        | nothing — this is what it excuses         |
| base `dev`, tree `dev` (the retirement landed) | `lifecycle-retire is waiving nothing`     |
| base `live`, tree `live` (never came down)     | `lifecycle-retire is waiving nothing`     |
| the checkout cannot say                        | `lifecycle-retire cannot be checked here` |

That last row is the same door the shallow case would otherwise leave open:
naming the exemption is what obliges the run to be able to show it is still
doing something, so a waiver cannot be parked behind a `fetch-depth: 1` forever.

# Exemptions

Some facts a repo cannot satisfy because of what it is, not because nobody got
round to it — this repo cannot extend itself by package name, and its CI cannot
pin a commit it is in the middle of making. Those are named at the call site:

```yaml
with:
  contract-exemptions: config-lineage ci-call secrets
```

| Exemption          | Waives                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-lineage`   | _where_ the configs inherit from — not whether they exist                                                                                               |
| `ci-call`          | the SHA-pinned call into `check.yml`, and with it the `upgrade-gate: true` a live repo passes to that call — there is no call to pass it to             |
| `docs-spine`       | the glossary and `CLAUDE.md`                                                                                                                            |
| `lifecycle-retire` | the comparison with the base ref's `lifecycle`, for a repo being deliberately wound down — not the field itself, and refused once it is waiving nothing |
| `secrets`          | the `.env` / `.env.example` shape, for a repo with no runtime environment                                                                               |

Every exemption is echoed as a `::notice` in the run, and a name outside the
table fails rather than waiving anything — a typo cannot quietly turn a check
off. The list is the whole mechanism: there are no per-repo special cases inside
the gate.

The gate reads tracked files plus untracked ones git would keep — the set
`.gitignore` already describes. That is what lets it run against a tree a
scaffolder has just written into, where every new file is untracked, without
reading build output.
