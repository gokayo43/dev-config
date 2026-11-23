/**
 * The protocol between an app and the two gates the database job holds its
 * route table to — the compatibility floor that asks whether a route it used
 * to serve is still there, and the fuzzer that sends every route generated
 * requests. Declared once and imported by both ends: the two strings as well
 * as the two shapes.
 *
 * Exporting the strings costs an app one identifier from a devDependency in
 * whatever bundle its instrument lands in, and that cost is accepted: `"ALL"`
 * is a protocol constant that exists only because Elysia spells its catch-all
 * `.all()`, and a value with a reason that arbitrary is one nobody will
 * reproduce correctly from memory. It was reproduced by hand in three places
 * before this line existed.
 *
 * An app that sets `ROUTE_LOG` serves `GET /__route-log`, which answers its
 * route table:
 *
 * ```json
 * { "routeTable": [{ "method": "GET", "path": "/health" }] }
 * ```
 *
 * `routeTable` is every route the app serves, and what both gates read. A key
 * beside it is not read.
 *
 * The table names a route **as its router registered it**, `/presets/42` as
 * `/presets/:id`, which is what keeps the gate out of the path-matching
 * business. That is not a convenience: where routes overlap — a literal
 * `/presets/new` beside `/presets/:id` — only the router knows which one
 * answered.
 */
/**
 * Where an app serves the report. Any app under `ROUTE_LOG` answers here, and
 * leaves this path out of the table it reports: an instrument is not one of
 * the routes the gates are about.
 */
export declare const ENDPOINT = "/__route-log";
/**
 * How a route registered for every method is named. Elysia spells that
 * `.all()`, which is where the word comes from; TanStack Start spells the same
 * thing `ANY` and its implementation translates.
 */
export declare const EVERY_METHOD = "ALL";
/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
export interface Route {
  readonly method: string;
  readonly path: string;
}
/** One fetch of the endpoint. */
export interface RouteLog {
  readonly routeTable: Route[];
}