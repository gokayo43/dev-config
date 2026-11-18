/** The latch's controls: GET answers once a handler is waiting on it, POST lets it on and answers once it has finished. */
import { held } from "../../../server/held.ts";
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/held", async () => {
  await held.reached();
  return new Response(null, { status: 204 });
});

export const POST = timedRoute("/api/held", async () => {
  await held.open();
  return new Response(null, { status: 204 });
});
