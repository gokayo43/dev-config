# The capacity ramp

`capacity: true` adds a k6 ramp to the database job, after the app has booted
and answered its health route. It publishes what it measured, and asserts three
things about it: that a measurement happened, that the app answered the requests
it was measured on, and that no route the app serves sat the ramp out.

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
More than a tenth of the requests failing is the one number this gate refuses.

That bound is applied to the summary, and the shipped script declares no
threshold of its own. A repo pointing `capacity-script` at a script of its own
replaces the shipped file entirely, and a rule a caller can drop by accident is
not a rule — so the gate that reads the summary is the single place it lives,
whatever ran the ramp.

So the step fails when: k6 died, or more than a tenth of its requests failed; it
ran and made no requests, so there is no number to record; the summary it wrote
is not the shape this gate reads — a missing stat, a file that is not a k6
export; or a route the app serves was never exercised (below). Latency,
throughput and a failure rate under a tenth are published for a human to read.

## The route-coverage floor

**A floor, in the sense the coverage threshold is one.** It catches the route
that no load has ever touched — an endpoint shipped without the ramp being
extended to reach it — and claims nothing at all about whether the load that did
touch a route resembles production traffic. Passing it means every route has
been under load once, not that the app is fast, and not that the scenario is
realistic. Shipping an endpoint the ramp does not reach is red for the same
reason shipping code with no test is.

The app counts what its routes take, and serves the tally on one endpoint —
`GET /__route-log` — whenever `ROUTE_LOG` is `true`, which the ramp sets:

```json
{
  "routeTable": [
    { "method": "GET", "path": "/health" },
    { "method": "POST", "path": "/presets" }
  ],
  "counts": [{ "method": "GET", "path": "/health", "count": 12 }]
}
```

`routeTable` is every route the app serves; `counts` is how many requests each
of them has taken since the process started. The ramp step fetches this once
before k6 runs and once after, and **coverage is the difference**: a route whose
count rose is a route the ramp reached.

That difference is what keeps this action's own traffic out of the floor. The
app is already serving by the time the ramp starts — the boot step polls the
health route until it answers — and a route the poll reached shows up in the
first fetch, so only what the ramp added counts.

The endpoint leaves itself out of both lists: it is an instrument, not a route
the floor is about, and the gate's two fetches are not the scenario's traffic.

What "covered" means precisely, then, is **took traffic between the two reads** —
not "k6 sent it a request". Anything else talking to the app during the ramp
counts too: a container `HEALTHCHECK`, an uptime probe, a sidecar. On a runner
that is normally only k6, but a repo whose `capacity-script` does not ramp the
health route can still see it covered by a healthcheck polling it, and the floor
will not have caught what it looks like it caught. If that matters, ramp the
route explicitly rather than reading the pass as proof.

### Why a counter, and why an endpoint

An app can tell a gate what its routes are doing two ways: announce each hit as
an event, or keep a count and let the gate read it. The event form is the
tempting one — it needs no endpoint, and stdout is already being captured — and
it is the wrong one.

Announcing every request puts an access log's worth of I/O on the hot path the
same step is measuring, so any real version of it samples: at most one line per
route per second, say. That sampling is where the race lives. Coverage then
means "did a line for this route land inside the ramp's window", and whether it
did depends on when the route last announced itself — a route answering on both
sides of the ramp boundary inside one sampling interval reads as uncovered,
having been exercised throughout. The arithmetic is fine; the question is the
wrong one to have to ask, because it is about _when_ something was said rather
than about what happened.

A count is a state rather than an event, so two reads of it subtract, sampling
never enters into it, and timing stops being part of the answer. It costs one
request per run instead of one line per route per second, needs no log parsing,
no line shapes and no offset into a file, and leaves stdout as something people
read rather than a protocol. What it buys with is an endpoint — which is why
that endpoint is flag-gated, absent entirely from a deployment, and excluded
from what it reports.

Both lists name the route **as the router registered it**, not as a URL:
`/presets/42` is reported as `/presets/:id`. That is what keeps the gate out of
the matching business, and it is not only convenience — where routes overlap, a
literal `/presets/new` beside `/presets/:id`, only the router knows which one
answered, and a gate that guessed would credit coverage to a route that served
nothing.

A route registered for every method (`ALL`) is covered by whichever method
reached it. A route the ramp cannot cover goes in `route-allowlist` as a
`METHOD /path -- why` entry: the reason is part of the entry, the same price a
lint directive pays. An entry is refused in its turn when it is not a route,
when it names a route the app does not serve, and when it waives a route the
ramp **did** exercise — an escape hatch nobody can see rotting is how a gate
quietly stops covering what it names, and a waiver whose reason has stopped
being true is exactly that.

The usual entries are a CORS plugin's `OPTIONS` handlers, and their reason is
worth knowing, because it is not "no load generator sends a preflight": a
handler that answers **before** the request reaches a route is invisible to the
floor whatever reaches it. `@elysiajs/cors` answers every `OPTIONS` that way,
including one to a route the app registered itself, so such a route can be
ramped and still never appear. The reason on the entry is what says which of the
two is true — unreachable by the ramp, or unseeable by the floor.

An app whose route table comes back empty fails the step: a floor that cannot
see the routes is not a floor, and "the app named nothing" is exactly the
never-load-tested case this exists to catch. So does an app that serves no
`/__route-log` at all, which is the same failure one step earlier.

## Turning it on

```yaml
jobs:
  check:
    uses: gokayo43/dev-config/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      database: true
      capacity: true
      capacity-path: /api/things, /api/things/:id
      route-allowlist: OPTIONS /* -- the cors plugin answers these before the request reaches a route
```

| Input             | Effect                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity`        | Runs the ramp. Needs `database: true`, since it ramps the app the database job booted.                                                                                                                                                                                                                                    |
| `capacity-path`   | Paths ramped alongside the health route, comma- or newline-separated. A health route measures the socket and one round trip; point these at the endpoints doing the work the project is for, and prefer ones that read or write. Every route the app serves belongs here or in `route-allowlist`.                         |
| `capacity-script` | A k6 script of the repo's own, when the default ramp is the wrong shape — a write path needing a body, an authenticated route. It replaces the shipped script entirely; `HEALTH_URL` and `CAPACITY_PATH` are in its environment, and the failure bound and the route floor hold it exactly as they hold the shipped ramp. |
| `capacity-report` | The artifact name for the k6 summary. A matrix that ramps more than one leg gives each its own, since an artifact name may only be claimed once.                                                                                                                                                                          |
| `route-allowlist` | Routes the ramp cannot cover, as `METHOD /path -- why` entries matching the app's own route table, comma- or newline-separated. The reason is part of the entry and an entry without one is refused — that is the whole price of the hatch.                                                                               |

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
