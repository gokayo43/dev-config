/**
 * Request timing's TanStack Start connector: a wrapper around the server
 * entry's request handler, which runs every request the app serves as one
 * operation, and a function middleware that names the operation of a server
 * function called over HTTP. `docs/exports/request-timing.md` says how an app
 * mounts both and what their records hold.
 */
import type { AnyRouter } from "@tanstack/react-router";

import { must } from "./narrowing.ts";
import { registeredNames, timedEntry } from "./request-timing-entry.ts";
import { type Operation, current } from "./request-timing-operation.ts";
import { OperationName, type Timing } from "./request-timing.ts";

/** What Start's compiler records of a server function: its id, its variable name and its file. */
interface ServerFnMeta {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
}

/**
 * The operation of a server function called over HTTP, waiting for the
 * function middleware: `id` is the id the request's path carries, and `meta`
 * is set by the run of the function with that id. The name is made of it at
 * the close, where a name the core refuses goes to the app's `fault`.
 */
interface Awaiting {
  readonly id: string;
  meta: ServerFnMeta | undefined;
}

/**
 * Every open operation of a server-function request, by the operation. The
 * function middleware reaches it through `AsyncLocalStorage`, so both halves
 * agree on which request a call belongs to without either reading the other's
 * state.
 */
const awaitingName = new WeakMap<Operation, Awaiting>();

/**
 * Start's own path for server-function calls when an app configures none:
 * `serverFns.base` of the Start plugin, `/_serverFn`, under the router's
 * basepath `/`.
 */
const DEFAULT_SERVER_FN_BASE = "/_serverFn/";

/**
 * A body sent over time rather than at once: a server-sent event stream, a
 * server function's framed answer (a stream, an async iterable or a promise it
 * returns unresolved), and every response that says `transfer-encoding:
 * chunked` itself. A rendered page is not one, since its time to the last byte
 * is the page's own work.
 */
const isStreamed = (headers: Headers): boolean =>
  headers.get("transfer-encoding") === "chunked" ||
  /^(?:text\/event-stream|application\/x-tss-framed)\b/u.test(headers.get("content-type") ?? "");

/** What the wrapper reads of a route in the router's table. */
interface Named {
  readonly fullPath: string;
  readonly isRoot: boolean;
}

/** The handler of Start's server entry, `createStartHandler`'s answer, and the wrapper's. */
export type StartHandler<Options> = (
  request: Request,
  options?: Options,
) => Response | Promise<Response>;

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
export function timedStartHandler<Options>(
  timing: Timing,
  handler: StartHandler<Options>,
  getRouter: () => AnyRouter,
  options: StartTimingOptions = {},
): StartHandler<Options> {
  const base = options.serverFnBase ?? DEFAULT_SERVER_FN_BASE;
  if (!base.startsWith("/") || !base.endsWith("/")) {
    throw new Error(
      `request timing: serverFnBase is the path server functions are called on, beginning and ending with "/", such as "/_serverFn/"; it was given as ${JSON.stringify(base)}`,
    );
  }
  const router = getRouter();
  const nameOf = registeredNames();
  // The router's table types every route as `AnyRoute`, generic in every
  // position; these two fields are the whole of what is read of one.
  const routes: readonly Named[] = Object.values(router.routesById);
  for (const route of routes) if (!route.isRoot) nameOf(route.fullPath);

  /**
   * The route the router matches for `pathname`, as Start's own handler asks
   * it. `**` among the params is Start's mark for a route that matched only a
   * prefix of the path, which renders the not-found page and runs no handler,
   * and the root route answers no path of its own: it is found only for a path
   * no route matched.
   */
  const routeName = (pathname: string): OperationName => {
    const [, params, found] = router.getMatchedRoutes(pathname);
    const route: Named | undefined = found;
    if (route === undefined || route.isRoot || params["**"] !== undefined) {
      return OperationName.unmatched;
    }
    return nameOf(route.fullPath);
  };

  /** How the operation serving a request to `pathname` is named, once it is open. */
  const naming =
    (pathname: string) =>
    (operation: Operation): (() => OperationName) => {
      if (!pathname.startsWith(base)) return () => routeName(pathname);
      // Start's own reading of the id: the path segment after the base.
      const awaiting: Awaiting = {
        id: must(pathname.slice(base.length).split("/")[0]),
        meta: undefined,
      };
      awaitingName.set(operation, awaiting);
      return () =>
        awaiting.meta === undefined
          ? OperationName.unmatched
          : nameOf(`${awaiting.meta.filename}:${awaiting.meta.name}`);
    };

  return (request, handlerOptions) =>
    timedEntry(
      timing,
      request,
      () => handler(request, handlerOptions),
      naming(new URL(request.url).pathname),
      (response, headers) => {
        const streamed = isStreamed(headers);
        // Bun gives a body whose headers name no content type, a string's or
        // bytes', one of its own as it sends it, which a copy of the body
        // would not get; so such a response is closed as it is handed over.
        return !headers.has("content-type") || response.body === null
          ? { close: { status: response.status, aborted: false, streamed } }
          : { watch: response.body, streamed: () => streamed };
      },
    );
}

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
export function nameServerFunction<Next>(call: ServerFunctionCall<Next>): Next {
  const operation = current.getStore();
  const awaiting = operation === undefined ? undefined : awaitingName.get(operation);
  if (awaiting?.meta === undefined && awaiting?.id === call.serverFnMeta.id) {
    awaiting.meta = call.serverFnMeta;
  }
  return call.next();
}
