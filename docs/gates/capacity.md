# The capacity ramp

`database: postgres` ends in a k6 ramp, after the app has booted and answered its
health route. It publishes what it measured, and asserts three things about it:
that a measurement happened, that the app answered the requests it was measured
on, and that no route the app serves sat the ramp out.

There is no knob. An app the database job can boot is an app that serves
something, and a serving surface nothing has ever put under load is the case
this exists to catch — so a repo cannot be in the position of having the ramp
available and switched off. What a repo still chooses is _what_ the ramp hits:
`capacity-path`, a `capacity-script` of its own, and the reasoned
`route-allowlist` for whatever neither can reach.

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

Both are the same ramp, and the reader that turns k6's summary into a table is
the same reader — `project-template`'s `scripts/preview-capacity.sh` runs it
against a preview stack on the box that would serve it. What separates them is
one input, `ran-on`, naming the machine the ramp found: `ci-runner` or
`deployed-shape`. It decides nothing about the measurement and everything about
the sentence printed under it, because the same number means two different
things depending on what was underneath it — and a table that claimed the wrong
one would be a capacity claim nobody made. A value outside those two is refused
rather than defaulted.

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

The floor covers **the program `start-command` boots**, and only that one. In a
monorepo that is the API; a web app in the same repo serves its own routes, has
no instrument, and appears in no route table — so a green notice is a statement
about the booted program, not about every route in the repository.

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
being true is exactly that. An entry with no reason is asked none of those three
questions: it fails the step for the missing reason, still waives its route, and
one mistake earns one diagnostic.

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

## Aiming it

```yaml
jobs:
  check:
    uses: gokayo43/dev-config/.github/workflows/check.yml@<commit sha> # <release tag>
    with:
      database: postgres
      capacity-path: |
        /api/things
        /api/things/:id
      route-allowlist: |
        OPTIONS /* -- the cors plugin answers these before the request reaches a route, so no ramp can make one visible
```

| Input              | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity-path`    | Paths ramped alongside the health route, one per line. A health route measures the socket and one round trip; point these at the endpoints doing the work the project is for, and prefer ones that read or write. Every route the app serves belongs here or in `route-allowlist`.                                        |
| `capacity-script`  | A k6 script of the repo's own, when the default ramp is the wrong shape — a write path needing a body, an authenticated route. It replaces the shipped script entirely; `HEALTH_URL` and `CAPACITY_PATH` are in its environment, and the failure bound and the route floor hold it exactly as they hold the shipped ramp. |
| `db-gate-evidence` | The artifact name for everything the gate leaves behind. A matrix that runs more than one leg gives each its own, since an artifact name may only be claimed once.                                                                                                                                                        |
| `route-allowlist`  | Routes the ramp cannot cover, as `METHOD /path -- why` entries matching the app's own route table, one per line. The reason is part of the entry and an entry without one is refused — that is the whole price of the hatch.                                                                                              |

Every one of these, and `upgrade-gate` and `timestamp-allowlist` with them, is
aimed at a step of the database job — so passing any of them with
anything but `database: postgres` fails the run and says which, rather than being ignored. A repo that has written out the
routes it wants ramped, or the reasons a route cannot be, has said plainly that
it expects a ramp.

A repo whose only route is a health check measures its own health check, and the
floor passes on it — which is the true statement about a repo that serves
nothing yet. It stops being a formality the moment a real route is added, since
that route has to be ramped or reasoned about by name.

## What is published

The run summary gets a table — mean requests/s, request count, peak VUs, failure
rate, p(95)/p(99)/max latency — and everything the steps wrote into the runner
is uploaded as the `db-gate-evidence` artifact, so a run's evidence survives past
the runner that produced it:

| File                    | What it answers                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `capacity.json`         | the raw k6 summary, which the table is read from and another run's can be diffed against                             |
| `route-log-before.json` | what the app declared it serves, and what the boot poll had already reached                                          |
| `route-log-after.json`  | the same, after the ramp — the floor's verdict is the difference between the two                                     |
| `server.log`            | what the app said while all of that happened — copied while the process still holds it open, so the tail may be torn |

The upload runs whatever the steps before it did, so a floor that failed, a ramp
that died on the way to a number, and an app that never answered its health poll
all leave the same evidence behind. The boot step still prints `server.log` into
its own output when it gives up, because a failure you can read without
downloading anything is one fewer round trip.

The requests/s row is the whole run divided by its whole duration, ramp-up and
ramp-down included, because that is the only rate k6's summary carries. For an
app whose throughput scales with concurrency it sits below the plateau the
ramp held — around a quarter below, for the shipped stages. Read it against the
last run, which rode the same stages; it is not the number the app sustained.

k6 is pinned by version and release-archive SHA-256, the same contract gitleaks
and actionlint carry, and Renovate's `github-release-attachments` datasource
moves the pair together.
