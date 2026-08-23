import { entry, inputs, publish, required } from "../_lib/gate.ts";
import { backfillGate } from "./backfill.ts";

await entry(async () => {
  const read = inputs(
    "backfill-seed",
    "backfill-command",
    "seeded-data",
    "first-data",
    "second-data",
  );

  // The service the calling job declared, from the environment it owns. This
  // builds a database of its own beside the declared one rather than writing
  // into it: the seed's rows would otherwise still be there when the app
  // boots, and the boot step's whole claim is about a database its migrations
  // built.
  const url = required(
    "DATABASE_URL",
    "the backfill check builds its own database on the service the calling job declared",
  );

  await publish(
    await backfillGate({
      // The action ran this from the project it was pointed at, and both
      // commands are the repo's own, run the way the repo would run them.
      root: process.cwd(),
      url,
      seed: read["backfill-seed"],
      command: read["backfill-command"],
      evidence: {
        seeded: read["seeded-data"],
        first: read["first-data"],
        second: read["second-data"],
      },
    }),
  );
});
