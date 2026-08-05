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

The database is then asked directly, through `information_schema.columns`,
whether any column is `timestamp without time zone` — an ORM's `timestamp` is a
hint and the database is the fact, and it will answer without anything having to
parse a schema dump. A wall-clock
column stores the digits someone typed and forgets which clock produced them, so
one row means two different instants either side of a DST boundary or a server
move, and nothing fails until it does. `timestamp-allowlist` takes
`table.column` entries for the columns where a wall-clock reading is the point —
an opening time that is 09:00 wherever the shop is.

Booting is the half that migrations succeeding does not prove. Health answers
200 only after the process has started against that schema and a query has
round-tripped, so a migration that applies but leaves the app unable to run
fails here. The server environment the job sets is the house contract with
dummy secrets — a real secret in a workflow file is a leaked secret — and a repo
whose contract needs more than that extends the workflow rather than the call.
