# 1. The gates ship as composite actions pinned by commit SHA

Date: 2026-08-05
Status: Accepted

## Context

The checks in this repo are executable: TypeScript that reads a consuming repo's
tree and fails its build. They could reach the fleet two ways — as part of the
npm package every repo already installs, run from a script in the repo's own CI,
or as composite actions the shared workflow calls by reference.

The package is already installed everywhere and needs no second mechanism. But a
gate that lives in `node_modules` runs only if the repo's own workflow remembers
to run it, and it moves whenever the repo's lockfile moves — including on a
Renovate automerge nobody reads.

## Decision

The gates are composite actions under `.github/actions/`, called from
`.github/workflows/check.yml`, and every reference is a 40-character commit SHA
with the release tag as a trailing comment. A repo adopts a new gate by moving
one pin.

## Consequences

A change here reaches a repo when its pin moves and not before, which is the
point: a new gate cannot turn every repo red overnight, and the diff that adopts
it is reviewable. Renovate keeps the pins current as ordinary dependencies.

The cost is a release pair per change — one tag on the commit that ships the
actions, one on the commit whose workflows pin them — because a commit cannot
reference its own SHA. And the gate code is not importable by the repos it
gates: anything they need to call directly has to be a package export instead.

Revoked if the gates ever need to run outside CI, at which point they are a
library and CI is one of its callers.
