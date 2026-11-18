/**
 * A built TanStack Start fixture served by Bun, as its server entry's `fetch`
 * is served in production.
 */
import type * as Entry from "./request-timing-start-app/src/server.ts";

/** Loads the built server entry at `entry` and serves it on a free loopback port. */
export async function startServer(entry: string) {
  // The bundle is the fixture's own server entry, built; its exports are that module's.
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- see above
  const app: typeof Entry = await import(entry);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => app.default.fetch(request),
    // Bun's own answer to a fetch that throws is a page it also logs as a
    // failure, which `bun test` counts against the run; this is the same 500.
    error: () => new Response("down", { status: 500 }),
  });
  return { app, server };
}
