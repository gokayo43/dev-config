/** Waits on nothing, and its record is refused by the sink. */
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/unwritten", () => new Response("served"));
