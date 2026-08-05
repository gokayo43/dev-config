import { isObject, type Problem } from "../_lib/gate.ts";

/**
 * The app's half of the floor, printed on stdout — which the boot step already
 * captures:
 *
 * - once at boot, `{"routeTable":[{"method","path"},…]}`: every route it serves;
 * - `{"routeServed":{"method","path"}}` while a route is answering requests, at
 *   most once a second — often enough that the ramp's own window holds one for
 *   every route it reached, rarely enough not to be an access log.
 *
 * The router names the route both times, so the two sides compare as strings and
 * nothing here re-implements path matching. That is not a convenience: where
 * routes overlap — a literal `/presets/new` beside `/presets/:id` — only the
 * router knows which one answered, and a gate that guessed would credit
 * coverage to a route that served nothing.
 */
const TABLE = "routeTable";
const SERVED = "routeServed";

/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
interface Route {
  readonly method: string;
  readonly path: string;
}

interface Read {
  readonly routes: Route[];
  readonly problems: Problem[];
}

function readRoute(value: unknown, source: string): Read {
  const node = isObject(value) ? value : {};
  const { method, path } = node;
  if (typeof method === "string" && typeof path === "string") {
    return { routes: [{ method, path }], problems: [] };
  }
  // Dropping this quietly would shrink the floor to whatever the app happened
  // to spell correctly, which is the one failure a floor may not have.
  return {
    routes: [],
    problems: [
      {
        message: `${source} names ${JSON.stringify(value)}, which is not a {"method","path"} pair — the table is what the ramp is measured against, so an entry that will not read is a hole in the floor`,
      },
    ],
  };
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // A line of the app's own that merely looks like JSON.
    return undefined;
  }
}

export interface Log {
  /** Everything the app has printed, which is where the table it announced at boot sits. */
  readonly all: string;
  /** What it printed while the ramp ran, which is the only traffic that counts as coverage. */
  readonly underRamp: string;
}

/**
 * The lines the app printed, out of everything else in the log. Read per line
 * and by key rather than by position: the file holds the migrate output, the
 * app's own log records and whatever the runtime prints at boot.
 *
 * The table is read from the whole log, because it is announced once at boot.
 * What counts as covered is read from the ramp's window alone — the app answers
 * the boot step's health poll too, and a route reached by a curl this action
 * made is not a route the ramp exercised.
 */
function linesOf(log: Log): { table: Read; served: Route[] } {
  const routes: Route[] = [];
  const problems: Problem[] = [];
  for (const line of log.all.split("\n")) {
    const node = parsed(line.trim());
    const declared = isObject(node) ? node[TABLE] : undefined;
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      const read = readRoute(entry, "the app's route table");
      routes.push(...read.routes);
      problems.push(...read.problems);
    }
  }

  const served: Route[] = [];
  for (const line of log.underRamp.split("\n")) {
    const node = parsed(line.trim());
    if (isObject(node) && SERVED in node) served.push(...readRoute(node[SERVED], SERVED).routes);
  }

  return { table: { routes, problems }, served };
}

function key({ method, path }: Route): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * An allowlist entry as the route it waives, or nothing when it is not one. A
 * method is a fixed vocabulary and reads as well in either case; a path is a
 * path, and `/Presets` is not `/presets` to any router.
 */
function entryFor(entry: string): Route | undefined {
  const [method = "", path, ...rest] = entry.split(/\s+/);
  const shaped = method !== "" && path !== undefined && path.startsWith("/") && rest.length === 0;
  return shaped ? { method: method.toUpperCase(), path } : undefined;
}

/** A route registered for every method is reached by whichever one the ramp used. */
const EVERY_METHOD = "ALL";

function exercised(route: Route, served: readonly Route[]): boolean {
  return served.some(
    ({ method, path }) =>
      path === route.path &&
      (route.method.toUpperCase() === EVERY_METHOD ||
        method.toUpperCase() === route.method.toUpperCase()),
  );
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
 */
export function routeCoverage(log: Log, allowlist: readonly string[]): Coverage {
  const { table, served } = linesOf(log);

  if (table.routes.length === 0) {
    return {
      summary: "route coverage: no route table",
      problems: [
        ...table.problems,
        {
          message:
            'no route table reached the log — an app under the capacity ramp prints one {"routeTable":[…]} line at boot, naming every route it serves, or the ramp cannot be held to any floor',
        },
      ],
    };
  }

  const read = allowlist.map((entry) => ({ entry, route: entryFor(entry) }));
  const waivable = new Set(read.flatMap(({ route }) => (route === undefined ? [] : [key(route)])));
  const names = new Set(table.routes.map(key));

  const unexercised = table.routes.filter((route) => !exercised(route, served));
  const uncovered = unexercised.filter((route) => !waivable.has(key(route)));
  const waived = unexercised.length - uncovered.length;

  return {
    summary: `route coverage: ${table.routes.length - unexercised.length} of ${table.routes.length} routes exercised by the ramp, ${waived} allowlisted`,
    problems: [
      ...table.problems,
      ...uncovered.map((route) => ({
        message: `${key(route)} is served but no ramp request exercises it — ramp it from capacity-path or the capacity script, or list it in route-allowlist with a reason`,
      })),
      ...read.flatMap(({ entry, route }) =>
        route === undefined
          ? [
              {
                message: `route-allowlist entry '${entry}' is not a route — write 'METHOD /path', matching a line of the app's own route table`,
              },
            ]
          : [],
      ),
      ...read.flatMap(({ entry, route }) =>
        route !== undefined && !names.has(key(route))
          ? [
              {
                message: `route-allowlist names ${entry}, which this app does not serve — drop the entry, or fix the method and path to match the route it was written for`,
              },
            ]
          : [],
      ),
    ],
  };
}
