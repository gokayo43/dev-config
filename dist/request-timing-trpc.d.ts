import { f as Timing } from "./request-timing-Cs0lSxaS.js";
import { TRPCError, TRPCProcedureType, TRPCRouterRecord } from "@trpc/server";
/** What tRPC's middleware is handed, as far as the connector reads it. */
export interface ProcedureCall<Result> {
  readonly path: string;
  readonly type: TRPCProcedureType;
  readonly signal: AbortSignal | undefined;
  readonly next: () => Promise<Result>;
}
/** What `next` answers: the call's data, or the error tRPC made of what it threw. */
export type ProcedureAnswer = {
  readonly ok: true;
  readonly data: unknown;
} | {
  readonly ok: false;
  readonly error: TRPCError;
};
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
export declare function requestTimingProcedures(timing: Timing, statusOf: (error: TRPCError) => number): {
  middleware: <Result extends ProcedureAnswer>(call: ProcedureCall<Result>) => Promise<Result>;
  envelope: <R extends Request, C>(router: {
    readonly _def: {
      readonly procedures: TRPCRouterRecord;
    };
  }, handler: (request: R, context: C) => Promise<Response>) => ((request: R, context: C) => Promise<Response>);
};