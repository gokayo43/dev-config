/** A body that sends one chunk and then waits on the latch, for a client to leave midway. */
import { run, touch } from "../../../server/effect.ts";
import { held } from "../../../server/held.ts";
import { timedRoute } from "../../../server/timing.ts";

const encoder = new TextEncoder();

export const GET = timedRoute("/api/drip", () => {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!sent) {
          sent = true;
          return controller.enqueue(encoder.encode("drop;"));
        }
        await held.wait();
        await run(touch);
        held.done();
        controller.enqueue(encoder.encode("never read"));
        controller.close();
      },
    }),
  );
});
