# Repos with a database

`database: true` adds a second job: an empty Postgres — plus a Redis, for the
shapes whose health route pings one — the migrations replayed onto it, and the
app booted against the result. `start-command` and
`health-url` are how a repo names its own app; everything else is the same for
every repo, which is why it lives in the workflow rather than at the call site.

An empty database is the one state no developer machine is ever in, and it is
the state every deploy to a new box and every restore drill starts from. A
migration carrying `ALTER TABLE ... DROP CONSTRAINT` for a constraint an earlier
`DROP TABLE ... CASCADE` has already taken is the shape that gets through: it
succeeds on the database it was written against, where that constraint was still
there, and aborts the first time the history runs onto nothing — a database that
cannot be rebuilt, discovered at the worst possible moment. Replaying from empty
on every push is what turns that into a red build.

The migrations then run a second time, and the gate is not the exit code but
`pg_dump --schema-only` before and after: the schema has to come out
identical. An exit code only says the second run did not error; the dump
says the database came out in the same state, which a `push`-style sync or a
hand-rolled runner can exit 0 without doing. With a journalled migrator the pass
is cheap and proves the journal is honest; with anything that re-executes SQL,
it proves the SQL is re-runnable.

Both replays are one program, `db-gate/replay.ts`, because both are decided by
the same comparison. `upgrade-gate: true` adds a third replay to it — from the
base ref's migrations rather than from empty, which is where a deployed database
starts — and that one has a page: [upgrade-path.md](upgrade-path.md).

The database is then asked directly, through `information_schema.columns`, which
of its columns are `timestamp without time zone`. An ORM's `timestamp` is a hint
and the catalogue is the fact, and asking it means nothing here has to parse a
schema dump. A wall-clock column stores the digits someone typed and forgets
which clock produced them, so one row means two different instants either side
of a DST boundary or a server move, and nothing fails until it does.

`timestamp-allowlist` takes `schema.table.column` entries for the columns where
a wall-clock reading is the point — an opening time that is 09:00 wherever the
shop is. The schema is part of the key because two of them can hold the same
table, and an allowlist that could not tell `app.events.occurred_at` from
`public.events.occurred_at` would exempt both. Entries are one per line rather
than space-separated, because a quoted identifier can itself contain a space.

Each entry carries `-- why`, the same price `route-allowlist` pays and the same
one a lint directive pays: an exemption nobody had to justify is one nobody can
review a year later. An entry without a reason fails the step — and still
exempts its column, because reporting the column as well would be two
diagnostics for one mistake.

An entry is refused when nothing under grade answers to it, which is the other
half of the same rule. The step reads every column in the schema, not only the
wall-clock ones, so it can say which of the two ways an entry died:

- the column is still here and is no longer a wall-clock one — the conversion
  the entry exempted it from has been made, so the entry goes;
- the schema has no column of that name at all — dropped, renamed, or never
  spelled the way the entry spells it, so the entry goes or the name does.

Nothing suppresses that check the way `stack-allowlist`'s is suppressed while a
manifest will not parse. That rule exists because a walk that came up short
reports every waiver written for the part it could not read; here the catalogue
is one query, which either answered in full or failed the step outright.

```yaml
with:
  timestamp-allowlist: |
    public.opening_hours.opens_at -- the shop's own clock, 09:00 wherever it is
    public.audit log.at -- the shift board's wall time, not an instant
```

## The repo's own probe

`probe-command` is one command of the repo's own, run against the booted app
after it has answered its health route and before the ramp. A real process, a
real HTTP client, a real migrated database, no layer stubbed.

It exists because the two floors either side of it cannot ask this question.
Health answering 200 proves the app **starts** against that schema. The route
floor proves every route was **reached**. Neither says a single answer was
_correct_ — so a migration that applies, boots, and serves every route while
quietly reinterpreting what a column means passes both of them. The upgrade
gate's semantic fixtures ask that of the data
([upgrade-path.md](upgrade-path.md)); this asks it of the app's answers, which
is the only place some of it is visible at all.

What it asserts is the repo's, because only the repo knows what its answers are
supposed to be. So the contract is the smallest one that can carry a claim this
gate cannot read:

- **stdout is the verdict** — every line the command writes there is one
  problem, whatever it exits with;
- **a command that exits non-zero having written nothing** is a failure the gate
  words for itself, because a red step with an empty explanation is the one
  thing no gate here may produce.

Stdout rather than the exit status, because the status is the half a probe gets
wrong. A runner that collects failures and reports them at the end, a shell
function whose last command happened to succeed, a `set +e` somebody added while
debugging: each of those prints exactly what is broken and then exits 0. Reading
the status first would make the gate's answer depend on the one thing about a
repo's own program it cannot see, and the failure mode is silence over an app
that said out loud what was wrong with it.

`capacity-script` hands a repo the same authorship one step later, and for the
same reason: the gate owns the running, the repo owns the meaning.

```yaml
with:
  probe-command: bun run scripts/probe.ts
```

The command runs as shell — a pipe or an `&&` means what it says — in the
project the caller declared, with the app's URL in `HEALTH_URL`, the same name
the boot step and the ramp use for it. Its environment is the job's, less the two
ways of asking for colour and the terminal type they are read off: stdout is the
protocol here, and a problem arriving wrapped in escape codes is a problem
nobody can match to a route.

Everything the command wrote, stdout and stderr both, reaches the log above the
annotations.

`probe-timeout` bounds it, in seconds, and empty takes the bound `probe.ts`
declares — 120 seconds today — which is where that number and the argument for
it live. An hour is the most it takes: `setTimeout` holds its delay in a signed
32-bit integer, so a bound at or above 2147484 seconds overflows to a
millisecond and kills the probe the instant it starts, under a diagnostic saying
it ran too long. The probe
runs against an app that is already up, so it is making requests rather than
waiting for a boot; the bound is there because a probe that has wedged is
otherwise indistinguishable from a slow one, and would spend the job's whole
budget saying so, taking the ramp and every piece of evidence after it down with
it. A probe killed by the bound is refused naming it: whatever it would have
written after that is lost, so nothing it was asserting was graded.

**The bound takes everything the probe started.** The command runs under
`setsid` (util-linux, on every runner this gate targets), so its shell is a process-group leader and the kill addresses the
group. That is not a detail: bash only _execs_ a command that is one simple
command, so a pipeline, a subshell, a background job or a command that forks a
child of its own leaves children behind when the shell alone is killed — and
those children still hold the write end of the stdout pipe, so the step reading
it never sees the end of the output. A bound that hangs is worse than no bound,
because the job's whole timeout goes with nothing said. A probe meaning to leave
something running behind it will not: that is the trade a bound is.

Its output is capped at fifty annotations, with a line saying how many there
were. A probe is one or two contract-level assertions per invariant, so an
honest one is nowhere near that; four thousand annotations render as neither a
list nor a page, and the whole output is on the log either way. Escape sequences
are stripped from a line before it becomes an annotation — the environment
already asks every child here not to colour, but a probe that colours
unconditionally would otherwise put `ESC[31m` inside the annotation.

The step runs when **either** input is set, and a `probe-timeout` with no
`probe-command` under it is refused — a bound on nothing is an input somebody
wrote that nothing would have read.

### What this cannot catch

- **Anything the repo did not write a probe for.** One or two contract-level
  probes per critical invariant is what this is sized for, and what is not
  asserted is not checked.
- **Anything about the deployed shape.** This is one process on a CI runner
  against a database built ten seconds ago.
- **Whether the probe is right.** A probe that exits 0 without asserting
  anything passes every build, exactly as a test that asserts nothing does.

Once it has booted, the job ramps it and publishes what that measured.
That is a step of this gate rather than a gate of its own, and it has a page:
[capacity.md](capacity.md).

Booting is the half that migrations succeeding does not prove. Health answers
200 only after the process has started against that schema and a query has
round-tripped, so a migration that applies but leaves the app unable to run
fails here. The server environment the job sets is the house contract with
dummy secrets — a real secret in a workflow file is a leaked secret — and a repo
whose contract needs more than that extends the workflow rather than the call.

## Backfills

`backfill-seed` and `backfill-command` add one property: **running the
backfill a second time leaves what the first run left.** Both are shell, both
are optional, and each without the other fails the step — an input silently
ignored is how a gate somebody asked for turns out never to have run.

```yaml
with:
  backfill-seed: bun run scripts/seed-pre-slug.ts
  backfill-command: bun run scripts/backfill-slugs.ts
```

A backfill is not a thing that runs once. `principles.md` requires them to be
idempotent because every way of running one twice is ordinary: a phased rollout
finds a range it missed, a deploy dies halfway and is retried, the expand step
ships on Tuesday and the backfill runs again on Friday for the rows written in
between. The shape that does not survive that — an `insert` with no conflict
clause, an `update` guarded on nothing, a counter incremented rather than set —
does not error. It doubles rows, and it looks like a backfill that worked until
somebody counts them.

So the step builds a database of its own on the declared service —
`backfill_<digest>`, derived from the project directory for the reason
[upgrade-path.md](upgrade-path.md) gives for its own — migrates it with the
repo's own `db:migrate`, runs `backfill-seed` once and `backfill-command` twice,
and compares `pg_dump --data-only --inserts` either side of the second run. Its own database rather than the declared one because
the seed writes rows, and the boot step below claims the app comes up against
a database its migrations built.

The comparison is of rows, and a row is a whole `INSERT` statement rather than a
line of one. The dump is sorted, since heap order is a fact about when
autovacuum last woke rather than about the data — and sorting is exactly why the
unit matters: `--inserts` writes a value's own newlines raw, so two databases
holding `(1, 'A⏎B'), (2, 'C⏎D')` and `(1, 'A⏎D'), (2, 'C⏎B')` are one multiset
of _lines_ and different rows. Everything pg_dump writes that is not an `INSERT`
is dropped by what a whole statement starts with, which is also why no filter
here can reach inside a value: the `SET`s, the comments, the `\restrict` token
randomised per invocation, and the `setval` that moves a sequence whether or not
a row landed — an `on conflict do nothing` consumes one either way, and refusing
that would be refusing the guard rather than the backfill.

A seed that leaves no rows behind is refused rather than passed. A backfill
against a database the migrations have just built has nothing to find, so
running it twice would compare two empty databases and certify whatever the
backfill does.

All three dumps — the state the seed wrote, and the data after each run — leave
the run in the evidence artifact, whichever of them the step got as far as
writing. They are named `.rows` rather than `.sql` because that is what they
are: the `INSERT`s sorted, with everything that is not a row taken out. It is
what the step compared, not a script that would rebuild anything if you fed it
back.

### What this cannot catch

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

- **Anything the seed does not write.** Idempotency is proved over that state
  and no other. A backfill that is not idempotent on a row shape the seed has no
  example of passes, and the seed is where that is fixed.
- **Whether the backfill is right.** That a second run changes nothing says
  nothing about whether the first run did the correct thing.
- **A run killed midway.** Both runs here go to completion. A backfill that is
  idempotent between whole runs and not between a killed one and its retry —
  anything that records progress outside the transaction it is progressing in —
  looks the same to this.
- **Two of them at once.** There is one writer here, so nothing about racing
  backfills is exercised.
- **Effects outside this database.** Files written, jobs queued, third-party
  calls made. A backfill that emails every user twice passes.
- **Anything that is not a row.** Sequence positions, dropped above, and large
  objects, which `pg_dump --data-only` writes as `lo_*` calls rather than as
  rows. A value's own newlines and blank lines are _not_ on this list: a row is
  compared as a whole statement, which is what makes that true.
