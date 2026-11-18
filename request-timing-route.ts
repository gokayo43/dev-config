/**
 * The mark an entry connector leaves on a route handler it wrapped, and the
 * one way the conformance kit's route-tree check reads it back. No export
 * names this file; the Next.js and tRPC connectors' builds share it as a chunk,
 * and the kit, which ships as source, imports it as source.
 *
 * The mark is a property under a registered symbol, never a module's own
 * WeakMap: the app's route modules hold the built connector, while the kit
 * that reads them runs this file's source, so the two are different module
 * instances that agree only on `Symbol.for`'s key.
 */
const MARK = Symbol.for("@gokayo43/dev-config/request-timing/route");

/** What a route handler was wrapped as: an operation named by its pattern, or an envelope that carries procedures. */
export type RouteMark =
  | { readonly kind: "route"; readonly pattern: string }
  | { readonly kind: "envelope" };

/** What a route module exports for a method: a handler that answers a response. */
export type RouteHandler = (request: never, context: never) => Response | Promise<Response>;

/** `handler`, marked as `mark` says. */
export function marked<H extends RouteHandler>(handler: H, mark: RouteMark): H {
  Object.defineProperty(handler, MARK, { value: mark });
  return handler;
}

/** The mark `handler` carries, or nothing where no connector wrapped it. */
export function markOf(handler: Function): RouteMark | undefined {
  const mark: unknown = Object.getOwnPropertyDescriptor(handler, MARK)?.value;
  if (mark === undefined) return undefined;
  if (typeof mark !== "object" || mark === null || !("kind" in mark)) {
    throw new TypeError("request timing: a route handler carries a mark no connector wrote");
  }
  if (mark.kind === "envelope") return { kind: "envelope" };
  if (mark.kind === "route" && "pattern" in mark && typeof mark.pattern === "string") {
    return { kind: "route", pattern: mark.pattern };
  }
  throw new TypeError("request timing: a route handler carries a mark no connector wrote");
}
