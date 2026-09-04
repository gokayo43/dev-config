import { EVERY_METHOD, type Route, type RouteLog, type Served } from "../../../route-log.ts";
import { type Allowlist, isList, isObject, kindOf, type Verdict } from "../_lib/gate.ts";
import { key, routeIn, waivedBy } from "./route-table.ts";

/**
 * The gate's half of the route-coverage floor. The protocol it reads — the
 * endpoint, the two lists, and why coverage is the difference between two
 * fetches of them rather than a count of one — is declared once in
 * `route-log.ts` at the root of this package, which is what both ends import.
 *
 * What lives here is the reading of that payload and the grading of it. How a
 * route is named, and how the reasoned hatch over one is graded, is
 * `route-table.ts` beside this: the compatibility floor asks a different
 * question of the same table and gets its entries read the same way.
 */

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
 * less than it claims — and a body that is not JSON at all is framed with what
 * it was, rather than reaching the log as a bare SyntaxError about a column
 * number in a document nobody named.
 */
export function parseRouteLog(text: string, source: string): RouteLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${String(error)}`, { cause: error });
  }
  if (!isObject(parsed)) {
    throw new Error(`${source} is not a route log: the top level is ${kindOf(parsed)}`);
  }
  const { routeTable, counts } = parsed;
  if (!isList(routeTable)) {
    throw new Error(`${source} is not a route log: routeTable is ${kindOf(routeTable)}`);
  }
  if (!isList(counts)) {
    throw new Error(`${source} is not a route log: counts is ${kindOf(counts)}`);
  }
  return {
    routeTable: routeTable.map((entry) => routeIn(entry, `${source}: routeTable`)),
    counts: counts.map((entry) => servedIn(entry, `${source}: counts`)),
  };
}

function totalOf(counts: readonly Served[], matches: (served: Served) => boolean): number {
  return counts.filter(matches).reduce((total, served) => total + served.count, 0);
}

/**
 * The methods this path has a route of its own for. A router hands a GET to the
 * `GET /events` registered beside `ALL /events`, and both are reported under
 * the one path — so those methods are exactly the traffic the catch-all did
 * *not* serve.
 */
function siblingMethods(table: readonly Route[], path: string): Set<string> {
  return new Set(
    table
      .filter((route) => route.path === path)
      .map((route) => route.method.toUpperCase())
      .filter((method) => method !== EVERY_METHOD),
  );
}

/**
 * What the route has taken. A route registered for every method is credited
 * with every method no route of its own path claims — crediting it with all of
 * them would mark a catch-all covered on the strength of a request its
 * concrete neighbour answered, which is a handler the ramp never ran.
 */
function hits(counts: readonly Served[], route: Route, table: readonly Route[]): number {
  const method = route.method.toUpperCase();
  if (method !== EVERY_METHOD) {
    return totalOf(
      counts,
      (served) => served.path === route.path && served.method.toUpperCase() === method,
    );
  }
  const siblings = siblingMethods(table, route.path);
  return totalOf(
    counts,
    (served) => served.path === route.path && !siblings.has(served.method.toUpperCase()),
  );
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
export function routeCoverage(before: RouteLog, after: RouteLog, allowlist: Allowlist): Verdict {
  // Keyed, so that the table's own duplicates collapse the way the floor reads
  // them: one route, covered or not.
  const table = new Map(after.routeTable.map((route) => [key(route), route]));
  if (table.size === 0) {
    return {
      // Present on a failing run, unlike the claim a proof carries: this one is
      // a measurement of the floor, and it earns its line of log either way.
      note: "route coverage: no route table",
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
  const routes = after.routeTable;
  const covered = (route: Route): boolean =>
    hits(after.counts, route, routes) > hits(before.counts, route, routes);

  const hatch = waivedBy(allowlist, table, covered, {
    malformed: (entry) =>
      `route-allowlist entry '${entry}' is not a route — write 'METHOD /path', matching a line of the app's own route table`,
    unknown: (entry) =>
      `route-allowlist names ${entry}, which this app does not serve — drop the entry, or fix the method and path to match the route it was written for`,
    // The reason written beside it says the ramp cannot reach the route. The
    // ramp reached it, so the reason is no longer true.
    satisfied: (entry) =>
      `route-allowlist waives ${entry}, which the ramp did exercise — drop the entry and let the floor hold the route`,
  });

  const exercised = [...table.values()].filter((route) => covered(route)).length;

  return {
    note: `route coverage: ${exercised} of ${table.size} routes exercised by the ramp, ${hatch.waived.size} allowlisted`,
    problems: [
      ...allowlist.problems,
      ...hatch.unmet.map((name) => ({
        message: `${name} is served but no ramp request exercises it — ramp it from capacity-path or the capacity script, or list it in route-allowlist with a reason`,
      })),
      ...hatch.problems,
    ],
  };
}
