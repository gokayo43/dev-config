/**
 * Request timing as the app switches it on: one sink, the route wrapper and
 * the procedure middleware. With timing off the wrapper hands the handler back
 * as it is, and no procedure carries the middleware.
 */
import { getHTTPStatusCodeFromError } from "@trpc/server/http";

import { requestTimingRoute } from "../../../request-timing-next.ts";
import { requestTimingProcedures } from "../../../request-timing-trpc.ts";
import { requestTiming } from "../../../request-timing.ts";
import { faultLine } from "../../request-timing-fixture.ts";
import { timed } from "./env.ts";

/** The operations whose records the sink refuses, by throwing, as a sink whose log has gone would. */
const UNWRITTEN = new Set(["/api/unwritten", "faults.unwritten"]);

const timing = requestTiming({
  fault: (error) => process.stdout.write(`${faultLine(error)}\n`),
  sink: (record) => {
    if (UNWRITTEN.has(record.operation)) throw new Error("the sink refused the record");
    process.stdout.write(`${JSON.stringify({ service: "fixture", ...record })}\n`);
  },
});

const wrapped = requestTimingRoute(timing);

export const timedRoute: typeof wrapped = timed
  ? wrapped
  : (_pattern, handler) => async (request, context) => handler(request, context);

export const procedureTiming = requestTimingProcedures(timing, getHTTPStatusCodeFromError);
