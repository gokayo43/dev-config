import { isObject, type Problem } from "../_lib/gate.ts";

/** A route as both halves of the contract name it: the router's own pattern, not a URL. */
interface Route {
  readonly method: string;
  readonly path: string;
}

/**
 * The app's half of the floor, printed on stdout — which the boot step already
 * captures — under the flag the ramp sets:
 *
 * - once at boot, `{"routeTable":[{"method","path"},…]}`: every route it serves;
 * - the first time each route serves a request, `{"routeServed":{"method","path"}}`.
 *
 * The router names the route both times, so the two sides compare as strings and
 * nothing here re-implements path matching. That is not a convenience: where
 * routes overlap — a literal `/presets/new` beside `/presets/:id` — only the
 * router knows which one answered, and a gate that guessed would credit
 * coverage to a route that served nothing.
 */
const TABLE = "routeTable";
const SERVED = "routeServed";

function routeOf(value: unknown): Route[] {
  const node = isObject(value) ? value : {};
  const { method, path } = node;
  return typeof method === "string" && typeof path === "string" ? [{ method, path }] : [];
}

/**
 * The lines the app printed, out of everything else in the log. Read per line
 * and by key rather than by position: the file holds the migrate output, the
 * app's own log records and whatever the runtime prints at boot.
 */
function linesOf(log: string): { table: Route[]; served: Route[] } {
  const table: Route[] = [];
  const served: Route[] = [];
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A line of the app's own that merely looks like JSON.
      continue;
    }
    if (!isObject(parsed)) continue;
    const declared = parsed[TABLE];
    if (Array.isArray(declared)) table.push(...declared.flatMap(routeOf));
    if (SERVED in parsed) served.push(...routeOf(parsed[SERVED]));
  }
  return { table, served };
}

function key({ method, path }: Route): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * An allowlist entry as it compares to a route. A method is a fixed vocabulary
 * and reads as well in either case; a path is a path, and `/Presets` is not
 * `/presets` to any router.
 */
function entryKey(entry: string): string {
  const [method = "", ...rest] = entry.split(/\s+/);
  return [method.toUpperCase(), ...rest].join(" ");
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
export function routeCoverage(log: string, allowlist: readonly string[]): Coverage {
  const { table, served } = linesOf(log);
  const allowed = allowlist.map((entry) => ({ entry, key: entryKey(entry) }));

  if (table.length === 0) {
    return {
      summary: "route coverage: no route table",
      problems: [
        {
          message:
            'no route table reached the log — an app under the capacity ramp prints one {"routeTable":[…]} line at boot, naming every route it serves, or the ramp cannot be held to any floor',
        },
      ],
    };
  }

  const waivable = new Set(allowed.map(({ key: name }) => name));
  const unexercised = table.filter((route) => !exercised(route, served));
  const uncovered = unexercised.filter((route) => !waivable.has(key(route)));
  const waived = unexercised.length - uncovered.length;

  const names = new Set(table.map(key));
  const stale = allowed.filter(({ key: name }) => !names.has(name));

  return {
    summary: `route coverage: ${table.length - unexercised.length} of ${table.length} routes exercised by the ramp, ${waived} allowlisted`,
    problems: [
      ...uncovered.map((route) => ({
        message: `${key(route)} is served but no ramp request exercises it — extend the capacity scenario, or list it in route-allowlist with a reason`,
      })),
      ...stale.map(({ entry }) => ({
        message: `route-allowlist names ${entry}, which this app does not serve — drop the entry, or fix the method and path to match the route it was written for`,
      })),
    ],
  };
}
