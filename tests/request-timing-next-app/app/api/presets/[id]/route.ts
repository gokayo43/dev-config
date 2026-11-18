/** A preset, read by an Effect program through the route adapter: two database waits and one outbound. */
import { Effect } from "effect";

import { handleRoute, presetById } from "../../../../server/effect.ts";
import { timedRoute } from "../../../../server/timing.ts";

export const GET = timedRoute(
  "/api/presets/[id]",
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    return handleRoute(Effect.map(presetById(Number(id)), (answer) => Response.json(answer)));
  },
);
