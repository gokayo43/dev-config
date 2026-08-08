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

Once it has booted, the job ramps it and publishes what that measured.
That is a step of this gate rather than a gate of its own, and it has a page:
[capacity.md](capacity.md).

Booting is the half that migrations succeeding does not prove. Health answers
200 only after the process has started against that schema and a query has
round-tripped, so a migration that applies but leaves the app unable to run
fails here. The server environment the job sets is the house contract with
dummy secrets — a real secret in a workflow file is a leaked secret — and a repo
whose contract needs more than that extends the workflow rather than the call.
