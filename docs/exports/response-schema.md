# Response-schema coverage

`@gokayo43/dev-config/response-schema.ts` exports `responseSchemaGaps`, which
holds a composed Elysia app's own route table to one invariant:

> every route the app serves either declares a `response` schema, or is listed
> as a skip carrying the structural reason it cannot.

The whole of what a repo writes:

```ts
import { responseSchemaGaps, type Skip } from "@gokayo43/dev-config/response-schema.ts";
import { app } from "../src/app.ts";

/** Greenfield APIs ship this empty. */
const SKIPS: Skip[] = [];

test("every route declares a response schema", () => {
  expect(responseSchemaGaps({ routes: app.routes, skips: SKIPS, floor: 20 })).toEqual([]);
});
```

`app.routes` goes in with no cast, and that matters more than it looks: a cast is
what lets an introspection Elysia has renamed keep type-checking while answering
nothing.

## Why this is enforcement, not documentation

Elysia's `response` **validates**, and under `normalize` it **cleans**. A field
the schema does not mention is stripped out of the body before it is serialised,
and a scalar of the wrong type is coerced. So:

- a too-narrow schema silently deletes live data;
- an undeclared route is a body nothing pins at all.

That is why an undeclared route is a failure rather than a warning, and why
where the schema is authored from is a rule and not a preference.

### Author the schema from the handler and the column definitions

Never from a test golden. A golden has been through the suite's normaliser,
which exists precisely to hide the fields that vary between runs — timestamps,
generated ids, computed totals — and those are exactly the fields most likely to
be missing from a schema and therefore silently dropped from production traffic.
A schema written from a golden is a schema that agrees with the one thing that
cannot see the problem.

Read the raw handler return, and read the column definitions behind it.

## The floor

`floor` is the number of routes below which the table is not believable.
Introspection that has broken answers with an empty list, and an empty list
satisfies every other check here — so a run at or below the floor reports only
that, and reports nothing else, because everything else would be measured
against the table under suspicion.

It is a floor and not a count: set it below what the app already serves and raise
it as the app grows. A count would be a number somebody has to remember to
update, which is the check a floor exists to replace.

## The skips table, and the five causes

A skip is legitimate only where Elysia **cannot** hold a structural contract for
the body. `cause` is one of five, and each is a fact about what the handler
returns:

| `cause`           | What it means                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hand-serialized` | the handler returns an already-serialised string, so the only declarable schema is `t.String()` — which validates nothing and publishes a wrong type to every consumer of the OpenAPI document |
| `binary`          | the body is bytes                                                                                                                                                                              |
| `sse`             | a long-lived `text/event-stream`                                                                                                                                                               |
| `redirect`        | a 3xx with no body                                                                                                                                                                             |
| `framework`       | a route Elysia or a plugin owns — the CORS preflight, the OpenAPI document itself                                                                                                              |

"Not done yet" is deliberately not among them: a route whose schema has not been
written is the exact state this fails on.

`why` says what about _this_ route makes a schema impossible. The gate can only
see that a sentence is there — whether it is a good one is review's job — but it
does refuse the entry that restates its own cause, which is the shape a
placeholder takes.

## The ratchet, and its drain

The generalisable shape, worth having a name for because it recurs:

> **an undeclared X fails until it is either declared or argued into a table with
> a structural cause, and a stale entry in that table fails too.**

Without the second half a ratchet is a list that only grows. Three things are
therefore stale here, all of them failures:

- a skip for a route that is no longer served;
- a skip for a route that has since been given a schema;
- the same route listed twice — draining either entry leaves the other standing,
  so the pair can never be shown to have gone stale.

## Classifying an exemption list

The same discipline applies to every per-file exemption list in this repo's
configs, and it is the reason the `cause` field exists at all. Each entry in such
a list is one of three things, and an entry that does not say which is a problem
in both directions — an unlabelled permanent exemption looks like debt forever,
and an unlabelled drainable one never drains:

- **drainable** — it will go away, and something has to make it;
- **permanent** — a fact about what the code is, which will not change;
- **policy-exempt** — waived deliberately, pinned to the commit that waived it.

Counts live beside the list, so a list that is growing says so. A family of
ratchets gets one chained terminal trigger rather than one issue each, so that
draining the last of them is what closes the subject.
