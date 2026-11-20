import type { Route, RouteLog, Served } from "../../../route-log.ts";
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

function servedIn(value: unknown, source: string): Served {
  const { method, path, count } = isObject(value) ? value : {};
  if (typeof method === "string" && typeof path === "string" && typeof count === "number") {
    return { method, path, count };
  }
  throw new Error(
    `${source} names ${JSON.stringify(value)}, which is not a {"method","path","count"} row`,
  );
}

/**
 * Parsed at the boundary rather than asserted through. This is the app's own
 * output, not a file this action wrote, so a payload that is not the shape read
 * here says so loudly instead of surfacing as a gate that silently reads less
 * than the app serves — and a body that is not JSON at all is framed with what
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

/**
 * What a floor wants of each subject, for the gate that holds one: the
 * compatibility floor wants a route still served, and an entry waiving a route
 * that already is has stopped being true. The fuzzer holds no floor, so it
 * passes none, and its entries are graded on the two refusals alone.
 */
export interface Floor {
  readonly satisfied: (route: Route) => boolean;
  /** The entry names a subject that is already satisfied, so the reason beside it has stopped being true. */
  readonly refusal: (entry: string) => string;
}

export interface Graded {
  /** The subjects an entry waives, by name — a count each gate reports its own way. */
  readonly waived: ReadonlySet<string>;
  /** The subjects the floor did not find satisfied and no entry waived: what the floor refuses, in its own words. */
  readonly unmet: string[];
  readonly problems: Problem[];
}

/**
 * A reasoned hatch over a set of routes, graded once for both gates.
 *
 * `subjects` is everything this gate can be asked about, keyed by `key`;
 * `floor`, where the gate holds one, is what it wanted of each of them. An
 * entry survives only by naming a subject, and under a floor one that is not
 * satisfied — which is the whole of what an exemption is — and an exemption
 * nobody can see rotting is how a gate quietly stops holding what it names.
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
  floor?: Floor,
): Graded {
  // Every entry is one of these: the subject it waives, or what is wrong with
  // it. A classifier rather than three pushes inside the loop, so the rule about
  // which of them the reader is told stays in one place below.
  const read = (entry: string): { readonly waives: string } | { readonly rotten: string } => {
    const route = routeFrom(entry);
    if (route === undefined) return { rotten: refusals.malformed(entry) };
    const name = key(route);
    const subject = subjects.get(name);
    if (subject === undefined) return { rotten: refusals.unknown(entry) };
    if (floor?.satisfied(subject) === true) return { rotten: floor.refusal(entry) };
    return { waives: name };
  };

  const waived = new Set<string>();
  const problems: Problem[] = [];
  // Deduplicated, because one line written twice is one exemption: the second
  // copy would otherwise earn its own identical diagnostic, which is two
  // findings for one edit. `deadEntries` reads its subjects the same way.
  for (const entry of new Set(allowlist.entries)) {
    const verdict = read(entry);
    if ("waives" in verdict) waived.add(verdict.waives);
    // An entry already refused for saying nothing about why is asked none of
    // those questions: its author is going back to that line regardless, and one
    // mistake earns one diagnostic. stack-gate and the timestamptz gate charge
    // the hatch the same way. It still waives its subject in the branch above,
    // so the gate does not report the subject on top of it either.
    else if (!allowlist.unreasoned.has(entry)) problems.push({ message: verdict.rotten });
  }

  return {
    waived,
    unmet: [...subjects]
      .filter(([name, route]) => floor?.satisfied(route) !== true && !waived.has(name))
      .map(([name]) => name),
    problems,
  };
}
