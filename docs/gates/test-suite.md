# The test suite

`bun test`, run so that a green suite means something: the run happened, no test
skipped, no test asserted nothing, and nothing in it reached a live host.

## The unit lane

"Unit lane" here is not a naming convention a repo opts into — it is the job
this step runs in. `check.yml`'s `static` job declares no service containers, so
the suite it runs has nothing but the runner: no database, no cache, no
third-party host. Everything that needs one of those is the `database` job,
which runs [the database gate](db-gate.md) rather than `bun test`. So the lane
is decided by the workflow and this step only has to hold it to what it already
is.

A test that dials a live host in that lane costs three things. It is slow in
proportion to somebody else's latency; it is graded by somebody else's uptime,
so it fails on the day the gate is loudest and passes on re-run; and it makes
the suite untrue about what it covers, since the assertion that survived was
about a response nobody in this repo wrote.

So the run is **sealed**: `bun test` is executed inside a network namespace with
no route out of it, and the connection fails at the line that made it. Not a
proxy variable a test can unset, not a firewall rule that outlives the step that
set it — a namespace, which goes away with the process that had it.

Loopback is inside the seal and is brought up. A test that starts a server and
calls it on `127.0.0.1` is talking to itself, and refusing that would be
refusing the in-process integration test rather than the live call. The runner's
own ports are on the other loopback either way: a service container published on
`localhost` is not reachable from inside the namespace, which is the same
statement as "this lane has no database".

Two facts about how the seal is taken, both load-bearing if the step is ever
edited:

- **It goes through `sudo`.** The unprivileged form (`unshare --map-root-user`)
  is refused on the runner image, where AppArmor's
  `kernel.apparmor_restrict_unprivileged_userns` reads `1` and the `uid_map`
  write is denied. GitHub-hosted Linux runners have passwordless `sudo`; a
  self-hosted one has to grant it, and the step says so rather than running
  unsealed.
- **The suite drops straight back to the invoking user.** Nothing it writes —
  coverage, snapshots, the junit report — lands root-owned in a workspace the
  steps after it still have to write to. `PATH` is restated across that hop
  because `sudo` takes it from `secure_path` whatever the environment says, and
  the Bun the runner installed is not on it. `TMPDIR` does not survive either,
  with or without `--preserve-env`: `sudo` drops it unconditionally. On a
  GitHub-hosted runner nothing sets one, so the suite gets `/tmp` as it always
  would; a self-hosted runner that points `TMPDIR` somewhere deliberate — a
  larger disk, a tmpfs — will not see it inside the seal.

## What the seal costs

A suite that starts its own datastore is the case to know about, because it
fails inside the seal and the failure looks like the gate rather than like the
lane. `docker run -p 5432:5432 …` from inside the namespace _starts_: the
daemon is reached over a unix socket, and a filesystem socket is not network.
The container's published port is on the host's loopback, though, and the
namespace has its own — so nothing in the suite can connect to what it just
started, and the run fails on connection refused.

The fix is not the escape. A datastore a unit lane needs is either in-process
(PGlite, an embedded store) or reached over a unix socket, both of which work
inside the seal untouched; a datastore a _suite_ needs is the `database` job's
subject, and that job does not run through this step. The escape is for a suite
that reaches somebody else's host, which is a different thing and a rarer one.

## Naming a suite that has to reach a network

The `test-network` input is the reason, not a switch:

```yaml
with:
  test-network: the payment contract tests run against the provider's sandbox
```

Non-empty unseals the whole suite and prints the reason as a notice on the run.
It is read in review exactly like the reason on a lint directive, and it is
about the suite — "it is slow otherwise" is a statement about the seal and not
an answer. Empty, which is every repo until one has an answer, is sealed.

The value is trimmed before it is read, the way every allowlist entry in this
repo is: a reason made of spaces is not one, and a workflow that wrote `"   "`
gets the seal rather than a waiver nobody can read. It also has to fit on one
line — a workflow command ends at the first newline, so everything after it
would land in the log as whatever those lines happen to spell, which is worse
than no reason because it reads like the whole one. A multi-line value is
refused outright.

There is no per-file form of this. `bun test` grades coverage over one process
against `bunfig.toml`'s `coverageThreshold`, so splitting the suite into a
sealed run and an open one would grade each half against the whole floor and
fail both — a lane split that costs the coverage gate is not a lane split worth
having.

## The run the report proves happened

`bun test` writes a junit report, and two of its fields are read back:

- `skipped="0"` on the root element. A suite that skips when its infrastructure
  is absent leaves CI green over nothing at all, which is the failure mode this
  whole page is about, arriving through a different door.
- no `assertions="0"` on any test case. A test that returned early, or one whose
  property predicate returned a boolean instead of asserting, is
  indistinguishable from a test that never ran.

The report is uploaded whatever happened to the run, because a failing suite is
exactly when the per-test detail is worth having.

## Cancellation

The runner cancels a job by signalling the process it started — SIGINT, then
SIGTERM 7.5 seconds later, then SIGKILL 2.5 seconds after that — and by
signalling nothing else in the tree. A suite left in the foreground therefore
outlives the shell that started it: still running, inside a namespace nothing
on the box can see into, on a machine the runner is about to reclaim. So the
suite runs as a job this step owns and the signal is forwarded to it; `sudo`
passes it down, and the tree goes with it.
