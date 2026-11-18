/** A handler that waits on the latch between two database waits, for a client to leave during. */
import { run, touch } from "../../../server/effect.ts";
import { held } from "../../../server/held.ts";
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/hang", async () => {
  await run(touch);
  await held.wait();
  await run(touch);
  held.done();
  return new Response("too late");
});
