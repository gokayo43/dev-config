# The route log

`@gokayo43/dev-config/route-log.ts` is the protocol between an app and the
capacity ramp's route-coverage floor: two strings and three shapes, exported so
that neither end of the contract reproduces them from memory.

An app that sets `ROUTE_LOG` serves `GET /__route-log`, answering both lists in
one fetch:

```json
{
  "routeTable": [{ "method": "GET", "path": "/health" }],
  "counts": [{ "method": "GET", "path": "/health", "count": 12 }]
}
```

`routeTable` is every route the app serves; `counts` is how many requests each
has taken since the process started. The ramp step fetches this once before k6
runs and once after, and **coverage is the difference** — a route whose count
rose is a route the ramp reached.

Both lists name a route _as its router registered it_: `/presets/42` as
`/presets/:id`. Where routes overlap — a literal `/presets/new` beside
`/presets/:id` — only the router knows which one answered, and a gate that
guessed would credit coverage to a route that served nothing.

Unlike the other exports here, this one is a data contract rather than a check:
nothing in it fails a build. What reads it is the `db-gate` capacity step, and
the argument for every choice above — why a count rather than announced events,
what the floor does and does not claim — lives with that gate in
[docs/gates/capacity.md](../gates/capacity.md).
