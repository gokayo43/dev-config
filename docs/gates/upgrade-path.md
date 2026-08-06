# The upgrade path

`upgrade-gate: true` adds one property to the database job: **a database built
by upgrading equals a database built fresh.** The migrations of the base ref are
replayed into a second database, this branch's are applied on top of the result,
and the schema that comes out has to be the schema the existing replay already
built from empty. Identical, or the step fails.

It is off by default and belongs to repos whose database is deployed somewhere.
Before the first deploy there is nothing to converge on: rewriting, squashing or
regenerating the whole lineage is free, and this gate would go red for work that
is entirely correct. From the first deploy onwards, the lineage is a
one-way record, and the gate is what says so.

## What it catches

Every schema in the world that is built by replaying a history from empty agrees
with every other one — that is what the existing replay proves. A **deployed**
database is not built that way. It holds what the base ref's migrations put
there, plus the journal rows saying so, and the next deploy applies only what
that journal does not already name.

So an edit to a migration that has already run has two different meanings at
once: on a fresh database it is the new schema, and on every deployed one it is
nothing at all. Nothing errors. The two schemas part company on the day of that
commit and stay parted, and the symptom arrives later as a query against a
column that exists in three environments and not in the fourth.

Two shapes reach this the same way, and the gate refuses both:

- **A migration that has already been applied is edited.** Adding the column to
  the `CREATE TABLE` that made the table, rather than in a new file.
- **A migration is inserted behind one that has already been applied.** What
  rebasing a generated migration under a colleague's produces: the file is new,
  its place in the order is not.

What it does not catch is anything about data. This is a schema comparison, and
a migration that backfills a column wrongly passes it.

## What drizzle's migrator actually does

Probed rather than assumed, against `drizzle-orm` 0.45.2 on the `bun-sql`
driver and Postgres 16 — the house stack's own migrator.

The journal, `drizzle/meta/_journal.json`, gives every migration a `when`: the
millisecond `drizzle-kit generate` wrote it. Applying reads one row —

```sql
select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
```

— and then, for each journal entry in order, executes it **only if
`created_at < when`**, recording the SQL's SHA-256 beside the new `created_at`.

That hash is written and never read. There is no verification of any kind:

- Editing an applied migration's SQL is a **silent no-op**. The run exits 0,
  prints its usual success line, and leaves both the schema and the stored hash
  as they were — the hash in the table still describes the file's old contents.
- Giving an edited migration a **new** `when` makes it re-execute against a
  database that already has its effects, which is a failed deploy rather than a
  silent one — the honest outcome of the two, and still not something to
  discover from a deploy.
- A migration whose `when` sits behind the last applied one is skipped
  **forever**, on every deployed database, while every fresh one gets it.

So the journal is a high-water mark and nothing else. A gate that compared
migration files, or checked whether an already-committed migration was touched,
would be guessing at this; replaying it is the only way to be told.

## How the replay is built

The base ref's migrations, and nothing else, are rolled back into place: for
every lineage in the tree — a directory holding `meta/_journal.json` — the files
the base ref had are written over it, the repo's own `bun run db:migrate` runs
against the second database, and the branch's own files go back before it runs
again. The tree is exactly as it was found afterwards, including when the run
fails partway.

The repo's own migrator, rather than a second checkout: `db:migrate` is often
wrapped in something that derives its own world — a worktree's database, a
compose stack — and run from another checkout every one of those would be
answering about that tree instead of this one.

A lineage the base ref did not have is left alone. There was nothing of it on a
database at that ref, so replaying this branch's copy of it from empty is
precisely what a deploy would do.

The second database is `upgrade_path`, created on the service the calling job
declared. The database the app boots against is the fresh one and is never
touched by any of this.

## Which commit counts as the base

| The run                       | The base                                                 |
| ----------------------------- | -------------------------------------------------------- |
| a pull request                | `git merge-base refs/remotes/origin/<base branch> HEAD`  |
| a push                        | `github.event.before` — the tip the branch had before it |
| anything else, or no `before` | `HEAD^`                                                  |
| a first commit                | none: the step passes with a notice                      |

The merge base rather than the base branch's tip: what a pull request has to
answer for is what it did to the lineage, and migrations the base branch grew
meanwhile are already in the schema both sides build. `github.event.before` is
the honest answer for a push because it names the commit whose schema is
actually running somewhere — a push of five commits is one deploy, not five.

Two ways this could pass by having been handed nothing are refused rather than
skipped: a shallow checkout, and a base branch that is not in the clone. Both
say to check out with `fetch-depth: 0`, which is what `check.yml` does for the
database job.

A base ref that carries no migration lineage at all — the commit before
migrations existed — is a notice and a pass. There is no schema to upgrade from.

## The diagnostic

The step prints every line the two dumps do not share, addressed to whichever
schema has it, and fails with a one-line annotation naming the count and the
first of them. The comparison is `pg_dump --schema-only` minus the `\restrict`
tokens pg_dump randomises per invocation — the same normalisation the replay
from empty uses, because there is one answer to "is this the same schema" and it
lives in one place.

There is no allowlist. Both paths run the same DDL in the same order, differing
only in where they started, so a legitimate divergence would have to come from a
migration that is not deterministic — and the fix for that is the migration, not
an exemption.
