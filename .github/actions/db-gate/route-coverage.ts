import { type Allowlist, isObject, kindOf, type Problem } from "../_lib/gate.ts";

/**
 * The other half of the floor is the app's, and the protocol between them is one
 * flag-gated endpoint. `GET /__route-log` — which the ramp step fetches once
 * before the k6 run and once after — answers both lists in a single fetch:
 *
 * ```json
 * {
 *   "routeTable": [{ "method": "GET", "path": "/health" }],
 *   "counts": [{ "method": "GET", "path": "/health", "count": 12 }]
 * }
 * ```
 *
 * Every route the app serves, and how many requests each has taken since it
 * started. Coverage is the difference between the two fetches: a route whose
 * count rose is a route the ramp reached, and one whose count stood still is
 * uncovered however often the boot step's health poll had already touched it.
 * The endpoint leaves itself out of both lists, so the gate's own two fetches
 * are never mistaken for traffic.
 *
 * A counter rather than announced events, because a count is a state: two reads
 * of one subtract, and nothing here has to reason about *when* a route said
 * something relative to when the ramp began. That question has no reliable
 * answer — an announcement cheap enough for the hot path this step is measuring
 * is a sampled one — and docs/gates/capacity.md has the argument in full.
 *
 * Both lists name a route as its router registered it, `/presets/42` as
 * `/presets/:id`, which is what keeps this file out of the path-matching
 * business. That is not a convenience: where routes overlap — a literal
 * `/presets/new` beside `/presets/:id` — only the router knows which one
 * answered, and a gate that guessed would credit coverage to a route that
 * served nothing.
 */

/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
interface Route {
  readonly method: string;
  readonly path: string;
}

/** One route the app has taken requests on, and how many it has taken. */
interface Served extends Route {
  readonly count: number;
}

/** One fetch of the endpoint. */
export interface RouteLog {
  readonly routeTable: Route[];
  readonly counts: Served[];
}

/**
 * Refused rather than dropped, and refused as a whole: the table is what the
 * ramp is measured against, so an entry that will not read is a hole in the
 * floor — and an app that spelled one of them this way spelled the protocol
 * wrong rather than one route.
 */
function routeIn(value: unknown, source: string): Route {
  const { method, path } = isObject(value) ? value : {};
  if (typeof method === "string" && typeof path === "string") return { method, path };
  throw new Error(
    `${source} names ${JSON.stringify(value)}, which is not a {"method","path"} pair`,
  );
}

function servedIn(value: unknown, source: string): Served {
  const { method, path, count } = isObject(value) ? value : {};
  if (typeof method === "string" && typeof path === "string" && typeof count === "number") {
    return { method, path, count };
  }
  throw new Error(
    `${source} names ${JSON.stringify(value)}, which is not a {"method","path","count"} row — coverage is the difference between two of them`,
  );
}

/**
 * Parsed at the boundary rather than asserted through. This is the app's own
 * output, not a file this action wrote, so a payload that is not the shape read
 * here says so loudly instead of surfacing as a floor that silently covers
 * less than it claims.
 */
export function parseRouteLog(text: string, source: string): RouteLog {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) {
    throw new Error(`${source} is not a route log: the top level is ${kindOf(parsed)}`);
  }
  const { routeTable, counts } = parsed;
  if (!Array.isArray(routeTable)) {
    throw new Error(`${source} is not a route log: routeTable is ${kindOf(routeTable)}`);
  }
  if (!Array.isArray(counts)) {
    throw new Error(`${source} is not a route log: counts is ${kindOf(counts)}`);
  }
  return {
    routeTable: routeTable.map((entry) => routeIn(entry, `${source}: routeTable`)),
    counts: counts.map((entry) => servedIn(entry, `${source}: counts`)),
  };
}

function key({ method, path }: Route): string {
  return `${method.toUpperCase()} ${path}`;
}

/** A route registered for every method is reached by whichever one the ramp used. */
const EVERY_METHOD = "ALL";

/** What the route has taken, summed over every method that reaches it. */
function hits(counts: readonly Served[], route: Route): number {
  const method = route.method.toUpperCase();
  return counts
    .filter(
      (served) =>
        served.path === route.path &&
        (method === EVERY_METHOD || served.method.toUpperCase() === method),
    )
    .reduce((total, served) => total + served.count, 0);
}

/**
 * An allowlist entry as the route it waives, or nothing when it is not one. A
 * method is a fixed vocabulary and reads as well in either case; a path is a
 * path, and `/Presets` is not `/presets` to any router.
 */
function routeFrom(entry: string): Route | undefined {
  const [method = "", path, ...rest] = entry.split(/\s+/);
  const shaped = method !== "" && path !== undefined && path.startsWith("/") && rest.length === 0;
  return shaped ? { method, path } : undefined;
}

export interface Coverage {
  /** One line for the log, so a step that passed still shows the floor was evaluated. */
  readonly summary: string;
  readonly problems: Problem[];
}

/**
 * A floor, in the sense the coverage threshold is one: it catches a route that
 * no load has ever touched, and claims nothing about whether the load that did
 * touch it resembles production. Shipping an endpoint the ramp does not reach
 * is red for the same reason shipping code with no test is.
 *
 * The allowlist arrives whole rather than as its entries, so that enforcing the
 * reason on each of them is not something a caller can typecheck without.
 */
export function routeCoverage(before: RouteLog, after: RouteLog, allowlist: Allowlist): Coverage {
  // Keyed, so that the table's own duplicates collapse the way the floor reads
  // them: one route, covered or not.
  const table = new Map(after.routeTable.map((route) => [key(route), route]));
  if (table.size === 0) {
    return {
      summary: "route coverage: no route table",
      problems: [
        ...allowlist.problems,
        {
          message:
            "the app's route-log endpoint reported an empty routeTable — it names every route the app serves, or the ramp cannot be held to any floor",
        },
      ],
    };
  }

  // A difference, not a count: the boot step polled the health route to get the
  // app this far, and traffic this action made is not the scenario's.
  const covered = new Set(
    [...table]
      .filter(([, route]) => hits(after.counts, route) > hits(before.counts, route))
      .map(([name]) => name),
  );

  const waived = new Set<string>();
  const hatch: Problem[] = [];
  for (const entry of allowlist.entries) {
    const route = routeFrom(entry);
    if (route === undefined) {
      hatch.push({
        message: `route-allowlist entry '${entry}' is not a route — write 'METHOD /path', matching a line of the app's own route table`,
      });
      continue;
    }
    const name = key(route);
    if (!table.has(name)) {
      hatch.push({
        message: `route-allowlist names ${entry}, which this app does not serve — drop the entry, or fix the method and path to match the route it was written for`,
      });
      continue;
    }
    if (covered.has(name)) {
      // The reason written beside it says the ramp cannot reach the route. The
      // ramp reached it, so the reason is no longer true, and an exemption
      // nobody can see rotting is how a gate quietly stops covering what it
      // names.
      hatch.push({
        message: `route-allowlist waives ${entry}, which the ramp did exercise — drop the entry and let the floor hold the route`,
      });
      continue;
    }
    waived.add(name);
  }

  const uncovered = [...table.keys()].filter((name) => !covered.has(name) && !waived.has(name));

  return {
    summary: `route coverage: ${covered.size} of ${table.size} routes exercised by the ramp, ${waived.size} allowlisted`,
    problems: [
      ...allowlist.problems,
      ...uncovered.map((name) => ({
        message: `${name} is served but no ramp request exercises it — ramp it from capacity-path or the capacity script, or list it in route-allowlist with a reason`,
      })),
      ...hatch,
    ],
  };
}
