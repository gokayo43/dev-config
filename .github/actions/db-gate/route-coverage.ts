import { EVERY_METHOD, type Route, type RouteLog, type Served } from "../../../route-log.ts";
import { type Allowlist, isObject, kindOf, type Problem } from "../_lib/gate.ts";

/**
 * The gate's half of the route-coverage floor. The protocol it reads — the
 * endpoint, the two lists, and why coverage is the difference between two
 * fetches of them rather than a count of one — is declared once in
 * `route-log.ts` at the root of this package, which is what both ends import.
 *
 * What lives here is the reading of that payload and the grading of it.
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
 * An allowlist entry as the route it waives, or nothing when it is not one. A
 * method is a fixed vocabulary and reads as well in either case; a path is a
 * path, and `/Presets` is not `/presets` to any router.
 */
function routeFrom(entry: string): Route | undefined {
  const [method = "", path, ...rest] = entry.split(/\s+/);
  const wellFormed =
    method !== "" && path !== undefined && path.startsWith("/") && rest.length === 0;
  return wellFormed ? { method, path } : undefined;
}

/**
 * Not `_lib/gate.ts`'s `Verdict`, which it otherwise resembles. A verdict's
 * summary is the claim the gate established, so it is absent when there is none
 * — what happened is the problems. This summary is a measurement of the floor,
 * and it earns the same line of log either way: "5 of 10 routes exercised by the
 * ramp" is what a reader wants most on the run that failed. Folding the two
 * would mean dropping the count from exactly those runs.
 */
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
  const routes = after.routeTable;
  const covered = new Set(
    [...table]
      .filter(([, route]) => hits(after.counts, route, routes) > hits(before.counts, route, routes))
      .map(([name]) => name),
  );

  // Every entry is one of these: the route it waives, or what is wrong with it.
  // A classifier rather than three pushes inside the loop, so that the rule
  // about which of them the reader is told stays in one place below.
  const read = (entry: string): { readonly waives: string } | { readonly rotten: string } => {
    const route = routeFrom(entry);
    if (route === undefined) {
      return {
        rotten: `route-allowlist entry '${entry}' is not a route — write 'METHOD /path', matching a line of the app's own route table`,
      };
    }
    const name = key(route);
    if (!table.has(name)) {
      return {
        rotten: `route-allowlist names ${entry}, which this app does not serve — drop the entry, or fix the method and path to match the route it was written for`,
      };
    }
    if (covered.has(name)) {
      // The reason written beside it says the ramp cannot reach the route. The
      // ramp reached it, so the reason is no longer true, and an exemption
      // nobody can see rotting is how a gate quietly stops covering what it
      // names.
      return {
        rotten: `route-allowlist waives ${entry}, which the ramp did exercise — drop the entry and let the floor hold the route`,
      };
    }
    return { waives: name };
  };

  const waived = new Set<string>();
  const hatch: Problem[] = [];
  for (const entry of allowlist.entries) {
    const verdict = read(entry);
    if ("waives" in verdict) waived.add(verdict.waives);
    // An entry already refused for saying nothing about why is asked none of
    // those questions: its author is going back to that line regardless, and
    // one mistake earns one diagnostic. stack-gate and the timestamptz gate
    // charge the hatch the same way. It still waives its route in the branch
    // above, so the floor does not report the route on top of it either.
    else if (!allowlist.unreasoned.has(entry)) hatch.push({ message: verdict.rotten });
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
