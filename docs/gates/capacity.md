# The capacity ramp

`capacity: true` adds a k6 ramp to the database job, after the app has booted
and answered its health route. It publishes what it measured, and asserts that a
measurement happened and that the app answered the requests it was measured on.

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

## Why there is no latency threshold

A latency bound on a shared runner fails on a bad neighbour rather than on a bad
commit, and a gate that fails for reasons nobody caused is a gate somebody
switches off.

That reasoning covers latency and throughput, which are the runner's to move. It
does not reach a failure rate: a request the app refused is refused on every
machine, and a ramp whose requests are mostly errors measures the error path.
The shipped script bounds that one at `http_req_failed: rate<0.10`.

So the step fails when: k6 died, or more than a tenth of its requests failed; it
ran and made no requests, so there is no number to record; or the summary it
wrote is not the shape this gate reads — a missing stat, a file that is not a k6
export. Latency, throughput and a failure rate under a tenth are published for a
human to read.

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

| Input             | Effect                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capacity`        | Runs the ramp. Needs `database: true`, since it ramps the app the database job booted.                                                                                                                                                                                                                                   |
| `capacity-path`   | A path ramped alongside the health route. A health route measures the socket and one round trip; point this at an endpoint doing the work the project is for, and prefer one that reads or writes.                                                                                                                       |
| `capacity-script` | A k6 script of the repo's own, when the default ramp is the wrong shape — a write path needing a body, an authenticated route. It replaces the shipped script entirely, failure threshold included, so carry your own `thresholds: { http_req_failed: [...] }`; `HEALTH_URL` and `CAPACITY_PATH` are in its environment. |
| `capacity-report` | The artifact name for the k6 summary. A matrix that ramps more than one leg gives each its own, since an artifact name may only be claimed once.                                                                                                                                                                         |

Enable it on a repo that serves something: an API with its own process, a server
route that does real work. A static site has nothing to ramp, and a repo whose
only route is a health check will measure its own health check.

## What is published

The run summary gets a table — mean requests/s, request count, peak VUs, failure
rate, p(95)/p(99)/max latency — and the raw k6 summary is uploaded as the
`capacity-report` artifact, so a run's numbers survive past the log retention
and can be diffed against another run's.

The requests/s row is the whole run divided by its whole duration, ramp-up and
ramp-down included, because that is the only rate k6's summary carries. For an
app whose throughput scales with concurrency it sits below the plateau the
ramp held — around a quarter below, for the shipped stages. Read it against the
last run, which rode the same stages; it is not the number the app sustained.

k6 is pinned by version and release-archive SHA-256, the same contract gitleaks
and actionlint carry, and Renovate's `github-release-attachments` datasource
moves the pair together.
