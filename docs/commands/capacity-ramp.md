# The capacity ramp

`capacity-ramp` answers "how much can this take". It runs k6 against an
address you name, doubles the number of simultaneous users step by step, holds
each step, and stops at the first step that breaks a bound. It tells you the
last step held, the step that broke and which bound broke it, and per path the
slowest, so you know where to start looking. Every repository that installs
`@gokayo43/dev-config` has it:

```sh
bun run capacity-ramp --health http://127.0.0.1:5190/api/health --path /api/things --path /login
```

It is a command and not a CI step. A number measured on a CI runner beside a
database and every other job says little about what the app holds, and a ramp
to the breaking point is load you choose to put on a machine. You run it when a
change could move what the app can take, before a surface first takes real
users, and to back a claim that something got faster: the three triggers in
`~/claude-shared/references/capacity.md`.

## Where you may point it

**Never at a live deployment, and never at a server running on live data.** A
ramp is built to find the point where the target stops answering well, so
whatever it is pointed at stops answering well.

A target that shares something with a live deployment loads the live
deployment through it. A staging copy on the same machine as the live service,
on the same database server, the same Redis or the same processors, passes the
ramp's load to live customers at every step. On such a machine a run is an
action on a live system: it needs the owner's go, and it takes the
`--max-users` that go names, so the ramp stops below the load the owner agreed
to. The command cannot tell a live address from a copy, since both may sit on
`127.0.0.1`. It prints the address it is about to hit before the first request,
and that line is the last place to stop it.

Where to point it, by the shape of the repo:

- **A template-shaped repo** starts its preview stack (`scripts/preview.sh`,
  with `--restore` for production-sized data) and ramps the address that stack
  publishes.
- **A repo with a staging copy of its own on the serving machine** ramps that
  copy only with the owner's go and a `--max-users` from it, as above.
- **A repo with no copy that is safe to ramp**, one whose development servers
  run against the production database, has no target. Say so; do not ramp a
  development server.

## Running it

| Flag            | Default | What it sets                                                                                  |
| --------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--health`      | none    | The address checked before the first step. Required. Paths are added to its origin.           |
| `--path`        | none    | A path to request on every iteration beside the health address. Repeat it for each path.      |
| `--script`      | none    | A k6 script of the repo's own, in place of the shipped one ([below](#a-script-of-your-own)).  |
| `--start-users` | `10`    | The first step's simultaneous users. Each step after it doubles, and the last is the maximum. |
| `--max-users`   | `320`   | The last step.                                                                                |
| `--hold`        | `30s`   | How long each step runs: `500ms`, `30s`, `2m`.                                                |
| `--max-failed`  | `1%`    | A step breaks when more of its requests than this fail.                                       |
| `--max-p95`     | `1s`    | A step breaks when its 95th percentile of response time is above this.                        |

`--start-users 10 --max-users 100` runs steps of 10, 20, 40, 80 and 100 users.
The shipped script requests the health address and then each `--path`, one
after another, on every iteration of every user. The bounds are where "held"
ends; no canon text defines an acceptable latency, so change them when the
surface has its own.

Before the first request it prints what it is about to hit, the steps, and the
longest the run can take. It then checks that the health address answers, runs
each step through k6, and prints each step's verdict as it goes. All of that
goes to stderr. At the end it prints the result to stdout:

```text
# Capacity ramp, 20261120T174406Z

- Target: http://127.0.0.1:5190/api/health, paths /api/things, /login
- Script: the one capacity-ramp ships
- Steps: 10, 20, 40, 80, 160, 320 simultaneous users, each held 30s, k6 v2.2.0
- Bounds: a step breaks past 1.00% failed requests or a p95 of 1000 ms

## Verdict

- Held: 80 users
- Broke: 160 users, on p95
- Previous run: 160 users held, in capacity/20261102T091500Z.json

## Steps

| Users | Requests | Failed | p95 | Verdict |
...

## Slowest paths at 160 users

| Path | Requests | Failed | p95 |
...

Written: /srv/app/capacity/20261120T174406Z.json
         /srv/app/capacity/20261120T174406Z.md
```

| Exit | Means                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | A measurement was made, whatever it found: a broken step is a result.                                    |
| `1`  | No measurement could be made, and no result was written. The reason is on stderr.                        |
| `2`  | The command line could not be read, or `--script` sets steps of its own. The usage is printed on stderr. |

## Reading the result

A run ends in one of four ways:

- **Every step held.** `Held` is the maximum and `Broke` says no step broke a
  bound. The ceiling is above the maximum you set; raise `--max-users` to find
  it.
- **A step broke after at least one held.** `Held` is the last step that held,
  `Broke` is the step after it and the bound or bounds it broke. The ceiling is
  between the two.
- **The first step broke.** `Held` is "no step". Lower `--start-users`.
- **No measurement**, exit 1 with no file: the health address did not answer,
  k6 recorded no request in a step (the script sent none, or none finished
  within the step and k6's 30-second grace after it), k6 itself failed, or the
  run was stopped (Ctrl-C, or a `SIGTERM`) before its last step finished. A
  target that dies part way through is not this case: its refused requests are
  failed requests, and the step breaks on them.

`Failed` counts requests k6 judged failed, by status; `no answer` is a request
that got no response at all. A step that broke on failed requests usually names
the cause in its statuses: `503` from a pool or a limiter, `no answer` from a
process that fell over or a connection limit.

`Slowest paths` lists every path at the step that decided the run, the broken
one or the last one held, slowest first. That is where to start looking: a
pool exhausted below its declared size, a serialized path, an N+1 or a
synchronous hog on the event loop is a defect to fix before the surface ships,
and a machine that is simply full is the number.

`Previous run` is the latest earlier result in the repository for the same
target, the same paths, the same script and the same bounds. A held step lower
than the previous run's is the thing to investigate. Results of another target,
other paths or other bounds are not compared, since their held steps do not
measure the same thing. Each result records the k6 version too, because a ramp
is only comparable with another of the same k6.

## The two files

Every measurement writes `capacity/<UTC stamp>.json` and `capacity/<UTC
stamp>.md` at the root of the git repository the command runs in. Commit both
with the change that ran the ramp, so the repository holds its own history of
what it could take; the next run's `Previous run` line is read from them.

The JSON has the same fields on every run: `tool` (always `capacity-ramp`),
`startedAt`, `k6`, `target` (`health`, `paths`, `script`), `ladder` (`steps`,
`holdMs`), `bounds` (`failed` as a share from 0 to 1, `p95Ms`), `held`, `broke`
(`users` and the `bounds` it broke, or `null`), `steps` (per step: `users`,
`requests`, `failed`, `p95Ms`, `failures` by status, the `broke` bounds and
`paths`, each with `method`, `name`, `requests`, `failed` and `p95Ms`), and
`previous` (`file` and `held`, or `null`). A JSON file in `capacity/` without
`"tool": "capacity-ramp"` is another tool's, and the command passes over it.

## A script of your own

`--script tests/capacity/ramp.js` replaces the shipped script, for a repo whose
traffic needs more than a list of GETs: tokens, a request body, a sequence.
The script exports its default function, which k6 runs once per iteration per
user, and the command sets the steps. It is given `HEALTH_URL` and
`CAPACITY_PATH` (each `--path` on a line of its own) in its environment, beside
the environment the command was started with.

A script whose options set `vus`, `duration`, `iterations`, `stages` or
`scenarios` is refused by name before any request, with exit 2: two owners of
the steps would make the held step mean nothing. Its `thresholds` are not
applied, for the same reason: the bounds are the command's.

Name each request by the route it hits, `http.get(url, { tags: { name:
"/presets/:id" } })`, when a path carries an id: k6 groups `Slowest paths` by
that name, and without it every id is a path of its own.

## k6

The command runs the k6 pinned in this package's `.github/actions/_lib/k6.sh`,
by version and by the SHA-256 of its release archive, and Renovate moves the
two together. The first run fetches it from k6's GitHub releases and checks the
checksum; it is kept in `$XDG_CACHE_HOME/dev-config/k6`, or
`~/.cache/dev-config/k6`, and reused while the pin is unchanged. k6 runs with
its usage report turned off, so the only addresses a run reaches are the
release download and the target.
