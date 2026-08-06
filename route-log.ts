/**
 * The protocol between an app and the capacity ramp's route-coverage floor,
 * declared once and imported by both ends — the two strings as well as the
 * three shapes.
 *
 * Exporting the strings costs an app one identifier from a devDependency in
 * whatever bundle its instrument lands in, and that cost is accepted: `"ALL"`
 * is a protocol constant that exists only because Elysia spells its catch-all
 * `.all()`, and a value with a reason that arbitrary is one nobody will
 * reproduce correctly from memory. It was reproduced by hand in three places
 * before this line existed.
 *
 * An app that sets `ROUTE_LOG` serves `GET /__route-log`, which answers both
 * lists in a single fetch:
 *
 * ```json
 * {
 *   "routeTable": [{ "method": "GET", "path": "/health" }],
 *   "counts": [{ "method": "GET", "path": "/health", "count": 12 }]
 * }
 * ```
 *
 * `routeTable` is every route the app serves; `counts` is how many requests
 * each of them has taken since the process started. The ramp step fetches this
 * once before k6 runs and once after, and **coverage is the difference**: a
 * route whose count rose is a route the ramp reached, and one whose count stood
 * still is uncovered however often the boot step's health poll had already
 * touched it.
 *
 * A count rather than announced events, because a count is a state: two reads
 * of one subtract, and nothing has to reason about *when* a route said
 * something relative to when the ramp began. That question has no reliable
 * answer — an announcement cheap enough for the hot path the step is measuring
 * is a sampled one — and docs/gates/capacity.md has the argument in full.
 *
 * Both lists name a route **as its router registered it**, `/presets/42` as
 * `/presets/:id`, which is what keeps the gate out of the path-matching
 * business. That is not a convenience: where routes overlap — a literal
 * `/presets/new` beside `/presets/:id` — only the router knows which one
 * answered, and a gate that guessed would credit coverage to a route that
 * served nothing.
 *
 */

/**
 * Where an app serves the report. Any app under `ROUTE_LOG` answers here, and
 * leaves this path out of both lists it reports: an instrument is not one of
 * the routes the floor is about, and the gate's own two fetches are not the
 * scenario's traffic.
 */
export const ENDPOINT = "/__route-log";

/**
 * How a route registered for every method is named. Elysia spells that
 * `.all()`, which is where the word comes from; TanStack Start spells the same
 * thing `ANY` and its implementation translates. The gate credits such a route
 * with whichever method reached it.
 */
export const EVERY_METHOD = "ALL";

/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
export interface Route {
  readonly method: string;
  readonly path: string;
}

/** One route the app has taken requests on, and how many it has taken. */
export interface Served extends Route {
  readonly count: number;
}

/** One fetch of the endpoint. */
export interface RouteLog {
  readonly routeTable: Route[];
  readonly counts: Served[];
}
