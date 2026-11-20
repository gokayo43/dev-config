/**
 * Request timing's TanStack Start connector: a wrapper around the server
 * entry's request handler, which runs every request the app serves as one
 * operation, and a function middleware that names the operation of a server
 * function called over HTTP. `docs/exports/request-timing.md` says how an app
 * mounts both and what their records hold.
 */
import { f as Timing } from "./request-timing-Cs0lSxaS.js";
import { AnyRouter } from "@tanstack/react-router";
/** What Start's compiler records of a server function: its id, its variable name and its file. */
interface ServerFnMeta {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
}
/** The handler of Start's server entry, `createStartHandler`'s answer, and the wrapper's. */
export type StartHandler<Options> = (request: Request, options?: Options) => Response | Promise<Response>;
/** What `timedStartHandler` takes beside the handler. */
export interface StartTimingOptions {
  /**
   * The path server functions are called on, as Start builds it: the router's
   * basepath, then the Start plugin's `serverFns.base`, then `/`. Unset is
   * Start's own default, `/_serverFn/`, which an app that sets neither keeps.
   */
  readonly serverFnBase?: string;
}
/**
 * Start's server-entry handler with every request it serves run as one
 * operation, for `timing`: `export default { fetch: timedStartHandler(timing,
 * createStartHandler(defaultStreamHandler), getRouter) }`.
 *
 * The operation lasts from the request to the last byte of its response, or
 * until the client goes away. A page or a server route is named by the route
 * the router matches, as registered (`/presets/$id`), and a server function
 * called over HTTP by the name `nameServerFunction` gives it; a request
 * neither names is `unmatched`. Its status is the response's, 500 where the
 * handler threw and the server answered, and 499 for a client gone before
 * there was one. A request served in-process while an operation is current,
 * such as the server function a page's loader calls, opens none of its own.
 *
 * `getRouter` is the app's own, called once now: every route the router
 * registers is named here, so a pattern the core refuses throws at startup
 * and never on a request.
 */
export declare function timedStartHandler<Options>(timing: Timing, handler: StartHandler<Options>, getRouter: () => AnyRouter, options?: StartTimingOptions): StartHandler<Options>;
/** What `nameServerFunction` reads of a server function's middleware call. */
interface ServerFunctionCall<Next> {
  readonly serverFnMeta: ServerFnMeta;
  readonly next: () => Next;
}
/**
 * The server half of a global function middleware, which names the operation
 * of a server function called over HTTP: in `src/start.ts`,
 * `functionMiddleware: [createMiddleware({ type: "function" }).server(nameServerFunction)]`,
 * listed first.
 *
 * The name is the function's file and variable, `src/server/presets.ts:listPresets`,
 * which Start's compiler records and which no build changes, where the id in
 * the request's path is a hash a reader cannot read back. The id is used only
 * to tell the call the request made from a call its handler makes in-process,
 * which names nothing. A name the core refuses, from a file path with a space,
 * `?` or `#`, or longer than it takes, goes to the app's `fault` when the
 * operation closes, and the call writes no record.
 */
export declare function nameServerFunction<Next>(call: ServerFunctionCall<Next>): Next;
export {};