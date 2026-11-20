import { f as Timing } from "./request-timing-Cs0lSxaS.js";
/**
 * The wrapper, for `timing`. An app makes it once and wraps each handler a
 * `route.ts` exports with it, naming the route's pattern as its place under
 * `app/` gives it, route groups left out:
 *
 * ```ts
 * export const GET = timedRoute("/api/presets/[id]", async (request, { params }) => ...);
 * ```
 *
 * A request the handler serves is one operation, from the call to the end of
 * its response: once the server has taken the last chunk of the body, or at
 * once where there is no body to take (no body at all, or a HEAD). Its status
 * is the response's; a handler that throws is recorded with the 500 Next.js
 * answers; a client that leaves closes it then, `aborted`, with the status the
 * handler had produced or 499. A request served while an operation is current
 * opens none of its own. The pattern is refused, by throwing, when the module
 * that wraps the handler is loaded, which `next build` does for every route.
 */
export declare function requestTimingRoute(timing: Timing): <R extends Request, C>(pattern: string, handler: (request: R, context: C) => Response | Promise<Response>) => ((request: R, context: C) => Promise<Response>);