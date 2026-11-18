/**
 * The overlap case's latch: holds the token cache's lock for a round of lanes,
 * answering `held;` once it holds it and `released` once every lane has
 * queued for it and it has let go.
 */
import { Effect } from "effect";

import { run, Turns } from "../../../server/effect.ts";
import { timedRoute } from "../../../server/timing.ts";

const encoder = new TextEncoder();

export const GET = timedRoute("/api/latch", async (request: Request) => {
  const lanes = Number(new URL(request.url).searchParams.get("lanes"));
  const holding = Promise.withResolvers<void>();
  const released = run(Effect.flatMap(Turns, (turns) => turns.hold(lanes, holding.resolve)));
  await holding.promise;
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!sent) {
          sent = true;
          return controller.enqueue(encoder.encode("held;"));
        }
        await released;
        controller.enqueue(encoder.encode("released"));
        controller.close();
      },
    }),
  );
});
