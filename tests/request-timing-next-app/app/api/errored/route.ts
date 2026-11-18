/** A status no response can be sent with, which the server answers in its own way. */
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/errored", () => Response.error());
