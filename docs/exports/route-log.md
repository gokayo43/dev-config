# The route log

`@gokayo43/dev-config/route-log` is the protocol between an app and the two
gates the database job holds its route table to — [the compatibility
floor](../gates/route-compat.md) that asks whether a route it used to serve is
still there, and [the fuzzer](../gates/fuzz.md) that sends every route
generated requests. Two strings and two shapes,
exported so that neither end of the contract reproduces them from memory.

An app that sets `ROUTE_LOG` serves `GET /__route-log`, answering its route
table:

```json
{ "routeTable": [{ "method": "GET", "path": "/health" }] }
```

`routeTable` is every route the app serves, and what both gates read. An empty
table is refused when it is read, and any other key beside it is not read.

The table names a route _as its router registered it_: `/presets/42` as
`/presets/:id`. Where routes overlap — a literal `/presets/new` beside
`/presets/:id` — only the router knows which one answered, and a gate that
guessed would hold the app to a route it does not serve.

Like [the invariant sweep](invariant-sweep.md), and for the same reason, it
ships built: a repo's Playwright specs import this constant to reach the
endpoint, and Playwright's runner is node. `tsdown.config.ts` in the package
carries why, and STACK.md's shared UI library carries the bargain a committed
`dist/` is. The source stays `route-log.ts`; the specifier resolves to
`dist/route-log.js`.

Unlike the other exports here, this one is a data contract rather than a check:
nothing in it fails a build. What reads it is `db-gate`: one step fetches it
once the app has booted, and the compatibility floor and the fuzzer both read
`routeTable` out of that one fetch. What each does with it is on its page,
[docs/gates/route-compat.md](../gates/route-compat.md) and
[docs/gates/fuzz.md](../gates/fuzz.md).
