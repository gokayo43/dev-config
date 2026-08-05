# Context

The vocabulary this repo is written in. Terms only — how any of it works lives
in `README.md`, and why the irreversible choices were made lives in `docs/adr/`.

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

**Denylist** — the dependencies the house stack has already answered, each with
the pick it lost to. An entry may carry an **ADR glob**, which unlocks it once
the deviation is written down.

**Escape hatch** — a way to proceed past a gate that costs the same work as
recording the decision: an ADR file, a healthcheck opt-out carrying its reason,
a lint directive carrying its reason. A hatch that costs nothing is a hole.

**Pin** — a reference by content rather than by name: a commit SHA for an
action or a workflow, a SHA-256 for a released binary, a digest for an image,
an exact version for a package. The tag beside a pin is a label; the hash is
the contract.

**Release pair** — the two tags a change to this repo produces: one on the
commit that ships the composite actions, one on the commit whose workflows pin
them. A consumer pins the second.

**Queue vocabulary** — the labels an issue may carry. Six of them are states,
exactly one per open issue; `commitment` is an orthogonal marker meaning the
body names the event that makes the issue due.
