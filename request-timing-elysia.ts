/**
 * Request timing's Elysia connector: one plugin an app mounts once, ahead of
 * its routes, which runs every request the app serves as one operation named
 * by the route Elysia matched. `docs/exports/request-timing.md` says how an app
 * mounts it and what its records hold.
 */
import type { AnyElysia, Elysia } from "elysia";

import { must } from "./narrowing.ts";
import { registeredNames, timedEntry } from "./request-timing-entry.ts";
import { OperationName, type Timing } from "./request-timing.ts";

/**
 * A body Elysia streams is one it sends chunked with no length: every
 * generator, `ReadableStream` and `sse()` a handler answers, and every response
 * that says `transfer-encoding: chunked` itself.
 */
const isStreamed = (response: Response): boolean =>
  response.headers.get("transfer-encoding") === "chunked";

/**
 * Elysia's own type says its handler answers a Function; what it answers is
 * the Response every route and error handler is mapped to.
 */
function asResponse(answered: unknown): Response {
  if (!(answered instanceof Response)) {
    throw new TypeError("request timing: Elysia answered a request with no Response");
  }
  return answered;
}

/**
 * The plugin, for `timing`: `app.use(requestTimingPlugin(timing))`, mounted
 * before the app's routes, since Elysia applies a hook only to the routes
 * registered after it.
 *
 * Every request the app serves, matched or not, runs inside one operation,
 * from before its `onRequest` hooks to the end of its response: a buffered
 * response once Elysia hands it to the server, a streamed one after its last
 * chunk, and either once the client has gone. The operation is named by the
 * route Elysia matched, as registered, or `unmatched`; its status is the
 * response's, whatever error handler made it, 101 for a request Bun upgraded
 * to a WebSocket, or 499 for a client gone before there was one. A request the
 * app serves in-process while an operation is current opens none of its own.
 * Mounting it throws, naming the route, where a route was registered ahead of
 * it, and `app.listen` throws where a route's pattern is not one the core
 * takes; an app served without `listen` meets that pattern at its first
 * request, where the name goes to the app's `fault` and no record is written.
 */
export function requestTimingPlugin(timing: Timing) {
  const matchedRoutes = new WeakMap<Request, string>();
  /** The requests Bun's server took over as WebSockets, whose client received 101. */
  const upgraded = new WeakSet<Request>();
  const nameOf = registeredNames();

  // Reads `route` off the context by property, never by passing the context
  // on: Elysia reads a hook's source to decide what each route computes, and a
  // context handed to a function makes every route parse its body.
  const matched = (context: { readonly request: Request; readonly route: string }): void => {
    matchedRoutes.set(context.request, context.route);
  };

  const serve = (handle: (request: Request) => object, request: Request): Promise<Response> =>
    timedEntry(
      timing,
      request,
      () => Promise.resolve(handle(request)).then(asResponse),
      () => () => {
        const pattern = matchedRoutes.get(request);
        return pattern === undefined ? OperationName.unmatched : nameOf(pattern);
      },
      (response) =>
        // `isStreamed` first: reading `body` turns a buffered body into a
        // stream, which Bun then sends as `application/octet-stream`.
        !isStreamed(response) || response.body === null
          ? {
              close: {
                // An upgraded request's response is Elysia's, which Bun
                // drops: the client was answered 101 by the upgrade itself.
                status: upgraded.has(request) ? 101 : response.status,
                aborted: false,
                streamed: false,
              },
            }
          : { watch: response.body, streamed: () => true },
    );

  return <App extends AnyElysia>(app: App): App => {
    const [preceding] = app.routes;
    if (preceding !== undefined) {
      throw new Error(
        `request timing: ${preceding.method} ${preceding.path} was registered before the request-timing plugin, which names only the routes registered after it; mount the plugin ahead of every route`,
      );
    }
    // The hooks are registered on the app itself, which Elysia mutates, so
    // the app goes back with its own type and none of the plugin's.
    const elysia: Elysia = app;
    elysia
      // A request the app serves in-process while an operation is current,
      // as `app.handle` from a handler, is part of that operation.
      .wrap((handle, request) => () => serve(handle, request))
      .onTransform({ as: "global" }, matched)
      .onStart(({ routes, server }) => {
        for (const route of routes) nameOf(route.path);
        // `listen` sets the server before it starts the app. Bun answers an
        // upgrade itself, and only `upgrade`'s answer says one happened.
        const running = must(server);
        const upgrade = running.upgrade.bind(running);
        running.upgrade = (request, ...options) => {
          const taken = upgrade(request, ...options);
          if (taken) upgraded.add(request);
          return taken;
        };
      });
    return app;
  };
}
