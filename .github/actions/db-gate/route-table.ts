import type { Route, RouteLog } from "../../../route-log.ts";
import { type Allowlist, isList, isObject, kindOf, type Problem } from "../_lib/gate.ts";

/**
 * What both readers of a route table need and neither is about: the route log
 * as read off the app, how a route is named, and how a reasoned hatch aimed at
 * one is graded.
 *
 * `route-compat.ts` asks whether the repo still serves a route and `fuzz.ts`
 * asks how it answers one nobody expected. Different questions, one shape of
 * hatch — an entry that is not a route, an entry naming a route the gate has
 * never heard of — and one grammar for the line a repo writes, or a repo that
 * got `route-allowlist` right would still be spelling `route-retire` wrong.
 *
 * Here rather than in either because it belongs to neither, and here rather
 * than in `_lib/` because one action holds both: `_lib` is for what a second
 * *action* reads.
 */

/** A `{"method","path"}` pair out of a document this action did not write. */
export function routeIn(value: unknown, source: string): Route {
  const { method, path } = isObject(value) ? value : {};
  if (typeof method === "string" && typeof path === "string") return { method, path };
  throw new Error(
    `${source} names ${JSON.stringify(value)}, which is not a {"method","path"} pair`,
  );
}

/**
 * Parsed at the boundary rather than asserted through. This is the app's own
 * output, not a file this action wrote, so a payload that is not the shape read
 * here says so loudly instead of surfacing as a gate that silently reads less
 * than the app serves — and a body that is not JSON at all is framed with what
 * it was, rather than reaching the log as a bare SyntaxError about a column
 * number in a document nobody named. An empty table is refused here too, for
 * whichever gate reads it first: an app reporting no route would otherwise
 * pass every gate that reads the table having been asked nothing.
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
  const { routeTable } = parsed;
  if (!isList(routeTable)) {
    throw new Error(`${source} is not a route log: routeTable is ${kindOf(routeTable)}`);
  }
  if (routeTable.length === 0) {
    throw new Error(
      `${source} reports an empty routeTable — it names every route the app serves, so an app's route-log endpoint answering none is the instrument not seeing the router`,
    );
  }
  return { routeTable: routeTable.map((entry) => routeIn(entry, `${source}: routeTable`)) };
}

/**
 * One route as one name, which is what every comparison here is between. The
 * method is folded because it is a fixed vocabulary and `options /*` names the
 * route `OPTIONS /*` does; the path is not, because `/Presets` is not
 * `/presets` to any router.
 */
export function key({ method, path }: Route): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * An entry as the route it names, or nothing when it is not one. Not exported:
 * the only thing that reads a line is the grading below, and a gate reaching
 * past that to parse an entry itself is the second reading this file exists to
 * stop having.
 */
function routeFrom(entry: string): Route | undefined {
  const [method = "", path, ...rest] = entry.split(/\s+/);
  const wellFormed =
    method !== "" && path !== undefined && path.startsWith("/") && rest.length === 0;
  return wellFormed ? { method, path } : undefined;
}

/**
 * The two ways any entry earns a diagnostic, phrased by the gate that owns the
 * hatch: what "not a route" and "not one of mine" mean is the caller's, and
 * which of the two a reader is told is not.
 */
export interface Refusals {
  /** The line is not a `METHOD /path` at all. */
  readonly malformed: (entry: string) => string;
  /** It parses, and names nothing this gate grades. */
  readonly unknown: (entry: string) => string;
}

/** One entry that names a subject, and the subject it names. */
interface Waiver {
  /** The entry as written, its reason stripped. */
  readonly entry: string;
  /** The subject's name, by `key`. */
  readonly name: string;
  readonly route: Route;
}

export interface Graded {
  /** Each entry that names a subject, in the order written. */
  readonly waivers: Waiver[];
  readonly problems: Problem[];
}

/**
 * A reasoned hatch over a set of routes, graded once for both gates: an entry
 * survives only by naming a subject, `subjects` being everything this gate can
 * be asked about, keyed by `key`. A gate with a rule of its own about what an
 * entry may name — the compatibility floor refuses one retiring a route still
 * served — applies it to the waivers, and leaves alone an entry
 * `allowlist.unreasoned` holds, as this does.
 *
 * The allowlist arrives whole rather than as its entries, so that enforcing the
 * reason on each of them is not something a caller can typecheck without.
 * `problems` here is the hatch's own; `allowlist.problems` stays the caller's to
 * report, since where it reports them differs.
 */
export function waivedBy(
  allowlist: Allowlist,
  subjects: ReadonlyMap<string, Route>,
  refusals: Refusals,
): Graded {
  const waivers: Waiver[] = [];
  const problems: Problem[] = [];
  // Deduplicated, because one line written twice is one exemption: the second
  // copy would otherwise earn its own identical diagnostic, which is two
  // findings for one edit. `deadEntries` reads its subjects the same way.
  for (const entry of new Set(allowlist.entries)) {
    const route = routeFrom(entry);
    const name = route === undefined ? undefined : key(route);
    const subject = name === undefined ? undefined : subjects.get(name);
    if (name !== undefined && subject !== undefined) {
      waivers.push({ entry, name, route: subject });
      continue;
    }
    // An entry already refused for saying nothing about why is asked none of
    // these questions: its author is going back to that line regardless, and
    // one mistake earns one diagnostic. stack-gate and the timestamptz gate
    // charge the hatch the same way.
    if (allowlist.unreasoned.has(entry)) continue;
    problems.push({
      message: route === undefined ? refusals.malformed(entry) : refusals.unknown(entry),
    });
  }
  return { waivers, problems };
}
