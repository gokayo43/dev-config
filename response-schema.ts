/**
 * The response-schema coverage invariant, held against a composed Elysia app's
 * own route table:
 *
 *   every route the app serves either declares a `response` schema, or is
 *   listed as a skip carrying the structural reason it cannot.
 *
 * Elysia's `response` is not documentation. It **validates**, and under
 * `normalize` it **cleans**: a field the schema does not mention is stripped
 * out of the body before it is serialised, and a scalar of the wrong type is
 * coerced. So a too-narrow schema silently deletes live data, and an
 * undeclared route is one whose body nothing pins at all. That is why the
 * absence of a schema is a failure rather than a warning, and why
 * docs/exports/response-schema.md carries the rule about where the schema is
 * authored from.
 *
 * The shape generalises past this one subject, and is worth naming: *an
 * undeclared X fails until it is either declared or argued into a table with a
 * structural cause, and a stale entry in that table fails too.* Without the
 * second half a ratchet is a list that only grows.
 */

/**
 * Why a route cannot hold a response schema. Every skip names one of these
 * five, and each is a fact about what the handler returns rather than about
 * how much time anyone had:
 *
 * - `hand-serialized` — the handler returns an already-serialised string, so
 *   the only schema Elysia could validate is `t.String()`, which validates
 *   nothing and publishes a wrong type to every consumer of the OpenAPI
 *   document;
 * - `binary` — the body is bytes;
 * - `sse` — the body is a long-lived `text/event-stream`;
 * - `redirect` — a 3xx with no body;
 * - `framework` — a route Elysia or a plugin owns, such as the CORS preflight
 *   or the OpenAPI document itself.
 *
 * "Not done yet" is deliberately not among them. A route whose schema has not
 * been written is the exact state this fails on.
 */
export type SkipCause = "hand-serialized" | "binary" | "sse" | "redirect" | "framework";

/** One route argued out of the invariant, named the way the router names it. */
export interface Skip {
  readonly method: string;
  readonly path: string;
  readonly cause: SkipCause;
  /** What about *this* route makes a schema impossible. The cause is the category; this is the case. */
  readonly why: string;
}

/**
 * As much of one route as this reads. An Elysia instance's `routes` satisfies
 * it structurally, so `app.routes` goes in with no cast — which matters more
 * than it looks: a cast is what lets an introspection that has stopped
 * answering keep type-checking.
 */
export interface RouteEntry {
  readonly method: string;
  readonly path: string;
  readonly hooks?: { readonly response?: unknown } | undefined;
}

/** What is being graded, and the two things only the repo can say about it. */
export interface Coverage {
  /** The composed app's own route table — `app.routes`, after every plugin is on. */
  readonly routes: readonly RouteEntry[];
  /** Every route argued out of the invariant. A greenfield API ships this empty. */
  readonly skips: readonly Skip[];
  /**
   * The number of routes at or below which the table is not believable — at it
   * as well as under it, since a floor a table exactly meets is one nobody has
   * raised since the app stopped growing. Introspection
   * that has broken answers with an empty list, and an empty list satisfies
   * every check here — so the floor is what stops a silent break from reading
   * as full coverage. It is a floor and not a count: set it below what the app
   * already serves and raise it as the app grows.
   */
  readonly floor: number;
}

/** A route as both halves of the table name it. */
function key({ method, path }: { readonly method: string; readonly path: string }): string {
  return `${method} ${path}`;
}

function declares({ hooks }: RouteEntry): boolean {
  return hooks?.response !== undefined;
}

/**
 * Every way this app fails the invariant, as the sentences a failing test
 * prints — sorted, so that two runs over one tree produce one diff.
 *
 * A list rather than a thrown assertion, and a list of strings rather than a
 * structure: the caller is one `expect(...).toEqual([])` in the repo's own
 * suite, and what it has to show a reader when it fails is what to do next.
 */
export function responseSchemaGaps({ routes, skips, floor }: Coverage): string[] {
  if (routes.length <= floor) {
    return [
      `the route table has ${routes.length} routes, at or below the floor of ${floor} — every check below passes vacuously against a table this short, so fix whatever stopped \`app.routes\` from answering, or raise the floor if the app really did shrink`,
    ];
  }

  const undeclared = new Set(routes.filter((route) => !declares(route)).map(key));
  const served = new Set(routes.map(key));
  const listed = new Set<string>();
  const problems: string[] = [];

  for (const skip of skips) {
    const at = key(skip);
    if (listed.has(at)) {
      problems.push(
        `the skips table lists ${at} twice — drop one, since an entry with a twin can never be shown to have gone stale`,
      );
      continue;
    }
    listed.add(at);

    if (!undeclared.has(at)) {
      const because = served.has(at)
        ? "that route declares a response schema now"
        : "that route is no longer served";
      problems.push(
        `the skip for ${at} is stale: ${because}. Take it out — a table that outlives its routes is one nobody drains`,
      );
      continue;
    }

    // The gate can only see that a sentence is there; whether it is a good one
    // is review's job. What it does refuse is the entry that restates its own
    // category, which is the shape a placeholder takes.
    const why = skip.why.trim();
    if (why === "" || why.toLowerCase() === skip.cause) {
      problems.push(
        `the skip for ${at} gives no reason beyond its \`${skip.cause}\` cause — say what about this route makes a response schema impossible, since the cause is the category and the reason is the case`,
      );
    }
  }

  for (const at of undeclared) {
    if (listed.has(at)) continue;
    problems.push(
      `${at} declares no \`response\` schema — give it one, or add it to the skips table with the structural cause that makes a schema impossible; Elysia validates and cleans against that schema, so an undeclared route is a body nothing pins`,
    );
  }

  return problems.toSorted();
}
