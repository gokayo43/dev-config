/** The overlap case's lane among route handlers, the same program the procedures' lanes run. */
import { Effect } from "effect";

import { handleRoute, lane } from "../../../server/effect.ts";
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/lane", (request: Request) => {
  const query = new URL(request.url).searchParams;
  const plan = {
    db: Number(query.get("db")),
    out: Number(query.get("out")),
    tx: query.get("tx") === "true",
  };
  return handleRoute(Effect.map(lane(plan), (done) => new Response(done)));
});
