# The capacity ramp

`capacity: true` adds a k6 ramp to the database job, after the app has booted
and answered its health route. It publishes what it measured and asserts only
that a measurement happened.

## What the number means

**A CI-runner-shaped measurement, for comparison against the last one.** It is
not a capacity claim. GitHub's runners vary by machine, by neighbour and by
hour, and the app is sharing one with a Postgres, a Redis and whatever else the
job started. What it is good for is noticing that a change moved the number by
an order of magnitude.

The number that answers "how much load does this hold" is a ramp against the
deployed shape, which testing.md asks for before real users arrive and again
after hot-path changes. This gate does not replace that and is not evidence for
it. It catches the regression between those runs.

## Why there is no threshold

A latency bound on a shared runner fails on a bad neighbour rather than on a bad
commit, and a gate that fails for reasons nobody caused is a gate somebody
switches off. So the step fails in exactly one case: k6 died, or it ran and made
no requests — there is no number to record. Everything else, including a failure
rate, is published for a human to read.

## Turning it on

```yaml
jobs:
  check:
    uses: gokayo43/dev-config/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      database: true
      capacity: true
      capacity-path: /api/things
```

| Input             | Effect                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity`        | Runs the ramp. Needs `database: true`, since it ramps the app the database job booted.                                                                                                                                           |
| `capacity-path`   | A path ramped alongside the health route. A health route measures the socket and one round trip; a real endpoint measures the thing that will fall over.                                                                         |
| `capacity-script` | A k6 script of the repo's own, when the default ramp is the wrong shape — a write path needing a body, an authenticated route. It replaces the shipped script entirely; `HEALTH_URL` and `CAPACITY_PATH` are in its environment. |

Enable it on a repo that serves something: an API with its own process, a server
route that does real work. A static site has nothing to ramp, and a repo whose
only route is a health check will measure its own health check.

## What is published

The run summary gets a table — sustained requests/s, request count, peak VUs,
failure rate, p(95)/p(99)/max latency — and the raw k6 summary is uploaded as
the `capacity-report` artifact, so a run's numbers survive past the log
retention and can be diffed against another run's.

k6 is pinned by version and release-archive SHA-256, the same contract gitleaks
and actionlint carry, and Renovate's `github-release-attachments` datasource
moves the pair together.
