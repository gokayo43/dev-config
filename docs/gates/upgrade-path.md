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

What it does not catch is under "What it cannot see", at the end of this page.

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

**The lineages come from the base ref, not from this branch.** A lineage is a
directory holding `meta/_journal.json`, and the set that has to be replayed is
the set that commit carried — read out of it with `git ls-tree`. Reading the
branch's own directories instead would mean a branch that moved its migrations
elsewhere had no lineage to match, and the gate would pass by not having looked
for one, with whatever was rewritten inside it.

A lineage the base ref carried that this tree no longer has — moved or deleted —
is therefore a **refusal** naming it. A deployed database's journal names the
migrations that built it; relocating or dropping a lineage strands every
database that has one, and no schema comparison can un-strand it.

This tree's own lineages are read too, but only as a safety check on what the
swap would reach — never as the set to replay. A lineage this branch adds
_inside_ one the base ref carried would otherwise be deleted by a swap that
never enumerated it, and the author would be handed a missing-journal error
about a file they had not touched.

The same rule reaches the project directory itself. If `working-directory` did
not exist at the base ref, git is asked whether anything was renamed into it: a
lineage that moved with the project strands its databases exactly as a lineage
moved on its own does, and is refused naming both paths, while a project this
branch adds has no base lineage and passes. Every git read on this path either
answers or refuses — a checkout that is not a repository, or a read that will
not run, is a refusal rather than a quiet "nothing to upgrade from", since that
is the same hole a shallow clone would be.

The base replay runs _this branch's_ `db:migrate` — it is the only migrator
there is — so what it applied is read back out of the journal table rather than
assumed. A lineage the base ref carried that the branch's script no longer names
is skipped by both halves and would compare equal, while a database deployed
from the base ref keeps everything that lineage built. That is a refusal, and
the passing summary names only the lineages actually applied.

A lineage the base ref never had is left where it is. There was nothing of it on
a database at that ref, so replaying this branch's copy of it from empty is
precisely what a deploy would do with it.

For every lineage the base ref did carry, its files are written over the
directory, the repo's own `bun run db:migrate` runs against the second database,
and the branch's own files go back before it runs again. A file the base tree
names outside the lineage directory is refused rather than written: a tree entry
can be called anything `git mktree` will write, `..` included, and one that
escapes the directory is not part of a lineage and would not be put back.

The tree is exactly as it was found afterwards whenever the replay _throws_ —
which is every way it can fail on its own. A process killed outright leaves the
base ref's files in the lineage directory; on the ephemeral runner this gate is
built for, that workspace is discarded either way. If the restore itself fails,
the run says so carrying both that failure and whatever it was already
reporting, and the copy of the branch's files is left in place with its path in
the diagnostic — it is the only copy there is.

The repo's own migrator, rather than a second checkout: `db:migrate` is often
wrapped in something that derives its own world — a worktree's database, a
compose stack — and run from another checkout every one of those would be
answering about that tree instead of this one.

Two lineage shapes are refused rather than replayed, because replacing a
directory is only a local act when that directory holds one lineage and nothing
else: a lineage at the project root (the project would be what got replaced) and
a lineage inside another, whichever side of the change put it there. Both are
refused where the lineages are read, before anything moves.

The second database is created on the service the calling job declared and
dropped again whichever way the comparison goes — and dropped before it is
created, so a run killed between the two ends does not leave the next one
failing over a name its author never chose. A drop that cannot run at all —
the server having gone away under the step — is reported as a notice rather
than raised: the error the step is ending on is the one its author has to read,
and cleanup that replaced it would cost them the reason. What that leaves is
reclaimed the way a killed run's is. The database the app boots against is the
fresh one and is never touched by any of this.

Its name is `upgrade_path_<digest>`, the digest being of the project directory
being replayed. In the shape this ships in — a service container per job — a
fixed name would do; against a server two runs share, deriving it is what keeps
each run dropping and recreating its own database rather than the one the other
is midway through migrating. Of the path and not of a clock, so that one
checkout derives one name on every run: reclaiming what a killed run left behind
is the next run arriving at the same name.

## Which commit counts as the base

| The run                       | The base                                                 |
| ----------------------------- | -------------------------------------------------------- |
| a pull request                | `git merge-base refs/remotes/origin/<base branch> HEAD`  |
| a push                        | `github.event.before` — the tip the branch had before it |
| anything else, or no `before` | `HEAD^`                                                  |
| a first commit                | none: the step passes with a notice                      |

On a pull request `actions/checkout` checks out GitHub's merge commit by default
— this branch merged into the base branch's tip — so the merge base with that
branch _is_ that tip, and the tip is what gets replayed: the commit a deployed
database was actually built from, with whatever the base branch grew meanwhile
already in it. A repo that checks out `github.event.pull_request.head.sha`
instead gets the fork point from the same command, which is the same statement
about the checkout it has. `github.event.before` is the honest answer for a push
because it names the commit whose schema is running somewhere — a push of five
commits is one deploy, not five.

Two ways this could pass by having been handed nothing are refused rather than
skipped: a shallow checkout, and a base branch that is not in the clone. Both
say to check out with `fetch-depth: 0`, which is what `check.yml` does for the
database job.

The table above is one function in `_lib`, not this gate's own: the repo
contract reads the base ref too, for the `lifecycle` field it holds to only
moving up ([repo-contract.md](repo-contract.md)). Two derivations of "the commit
this tree is compared against" would be two answers to the question, and the day
they disagreed nobody would know which was right. Each caller decides for itself
what a checkout that cannot answer costs. A base branch missing from the clone
is fatal in both. A checkout with no history at all is fatal here, and there
only for a repo that is `live` or naming the retirement exemption.

A base ref that carries no migration lineage at all — the commit before
migrations existed — is a notice and a pass. There is no schema to upgrade from.

## The diagnostic

The step prints every line the two dumps do not share, addressed to whichever
schema has it, and fails with a one-line annotation naming the count and the
first of them. The comparison is `pg_dump --schema-only` minus the `\restrict`
tokens pg_dump randomises per invocation.

One function decides it, for both replays. It answers "identical" or a
difference that always carries both a headline and a listing — including for two
dumps holding the same statements in a different order, which is the one shape
a line-by-line reading would call a difference and have nothing to say about. A
red step with an empty explanation is not something this gate can produce.

There is no allowlist. Both paths run the same DDL in the same order, differing
only in where they started, so a legitimate divergence would have to come from a
migration that is not deterministic — and the fix for that is the migration, not
an exemption.

## Semantic fixtures

`semantic-fixtures: <dir>` adds a second property to the same replay: **the rows
a deployed database already holds still mean what this branch says they mean.**

Everything above is a comparison of two schemas, and two schemas converging is
the whole of what it proves. A migration that rewrites what a _value_ stands for
converges perfectly and is wrong everywhere. The canonical one is a `timestamp`
column — digits with no zone attached — converted to `timestamptz` by a
migration written on a UTC machine:

```sql
ALTER TABLE "event" ALTER COLUMN "at" TYPE timestamptz USING "at" AT TIME ZONE 'UTC';
```

Right for every row its author tried it on, and thirteen hours out for every row
a UTC+13 user wrote. Both spellings of that `USING` clause land on
`timestamptz`, so `pg_dump --schema-only` cannot tell them apart and the upgrade
gate passes either. Nothing errors. The rows are simply wrong from that commit
onwards.

So the fixtures are replayed the way the data actually got there:

1. the base ref's migrations, into a database of this gate's own —
   `semantic_fixtures_<digest>`, named the way every database here is named;
2. the repo's fixtures, in filename order, writing the rows a deployed database
   already holds;
3. **this branch's** migrations, on top of those rows;
4. the repo's assertions, asking what those rows now say.

### The rows go in as SQL, never through the app

That is the property the whole gate rests on, and the one shortcut that would
void it. Application code at HEAD writes rows the way HEAD understands them, so
a fixture that went through a model, a repository or a seed script would be
testing the new semantics against themselves — and would agree with any
migration at all, including the one that moved every row thirteen hours.

A fixture is therefore SQL against **the base ref's schema and nothing else**. A
column this branch adds is not one a fixture can name, and the database refuses
it rather than this gate accommodating it: the fixtures run before the branch's
migrations do, which is what that refusal proves.

### The shape of a fixture

A pair per file, in a directory of the repo's own:

```
fixtures/
  01-legacy-events.sql          the rows, as base-compatible SQL
  01-legacy-events.assert.sql   what the current contract says about them
```

```sql
-- 01-legacy-events.sql
insert into "event" ("id", "at") values (1, '2026-01-01 12:00:00');
```

```sql
-- 01-legacy-events.assert.sql
select 'event ' || "id" || ' is no longer the instant it was written as' as violation
from "event" where "at" <> timestamptz '2026-01-01 12:00:00+00';
```

An assertion is **one `select`**, answering no rows when the contract holds and
one row per violation otherwise, each with a text `violation` column saying what
is wrong. Empty is the only pass. The column is named rather than positional,
because a `select *` would have whatever column came first read back as a
sentence about the data; several statements come back as a list of answers
rather than as rows, and nothing could say which of them was the verdict — both
are refused naming the file.

The `NN-` prefix is the order they apply in, and it is load-bearing: a fixture
may write over the rows an earlier one left, the way a history of real rows
accumulates. Directory order is a fact about the filesystem, not an order.

The gate refuses, before it builds anything: a directory that is not there, a
directory with no fixture in it, a fixture with no assertion beside it, an
assertion with no fixture beside it, and any file in the directory that is
neither. Each of those is a gate that would otherwise pass by not having looked,
and every one of them is reported in the same run — one edit to make, one run to
be told the whole of it.

A fixture may hold as many statements as it needs. The whole file goes to
Postgres as one query string, and the simple query protocol wraps such a string
in an implicit transaction, so a fixture applies whole or not at all. One that
will not apply stops the run at that fixture, because the ones numbered after it
may have been written against the rows it was meant to leave.

### It needs the upgrade gate

`semantic-fixtures` without `upgrade-gate: true` is refused at the call site and
again inside the action. The rows are written into the replay of the base ref's
migrations — without that replay there is nowhere to put them, and an input
silently ignored is how a gate somebody asked for turns out never to have run. A
base ref carrying no lineage at all is a notice and a pass, and the notice says
the fixtures did not run either.

The fixtures get a database of their own rather than sharing the upgrade path's.
Rows change what a migration does: `ALTER TABLE ... ADD COLUMN ... NOT NULL`
applies to an empty database and fails on one with a row in it. That failure is
worth catching — it is the class that only ever shows up on the deploy, and the
fixtures are exactly what puts rows there to catch it — but it is a different
question from whether the schemas converge, and answering it in the upgrade
path's database would mean turning this input on changed the verdict of a gate
the repo already had.

### What a semantic fixture cannot see

- **Rows nobody wrote a fixture for.** This grades the rows in the directory and
  no others, the same limit the backfill check has against its seed. The
  boundary values, the nullable columns, the ambiguous historical spellings and
  the rows a destructive transformation touches are the ones worth writing, and
  the directory is where that judgement lives.
- **Whether the assertion is right.** An assertion that asks nothing hard passes
  every migration, exactly as a test that asserts nothing does.
- **Anything outside this database.** A migration that also writes a file,
  queues a job or calls a third party is graded here only on its rows.
- **A migration that is not deterministic.** Two runs of this gate see two
  answers, and only one of them was graded.

## What it cannot see

Named rather than papered over, because a gate whose limits are undocumented
gets trusted for things it never checked.

**A change to where the journal is kept.** Both replays run this branch's
migrator, so a branch that repoints `migrationsSchema` or `migrationsTable`
sends both of them at a new, empty journal: every migration re-applies in both
halves, the two schemas agree, and the gate passes. A real deploy hits the
opposite — the old journal still describes the deployed database, the new one is
empty, and the history re-executes against a database that already has it.
Seeing that would take the base ref's own migrator, which means a second
checkout with its own dependencies, and that is a bigger machine than this gate
is. The same blind spot hides the "never applied" refusal from a repo that
renames its journal table: that check reads the tables drizzle names by default.

**Anything about data, unless the repo wrote a fixture for it.** The comparison
above is of schemas alone; "Semantic fixtures" is where a repo says what its
rows are supposed to mean afterwards, and it grades the rows in that directory
and no others. Whether a backfill survives being run twice is a separate step of
the same gate — [db-gate.md](db-gate.md) — and it says nothing about whether the
backfill is right either.
