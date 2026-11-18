/** A body written as the server pulls it, with a database wait and an outbound one between its chunks. */
import { Effect } from "effect";

import { Outside, run, touch } from "../../../server/effect.ts";
import { timedRoute } from "../../../server/timing.ts";

const encoder = new TextEncoder();

export const GET = timedRoute("/api/stream", () => {
  const steps = [
    async () => "first;",
    async () => {
      await run(touch);
      return "second;";
    },
    async () => {
      await run(Effect.flatMap(Outside, (outside) => outside.send("/remote")));
      return "third";
    },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const step = steps.shift();
        if (step === undefined) return controller.close();
        controller.enqueue(encoder.encode(await step()));
      },
    }),
    { headers: { "content-type": "text/plain" } },
  );
});
