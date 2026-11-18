/** A handler that throws after one database wait, which Next.js answers with 500. */
import { run, touch } from "../../../server/effect.ts";
import { timedRoute } from "../../../server/timing.ts";

export const GET = timedRoute("/api/fail", async () => {
  await run(touch);
  throw new Error("the handler failed");
});
