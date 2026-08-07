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

The second database is `upgrade_path`, created on the service the calling job
declared and dropped again whichever way the comparison goes — and dropped
before it is created, so a run killed between the two ends does not leave the
next one failing over a name its author never chose. The database the app boots
against is the fresh one and is never touched by any of this.

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

**Two runs sharing one Postgres.** The upgrade path is built in a database
called `upgrade_path` on the service the calling job declared, and two runs
against one server would clobber each other's. In the shape this ships in — a
service container per job — that cannot happen; against a shared server, give
each run a server of its own. A caller that declares `upgrade_path` as its _own_
database is refused, since dropping it would take the one the app boots against.

**Anything about data.** This is a schema comparison. A migration that backfills
a column wrongly passes it.
