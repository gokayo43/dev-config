# The route compatibility floor

`database: postgres` ends in two floors over the same route table. [The capacity
ramp](capacity.md)'s asks whether every route the app serves has ever been under
load. This one asks the other question: **has the app stopped serving something
it used to?**

A repo whose `lifecycle` is `live` has people on the other end, and they are
calling the routes it published. Nothing else in the job notices when one of them
goes: the migrations replay, the app boots, its health route answers, and the
coverage floor is content because a route that no longer exists is not in the
table it grades. A deleted handler, a renamed path, a method dropped from a
catch-all — every one of them is a green run and a 404 for somebody.

## The snapshot

The base ref's route table is not in the checkout. Nothing here boots the base
ref's app, and reading a route table out of source is the second source of truth
[`route-log.ts`](../exports/route-log.md) exists to avoid — a router's own answer
is the only one that survives a middleware, a plugin, or a mount.

So the repo commits it. `routes.snapshot.json`, at the root of whatever project
the database job was pointed at, is the app's own route table as of that commit:

```json
[
  {
    "method": "GET",
    "path": "/health"
  },
  {
    "method": "POST",
    "path": "/presets"
  }
]
```

Sorted by path and then by method, two-space indented, with a trailing newline,
and the method spelled the way every comparison here reads it — upper case — so
regenerating it diffs on the route that changed and nothing else.

**Every run compares it with the booted app.** What is compared is **the
committed file, as git stores it** — the blob at HEAD, byte for byte against the
table the app declared. Not the file on disk: a commit whose snapshot is two
releases old passes any worktree comparison the moment somebody's working copy
happens to be right, and the run after it compares the base ref against that
stale commit. It also settles the untracked case (a file git does not carry is
not a snapshot, whatever is in it) and the checkout-filter case (`* text
eol=crlf` in `.gitattributes` means the worktree never equals the blob, so a
worktree comparison would be permanently red with no edit that could clear it).

That comparison is what makes the file worth having: a golden nobody has to
remember to update is a description of an app that stopped existing two releases
ago, and this one cannot drift by more than the run that notices. It also puts
every route change into the pull request's diff, where a person reads it, rather
than leaving it to be discovered from the outside.

**The gate is the generator.** There is no regeneration script — nothing to run
against the wrong app, nothing to forget to run, nothing that answers from source
instead of from the router. A run whose snapshot is missing or stale prints the
exact content the file must hold above its own annotations, and uploads it as
`routes.snapshot.json` in the [`db-gate-evidence`](capacity.md#what-is-published)
artifact. Adopting the floor, and regenerating the file after a route change, are
both a copy.

**Every repo running the database job owes the file, `dev` ones included** —
only the _holding_ below is `live`-only. The reason is the commit that flips
`lifecycle` to `live`: if `dev` repos carried no snapshot, that commit's base ref
would carry none either, so there would be nothing to hold the repo to on the day
it starts mattering, and nothing again until the commit after. A repo with no
users pays one committed file for a floor that is already loaded when it gets
them.

## What is held, and what is retired

On a repo whose root `package.json` declares `lifecycle: "live"` — the same field
[the repo contract](repo-contract.md) reads, derived in one place so a repo
cannot be live to one gate and dev to another — every route in the base ref's
snapshot must still be served at HEAD.

"Still served" is the same method and the same path, or a route registered for
**every** method (`ALL`) on that path: an app answering everything on `/events`
answers whatever the base ref answered there. The reverse is a removal — a base
ref serving `ALL /events` and a branch serving only its `GET` has stopped
answering every other method. A renamed path is a removal and an addition, and
only the removal is a promise broken. Additions are free.

A route that really is gone on purpose is named in `route-retire`:

```yaml
route-retire: |
  POST /presets -- the write path moved to the jobs API, and the last caller was migrated in #412
```

The grammar and the price are `route-allowlist`'s exactly. An entry is refused
when it is not a route, when it names a route the base ref did not serve, and
when the app **still** serves it — a waiver that waives nothing is how a floor
quietly stops holding what it names. An entry with no reason is asked none of
those three questions: it fails the step for the missing reason, still retires
its route, and one mistake earns one diagnostic.

Where the comparison does not happen at all — a `dev` repo, or a base ref from
before the file existed — a `route-retire` entry is refused rather than ignored,
saying which of the two it was. A repo that has written out the routes it retired
has said plainly that it expects them to be held, and being quietly ignored is
how a gate somebody asked for turns out never to have run.

The first adoption compares nothing: the base ref carried no snapshot, so there
is nothing this branch can be held to. From the commit after it, there is.

## What it cannot see

**One method and one path per line.** That is the whole of what this floor knows
about a route, and it is much less than "the API still works". It is a floor in
the sense the coverage threshold is one — it catches the crudest way to break a
caller, and claims nothing about the rest:

- **A field removed from a response.** The route answers, with less in it.
- **A type narrowed, or a field's meaning changed.** `id` was a string and is now
  a number; `total` included tax and now does not.
- **A status or an error contract that changed.** A 200 that became a 202, a
  validation failure that stopped being a 400.
- **A request body the route stopped accepting.** Same method, same path, a
  parameter that is now required or now refused.
- **Authentication and authorisation.** A route that became authenticated is
  served exactly as before to this gate.
- **Content negotiation, headers, pagination, rate limits.** None of it is in a
  route table.
- **Persisted data reinterpreted underneath the route.** The upgrade path proves
  the schema converges and [semantic fixtures](upgrade-path.md) grade what a
  migration does to a row; a column that keeps its shape and changes its meaning
  is a thing the route table cannot express.

The tools for those are elsewhere and are the repo's own: `response-schema.ts`
grades an Elysia app's route table against the schemas it declares, the
`probe-command` input asserts what only the repo knows about its booted app, and
[semantic fixtures](upgrade-path.md) hold the rows. A green run here means one
sentence: **no route that was there is missing.**

## Aiming it

| Input          | Effect                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `route-retire` | Routes this repo has deliberately stopped serving, as `METHOD /path -- why` entries matching the base ref's `routes.snapshot.json`, one per line. The reason is part of the entry and an entry without one is refused — that is the whole price of the hatch. Graded where the hold runs; passed to a repo that holds nothing, the whole input is refused rather than ignored. |

Like every input aimed at a step of the database job, passing it with anything
but `database: postgres` fails the run and says so.

The snapshot itself is not an input: it is a file at the root of the working
directory, and the run that wants it prints it.
