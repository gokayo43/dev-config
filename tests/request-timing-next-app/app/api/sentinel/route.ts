/** Waits on nothing: the record a case reads to know every record before it has been written. */
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/sentinel", () => new Response(null, { status: 204 }));
