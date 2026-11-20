# Context

The vocabulary this repo is written in. Terms only — how any of it works lives
in `README.md`, and why a choice was made lives at the choke point that made it:
a comment where the code decides, or a line in `CLAUDE.md`.

**Base** — a configuration file here that a consuming repo inherits rather than
copies: `tsconfig.base.json`, `oxlint.base.json`, `design-system.base.json`,
`knip.base.ts`, `lighthouserc.json`. A base holds what is true of every repo it
applies to; anything keyed to a repo's own paths is not a base's business.

**Design system** — a product's stylesheet theme plus its shared components
directory. A page that uses a colour, a value or a component style from outside
them has drifted from it.

**Gate** — a check that can fail a build. A gate has a name, a diagnostic that
says what to do about it, and a fixture suite proving it refuses a violating
tree and passes a clean one. A check that cannot fail is a report.

**Export** — a module in this package that a consuming repo imports and calls,
as against a gate, which runs over that repo from CI. The distinction is not
packaging: a gate reads a tree from outside and can be pinned to a commit, and
an export is for the facts only visible from inside a running repo — its own
route table, its own limiter, its own browser. Gate code is deliberately not
importable, so anything a repo imports from this package is an export.

**Command** — a module in this package that a consuming repo runs rather than
imports: installing the package puts it in `node_modules/.bin`, and
`bun run <command>` reaches it with no script of the repo's own. Distinct from
a gate, since nothing in CI runs it, and from an export, since nothing imports
it.

**Conformance suite** — an export that registers tests rather than answering
with problems, because what it grades is a sequence rather than a value. It
takes the repo's implementation and the resources it needs, and the repo's own
`bun test` is what runs it. Distinct from a gate: nothing in CI knows it exists
until the suite it is part of fails.

**Conformance kit** — request timing's checks a repo's own test calls, which
register no test of their own: one against its booted server, which grades one
operation's record; one over a Next.js app's route files, which grades how each
handler is wrapped; and one of the app's own Effect, which grades where its
waits are counted. Distinct from a conformance suite, which registers its
tests, and known to CI: the repo contract requires a live repo that serves HTTP
and owns a database to have a test importing the kit, and one importing its
Effect check where it ships `effect`, or to say at the call site how its
operations are timed otherwise.

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
repo _is_ — this is about who it owes. `live` is what the crash reporting is
derived from; the swept browser suite for a repo that ships pages; for a repo
that owns migrations, the backups, the rehearsed restore and the upgrade gate as
well; and for one that also serves HTTP, the request-timing conformance tests.
All of it read from the repo rather than from a workflow input, so that going live is one word rather than a checklist somebody does half of, and
cannot be undone by editing the workflow those rules govern. It only moves up:
`dev` says nothing about anyone, `live` says people are on the other end, and a
repo that is genuinely being wound down says so with an exemption rather than
with a deleted line.

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
making the claim checkable. A hatch that costs nothing is a hole, and prose is
close to nothing where the claim is about _behaviour_: the gate can only take it
on trust, so there the hatch names the run that grades it instead. The three in
use, and which kind each is:

- a lint directive or an allowlist entry carrying its reason after `--` — prose,
  because what it waives is a judgement about this line and the reason is
  addressed to the next reader;
- `x-no-healthcheck`, which names the test asserting the service can never
  answer one **and** says why — a behavioural claim, so it costs a test file git
  lists as well as the sentence;
- `x-host-network`, which stays prose. What it waives is a deployment
  requirement — this listener needs the host's stack — rather than a claim about
  what the service does at runtime, so there is no run for it to point at.

**Boundary alias** — the one place a type nobody modelled may be named: an alias
at the module that owns a trust or wire boundary, carrying a single disable with
the why. `ConfigObject` is the boundary between a gate and a file another repo
wrote. Distinct from an escape alias, which is the same declaration re-exported
for anyone who wants one — the linter cannot tell them apart, so review does.

**Ratchet** — a rule that blocks from now on, with the violations predating it
named per file in `overrides` and drained by a tracked issue. A new one fails
immediately, and the whitelist going empty is what deletes the block. Distinct
from an exemption, which is about what a repo is, and from a downgrade to `warn`,
which stops the rule blocking anything at all.

**Floor** — a bound set below what honest work already produces, there to catch
the absence of the work rather than to be aimed at: the coverage threshold, the
route compatibility floor, and the fuzzer's four invariants. A floor says a
route is still there at all, or that a request nobody expected is refused
rather than crashed on; it says nothing about whether the route still answers
what it used to.

**Nightly** — a run of the shared check that nobody is waiting on: the same
gates over the same tree, with the searches that scale given room to run, and
one issue per repo for as long as it stays red. Distinct from the schedule that
starts it, which is the caller's own trigger, and from a gate: nothing new is
asserted, the same assertions are made harder to satisfy.

**Budget** — what a search is allowed to spend, decided by the run rather than
written into the code being searched: a wall clock for the fuzzer, a multiplier
and a time limit for a property. Distinct from a timeout, which bounds something
that has gone wrong; a budget bounds something that could go on forever and is
worth more the longer it does. A budget is never a bar to clear — what it stops
is a pass.

**Held step** — the most simultaneous users a capacity ramp's target answered
inside both bounds, failed requests and the 95th percentile of response time.
The step after it is the broken step, and the bound it broke is where to start
looking. A held step is compared only with another of the same measurement: the
same k6, target, paths, script, steps, hold and bounds. A result records that
measurement and names its predecessor of it and no other.

**Route table** — the routes an app serves, named by the app itself as its
router registered them (`/presets/:id`, not `/presets/42`). Only the router
knows which route answered a URL, so it is the only honest source, and both
floors over it are measured against it.

**Operation** — the innermost named handler a server's framework dispatches: a
matched route handler, one RPC procedure, one server function, named as its
router registered it. A request that only carries procedures, such as a tRPC
batch, is not one; each procedure in it is. Distinct from a request, which is
what reached the server, and from background work, which belongs to no
operation.

**Wait** — a span in which an operation waits on something outside its own
code: its database (`db`), an outside HTTP service (`out`) or an in-memory store
such as Redis (`store`). A wait belongs to the operation that issued it,
whoever settles it.

**Record** — the one line of JSON an operation closes into when its response has
finished: its name, method, status, total time, and per kind of wait the summed
time and the count. It is derived, never edited, and nothing of a person can
be represented in it.

**The rest** — an operation's total time minus the time during which at least
one of its waits was in flight. It holds the code's own time and every wait
nobody measured, so it is never called the app's code.

**Sink** — the function an app hands request timing when it switches it on,
which writes each record to stdout. The export itself writes nothing.

**Route snapshot** — a repo's committed `routes.snapshot.json`: its route table
as of a commit, which is what makes the table readable at a ref nothing boots.
The gate that reads it also generates it and refuses any difference from the
booted app, so it is a golden the app itself keeps honest rather than a file
somebody maintains.

**Pin** — a reference by content rather than by name: a commit SHA for an
action or a workflow, a SHA-256 for a released binary, a digest for an image,
an exact version for a package. The tag beside a pin is a label; the hash is
the contract.

**Release pair** — the two tags a change to this repo produces: one on the
commit that ships the composite actions, one on the commit whose workflows pin
them. A consumer pins the second.

**Queue vocabulary** — the three labels an issue may carry, each set only on the
owner's word. An open issue with no label is new: nobody has ruled on it.
`parked` means the owner has seen it, has not decided, and does not want it
raised again; `roadmap` marks an agreed direction with no date; `commitment` is
agreed work whose **Trigger:** line says when to check it. GitHub's close
reasons say whether a closed one was completed or declined. Nothing in CI reads
any of it — it is a convention, kept because agents rather than people are the
ones re-reading the queue.
