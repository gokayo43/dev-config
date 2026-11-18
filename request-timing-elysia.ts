/**
 * Request timing's Elysia connector: one plugin an app mounts once, ahead of
 * its routes, which runs every request the app serves as one operation named
 * by the route Elysia matched. `docs/exports/request-timing.md` says how an app
 * mounts it and what its records hold.
 */
import type { AnyElysia, Elysia } from "elysia";

import { must } from "./narrowing.ts";
import { inOperation, methodOf, OperationName, type Timing, within } from "./request-timing.ts";

/** How a response ended, short of its name and method, which the request carries. */
interface Ended {
  readonly status: number;
  readonly aborted: boolean;
  readonly streamed: boolean;
}

/**
 * A body Elysia streams is one it sends chunked with no length: every
 * generator, `ReadableStream` and `sse()` a handler answers, and every response
 * that says `transfer-encoding: chunked` itself.
 */
const isStreamed = (response: Response): boolean =>
  response.headers.get("transfer-encoding") === "chunked";

/**
 * `body`, passed through chunk for chunk, calling `ended` once the last chunk
 * has been taken or the client has cancelled it. Elysia ends a source that
 * fails as though it had finished, so a read never rejects here. A
 * high-water mark of nothing reads no chunk ahead of the client, so the source
 * is pulled exactly as it was before the connector stood in front of it.
 */
function watched<Chunk>(
  body: ReadableStream<Chunk>,
  ended: (aborted: boolean) => void,
): ReadableStream<Chunk> {
  const reader = body.getReader();
  return new ReadableStream<Chunk>(
    {
      pull: (controller) =>
        reader.read().then((chunk) => {
          if (!chunk.done) return controller.enqueue(chunk.value);
          controller.close();
          return ended(false);
        }),
      cancel: (reason) => {
        ended(true);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
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
 * app serves in-process while an operation is current opens none of its own. Mounting it throws, naming the route, where a route was
 * registered ahead of it, and `app.listen` throws where a route's pattern is
 * not one the core takes.
 */
export function requestTimingPlugin(timing: Timing) {
  const matchedRoutes = new WeakMap<Request, string>();
  /** The requests Bun's server took over as WebSockets, whose client received 101. */
  const upgraded = new WeakSet<Request>();
  const names = new Map<string, OperationName>();
  const nameOf = (pattern: string): OperationName => {
    const known = names.get(pattern);
    if (known !== undefined) return known;
    const name = OperationName.registered(pattern);
    names.set(pattern, name);
    return name;
  };

  // Reads `route` off the context by property, never by passing the context
  // on: Elysia reads a hook's source to decide what each route computes, and a
  // context handed to a function makes every route parse its body.
  const matched = (context: { readonly request: Request; readonly route: string }): void => {
    matchedRoutes.set(context.request, context.route);
  };

  const serve = (handle: (request: Request) => object, request: Request): Promise<Response> => {
    const operation = timing.open();
    const { promise: ending, resolve: end } = Promise.withResolvers<Ended>();
    // The one place the operation closes, on the first ending to arrive. A
    // sink that throws rejects here, out of band of the response it measured,
    // which the client has already been answered with.
    void ending.then((ended) => {
      const pattern = matchedRoutes.get(request);
      operation.close({
        method: methodOf(request.method),
        name: pattern === undefined ? OperationName.unmatched : nameOf(pattern),
        ...ended,
      });
    });
    let produced: Response | undefined;
    request.signal.addEventListener(
      "abort",
      () =>
        end({
          status: produced?.status ?? 499,
          aborted: true,
          streamed: produced !== undefined && isStreamed(produced),
        }),
      { once: true },
    );
    const answered = new Promise<object>((resolve) =>
      resolve(within(operation, () => handle(request))),
    );
    return answered.then(
      (response) => {
        // Elysia's own type says its handler answers a Function; what it
        // answers is the Response every route and error handler is mapped to.
        if (!(response instanceof Response)) {
          throw new TypeError("request timing: Elysia answered a request with no Response");
        }
        produced = response;
        // `isStreamed` first: reading `body` turns a buffered body into a
        // stream, which Bun then sends as `application/octet-stream`.
        if (!isStreamed(response) || response.body === null) {
          // An upgraded request's response is Elysia's, which Bun drops: the
          // client was answered 101 by the upgrade itself.
          const status = upgraded.has(request) ? 101 : response.status;
          end({ status, aborted: false, streamed: false });
          return response;
        }
        const body = watched(response.body, (aborted) =>
          end({ status: response.status, aborted, streamed: true }),
        );
        return new Response(body, response);
      },
      (error: unknown) => {
        // A handler of errors that throws leaves the server to answer, and
        // Bun answers a fetch that throws with 500; the export's page asks an
        // app with an `error` option of its own to answer the same.
        end({ status: 500, aborted: false, streamed: false });
        throw error;
      },
    );
  };

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
      .wrap((handle, request) => () => (inOperation() ? handle(request) : serve(handle, request)))
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
