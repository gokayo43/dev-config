/**
 * Request timing's TanStack Start connector: a wrapper around the server
 * entry's request handler, which runs every request the app serves as one
 * operation, and a function middleware that names the operation of a server
 * function called over HTTP. `docs/exports/request-timing.md` says how an app
 * mounts both and what their records hold.
 */
import type { AnyRouter } from "@tanstack/react-router";

import { must } from "./narrowing.ts";
import { endings, watched } from "./request-timing-entry.ts";
import { type Operation, plainStorage } from "./request-timing-operation.ts";
import { inOperation, OperationName, type Timing, within } from "./request-timing.ts";

/**
 * The operation of a server function called over HTTP, waiting for the
 * function middleware to name it: `id` is the id the request's path carries,
 * and `name` is set by the run of the function with that id.
 */
interface Awaiting {
  readonly id: string;
  name: OperationName | undefined;
}

/**
 * Every open operation of a server-function request, by the operation. The
 * function middleware reaches it through the plain carrier, so both halves
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
const isStreamed = (response: Response): boolean =>
  response.headers.get("transfer-encoding") === "chunked" ||
  /^(?:text\/event-stream|application\/x-tss-framed)\b/u.test(
    response.headers.get("content-type") ?? "",
  );

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
  const router = getRouter();
  const names = new Map<string, OperationName>();
  // The router's table types every route as `AnyRoute`, generic in every
  // position; these two fields are the whole of what is read of one.
  const routes: readonly Named[] = Object.values(router.routesById);
  for (const route of routes) {
    if (!route.isRoot) names.set(route.fullPath, OperationName.registered(route.fullPath));
  }

  /**
   * The route the router matches for `pathname`, as Start's own handler asks
   * it. `**` among the params is Start's mark for a route that matched only a
   * prefix of the path, which renders the not-found page and runs no handler.
   */
  const routeName = (pathname: string): OperationName => {
    const [, params, found] = router.getMatchedRoutes(pathname);
    const route: Named | undefined = found;
    if (route === undefined || params["**"] !== undefined) return OperationName.unmatched;
    // The root route is the one left out of the table: it answers no path of
    // its own, and the router finds it only for a path no route matched.
    return names.get(route.fullPath) ?? OperationName.unmatched;
  };

  const serve = (request: Request, handlerOptions: Options | undefined): Promise<Response> => {
    const operation = timing.open();
    const { pathname } = new URL(request.url);
    let name: () => OperationName;
    if (pathname.startsWith(base)) {
      // Start's own reading of the id: the path segment after the base.
      const awaiting: Awaiting = {
        id: must(pathname.slice(base.length).split("/")[0]),
        name: undefined,
      };
      awaitingName.set(operation, awaiting);
      name = () => awaiting.name ?? OperationName.unmatched;
    } else {
      const matched = routeName(pathname);
      name = () => matched;
    }
    const { end, produced } = endings(operation, request, name, isStreamed);
    const answered = new Promise<Response>((resolve) =>
      resolve(within(operation, () => handler(request, handlerOptions))),
    );
    return answered.then(
      (response) => {
        produced(response);
        const streamed = isStreamed(response);
        // Copied before the body is read: Bun drops a content type it derived
        // from a buffered body, a typed Blob's or form data's, from the
        // headers once that body is read as a stream.
        const headers = new Headers(response.headers);
        // Bun gives a body whose headers name no content type, a string's or
        // bytes', one of its own as it sends it, which a copy of the body
        // would not get; so such a response is closed as it is handed over.
        if (!headers.has("content-type") || response.body === null) {
          end({ status: response.status, aborted: false, streamed });
          return response;
        }
        const body = watched(response.body, (aborted) =>
          end({ status: response.status, aborted, streamed }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
      (error: unknown) => {
        // Start throws out of its handler only for a server route or page
        // whose handler threw, and Bun answers a fetch that throws with 500.
        end({ status: 500, aborted: false, streamed: false });
        throw error;
      },
    );
  };

  return (request, handlerOptions) =>
    // A request served in-process while an operation is current is part of it.
    inOperation() ? handler(request, handlerOptions) : serve(request, handlerOptions);
}

/** What `nameServerFunction` reads of a server function's middleware call. */
interface ServerFunctionCall<Next> {
  /** Start's compile-time record of the function: its id, its variable name and its file. */
  readonly serverFnMeta: { readonly id: string; readonly name: string; readonly filename: string };
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
 * which names nothing. A file whose path the core refuses, one with a space, `?` or `#`,
 * throws on the function's every call.
 */
export function nameServerFunction<Next>(call: ServerFunctionCall<Next>): Next {
  const operation = plainStorage.getStore();
  const awaiting = operation === undefined ? undefined : awaitingName.get(operation);
  if (awaiting?.name === undefined && awaiting?.id === call.serverFnMeta.id) {
    awaiting.name = OperationName.registered(
      `${call.serverFnMeta.filename}:${call.serverFnMeta.name}`,
    );
  }
  return call.next();
}
