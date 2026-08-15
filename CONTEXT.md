# Context

The vocabulary this repo is written in. Terms only — how any of it works lives
in `README.md`, and why a choice was made lives at the choke point that made it:
a comment where the code decides, or a line in `CLAUDE.md`.

**Base** — a configuration file here that a consuming repo inherits rather than
copies: `tsconfig.base.json`, `oxlint.base.json`, `knip.base.ts`,
`lighthouserc.json`. A base holds what is true of every repo; anything keyed to
a repo's own paths is not a base's business.

**Gate** — a check that can fail a build. A gate has a name, a diagnostic that
says what to do about it, and a fixture suite proving it refuses a violating
tree and passes a clean one. A check that cannot fail is a report.

**Deny tier** — the rules set to `error`. `warn` is advisory and cannot fail a
build, so the deny tier is the whole of what a lint config enforces.

**Repo contract** — the facts a repo declares about itself that the rest of the
tooling reads: the package manager, the config lineage, the install and coverage
policy, the hooks, the shape of its secrets, the docs spine, the pinned CI call.
Each one is a string that can be deleted, and deleting one turns a gate into a
no-op rather than a failure.

**Exemption** — a named contract fact a repo is structurally unable to satisfy,
declared at the call site. Distinct from an unfinished one: an exemption is a
property of what the repo _is_, and it is visible in the caller's diff.

**Lifecycle** — whether a repo is carrying real people, declared by the repo in
one field and inferred by nothing: `dev` or `live`. Distinct from a deployment,
which is a thing that has happened, and from an exemption, which is about what a
repo _is_ — this is about who it owes. `live` is what the crash
reporting is derived from, and — for a repo that owns migrations — the backups,
the rehearsed restore and the upgrade gate as well. All of it read from the repo
rather than from a workflow input, so that going live is one word rather than a
checklist somebody does half of, and cannot be undone by editing the workflow
those rules govern. It only moves up: `dev` says nothing about anyone, `live`
says people are on the other end, and a repo that is genuinely being wound down
says so with an exemption rather than with a deleted line.

**Base ref** — the commit a tree is compared against: the merge base with the
branch a pull request targets, or the tip a push had before it. One derivation,
shared by every gate that asks — the upgrade path, which replays its migrations,
and the repo contract, which reads its `lifecycle`. Distinct from a checkout
that cannot say: no earlier commit is an answer, a shallow clone is not, and
each gate decides for itself what the second one costs.

**Denylist** — the dependencies the house stack has already answered, each with
the pick it lost to. A repo that keeps one anyway names it in the gate's
allowlist, with the reason, at the call site the rest of its exemptions live in.

**Escape hatch** — a way to proceed past a gate that costs the same work as
saying why: a healthcheck opt-out carrying its reason, a lint directive or an
allowlist entry carrying its reason after `--`. A hatch that costs nothing is a
hole.

**Boundary alias** — the one place a type nobody modelled may be named: an alias
at the module that owns a trust or wire boundary, carrying a single disable with
the why. `ConfigObject` is the boundary between a gate and a file another repo
wrote. Distinct from an escape alias, which is the same declaration re-exported
for anyone who wants one — the linter cannot tell them apart, so review does.

**Floor** — a bound set below what honest work already produces, there to catch
the absence of the work rather than to be aimed at: the coverage threshold, and
the capacity ramp's route coverage. A floor says a route has been under load
once; it says nothing about whether that load resembled production.

**Trend line and claim** — the two things a capacity ramp can produce, from one
script and one reader. On a CI runner the app shares a machine with a Postgres,
a Redis and a neighbour nobody chose, so the number is only comparable with the
last run's: a trend line. Against the deployed shape it is the claim testing.md
asks for. `ran-on` names which happened, because nothing downstream can tell.

**Route table** — the routes an app serves, named by the app itself as its
router registered them (`/presets/:id`, not `/presets/42`). Only the router
knows which route answered a URL, so it is the only honest source, and the
capacity ramp's floor is measured against it.

**Pin** — a reference by content rather than by name: a commit SHA for an
action or a workflow, a SHA-256 for a released binary, a digest for an image,
an exact version for a package. The tag beside a pin is a label; the hash is
the contract.

**Release pair** — the two tags a change to this repo produces: one on the
commit that ships the composite actions, one on the commit whose workflows pin
them. A consumer pins the second.

**Queue vocabulary** — the two labels an issue may carry. An open issue with no
label is a proposal, and GitHub's close reasons say whether a closed one was
completed or declined; `roadmap` marks an agreed direction with no date, and
`commitment` means the body names the event that makes the issue due. Nothing
in CI reads any of it — it is a convention, kept because agents rather than
people are the ones re-reading the queue.
