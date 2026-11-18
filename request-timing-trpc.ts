/**
 * Request timing's tRPC connector: one middleware an app puts on its base
 * procedure, which runs every procedure call that arrives over HTTP as one
 * operation named by the procedure's path, and the envelope the app wraps its
 * HTTP handler in, which is what says a call arrived over HTTP.
 * `docs/exports/request-timing.md` says how an app mounts it and what its
 * records hold.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { TRPCError, TRPCProcedureType, TRPCRouterRecord } from "@trpc/server";

import { endings, registeredNames } from "./request-timing-entry.ts";
import { marked } from "./request-timing-route.ts";
import { inOperation, type Method, type Operation, type Timing, within } from "./request-timing.ts";

/** What tRPC's middleware is handed, as far as the connector reads it. */
export interface ProcedureCall<Result> {
  readonly path: string;
  readonly type: TRPCProcedureType;
  readonly signal: AbortSignal | undefined;
  readonly next: () => Promise<Result>;
}

/** What `next` answers: the call's data, or the error tRPC made of what it threw. */
export type ProcedureAnswer =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: TRPCError };

/**
 * The method an HTTP reader expects of a call of this type, whatever the
 * client sent it with: a query sent as a POST, as `methodOverride` does for a
 * long input, is still a read.
 */
const METHOD_OF: Readonly<Record<TRPCProcedureType, Method>> = {
  query: "GET",
  mutation: "POST",
  subscription: "GET",
};

const isAsyncIterable = (data: unknown): data is AsyncIterable<unknown> =>
  typeof data === "object" && data !== null && Symbol.asyncIterator in data;

/**
 * `source`, yielding what it yields, each step run under `operation` so the
 * work between two values counts in it, and `ended` called once it is done:
 * when it finishes, fails, or its consumer stops it.
 */
function iterated(
  source: AsyncIterable<unknown>,
  operation: Operation,
  ended: () => void,
): AsyncIterable<unknown> {
  const settle = <T>(step: Promise<IteratorResult<T>>) =>
    step.then(
      (result) => {
        if (result.done === true) ended();
        return result;
      },
      (error: unknown) => {
        ended();
        throw error;
      },
    );
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = within(operation, () => source[Symbol.asyncIterator]());
      return {
        next: () => settle(within(operation, () => iterator.next())),
        return: (value?: unknown) => {
          ended();
          return (
            within(operation, () => iterator.return?.(value)) ??
            Promise.resolve({ done: true as const, value })
          );
        },
      };
    },
  };
}

/**
 * The connector, for `timing`. `statusOf` is tRPC's own mapping of an error to
 * the HTTP status a client of a single call receives, `getHTTPStatusCodeFromError`
 * from `@trpc/server/http`, which the app hands over since this package
 * imports tRPC as types alone:
 *
 * ```ts
 * export const procedureTiming = requestTimingProcedures(timing, getHTTPStatusCodeFromError);
 * export const procedure = t.procedure.use(procedureTiming.middleware);
 * ```
 *
 * and in the route that serves the router over HTTP:
 *
 * ```ts
 * const handler = procedureTiming.envelope(appRouter, (request: Request) => fetchRequestHandler(...));
 * ```
 */
export function requestTimingProcedures(timing: Timing, statusOf: (error: TRPCError) => number) {
  /** Holds while a request the envelope serves runs, so only a call over HTTP opens an operation. */
  const carried = new AsyncLocalStorage<true>();
  const nameOf = registeredNames();

  /**
   * The middleware. Every call of a procedure built on it, that arrives
   * through the envelope while no operation is current, is one operation
   * named by the procedure's path, alone or in a batch; a call made in-process
   * (`createCaller`, a server component, a background job) opens none.
   *
   * It closes when the procedure has answered, with 200 or the status
   * `statusOf` gives its error, and at once where the client leaves first,
   * `aborted`, with 499. A procedure that answers an async iterable (every
   * subscription, and a query streamed over `httpBatchStreamLink`) closes when
   * the iteration ends, `streamed`, with 200, and `aborted` where the client
   * left.
   */
  const middleware = async <Result extends ProcedureAnswer>(
    call: ProcedureCall<Result>,
  ): Promise<Result> => {
    if (carried.getStore() === undefined || inOperation()) return call.next();
    const operation = timing.open();
    let streaming = false;
    // A call in a batch has no request of its own: its method is its type's,
    // and its abort signal is tRPC's.
    const end = endings(
      timing,
      operation,
      METHOD_OF[call.type],
      () => nameOf(call.path),
      call.signal,
      () => ({ status: streaming ? 200 : 499, aborted: true, streamed: streaming }),
    );
    const result = await within(operation, call.next);
    if (!result.ok) {
      end({ status: statusOf(result.error), aborted: false, streamed: false });
      return result;
    }
    if (!isAsyncIterable(result.data)) {
      end({ status: 200, aborted: false, streamed: false });
      return result;
    }
    streaming = true;
    const data = iterated(result.data, operation, () =>
      end({ status: 200, aborted: false, streamed: true }),
    );
    return { ...result, data };
  };

  /**
   * The envelope: `handler`, the route's handler that serves `router` over
   * HTTP, run so that the calls it carries open their operations, and marked
   * for the conformance kit's route-tree check. It opens no operation itself.
   * Every procedure's path is checked as a name here, when the route module is
   * loaded, so a path the core refuses fails `next build` rather than a call;
   * a lazily loaded router's paths are checked when a call closes, where a
   * refused one goes to the app's `fault` and the call writes no record.
   */
  const envelope = <R extends Request, C>(
    router: { readonly _def: { readonly procedures: TRPCRouterRecord } },
    handler: (request: R, context: C) => Promise<Response>,
  ): ((request: R, context: C) => Promise<Response>) => {
    for (const path of Object.keys(router._def.procedures)) nameOf(path);
    const carrying = (request: R, context: C) => carried.run(true, () => handler(request, context));
    return marked(carrying, { kind: "envelope" });
  };

  return { middleware, envelope };
}
