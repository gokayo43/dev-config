/** The route that carries the router's procedures over HTTP, marked as their envelope while timing is on. */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { timed } from "../../../../server/env.ts";
import { appRouter } from "../../../../server/router.ts";
import { procedureTiming } from "../../../../server/timing.ts";

// A long input is sent as a POST, as the warehouse's client does.
const serve = (request: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => ({}),
    allowMethodOverride: true,
  });

const handler = timed ? procedureTiming.envelope(appRouter, serve) : serve;

export { handler as GET, handler as POST };
