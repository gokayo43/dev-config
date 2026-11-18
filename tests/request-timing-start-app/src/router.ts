/**
 * The fixture's routes, in code rather than files: a page that renders on the
 * server and calls a server function in-process, and the server routes each
 * ending of the suite drives.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";

import { must } from "../../../narrowing.ts";
import { listPresetsFn } from "./fns.ts";
import { LANES } from "./lanes.ts";
import { findPreset, held, lane, listPresets } from "./presets.ts";
import { run } from "./runtime.ts";
import { UNWRITTEN } from "./timing.ts";

/** A refusal a server route throws, which leaves the server to answer 500. */
class Refused extends Error {}

function Shell({ children }: { readonly children: ReactNode }) {
  return createElement(
    "html",
    null,
    createElement("head", null, createElement(HeadContent)),
    createElement("body", null, children, createElement(Scripts)),
  );
}

const rootRoute = createRootRoute({ shellComponent: Shell });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // The page's own two waits and the server function's one, called in-process.
  loader: async () => {
    const [found, listed] = await Promise.all([run(findPreset(1)), listPresetsFn()]);
    return { first: found.preset?.label, labels: listed.map((preset) => preset.label) };
  },
  component: Home,
});

/** The page itself is static: what the suite reads of it is its loader's waits, and the data the HTML carries. */
function Home(): ReactNode {
  return createElement("main", null, createElement("h1", null, "Presets"));
}

const presetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/presets/$id",
  server: {
    handlers: {
      GET: async ({ params }) => {
        const found = await run(findPreset(Number(params.id)));
        return found.preset === undefined
          ? Response.json({ error: "no such preset" }, { status: 404 })
          : Response.json(found);
      },
    },
  },
});

/** The app's own handler, set by the server entry, which `/outer` serves a request with in-process. */
export const inProcess: { handle?: (request: Request) => Response | Promise<Response> } = {};

const outerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/outer",
  server: {
    handlers: {
      GET: async () => {
        const inner = await must(inProcess.handle)(new Request("http://in-process/presets/1"));
        await inner.text();
        await run(listPresets);
        return Response.json({ inner: inner.status });
      },
    },
  },
});

const unwrittenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: UNWRITTEN,
  server: { handlers: { GET: () => new Response("served") } },
});

/** A status no response can be sent with, which Bun answers with the server's own 500. */
const erroredRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/errored",
  server: { handlers: { GET: () => Response.error() } },
});

const encoder = new TextEncoder();

const streamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stream",
  server: {
    handlers: {
      GET: () =>
        new Response(
          new ReadableStream({
            start: async (controller) => {
              controller.enqueue(encoder.encode("data: first\n\n"));
              const rows = await run(listPresets);
              controller.enqueue(encoder.encode(`data: ${rows.length}\n\n`));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  },
});

const failRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fail",
  server: {
    handlers: {
      GET: async () => {
        await run(listPresets);
        throw new Refused("refused midway");
      },
    },
  },
});

const hangRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hang",
  server: {
    handlers: {
      GET: async () => {
        await run(listPresets);
        await held.wait();
        await run(listPresets);
        held.done();
        return Response.json("too late");
      },
    },
  },
});

const laneRoutes = Array.from({ length: LANES }, (_, index) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/lanes/${index}`,
    server: {
      handlers: {
        GET: async ({ request }) => {
          const { searchParams } = new URL(request.url);
          const plan = {
            queries: Number(searchParams.get("queries")),
            transaction: searchParams.get("transaction") === "true",
          };
          return Response.json(await run(lane(plan, `lane ${index}`)));
        },
      },
    },
  }),
);

const routeTree = rootRoute.addChildren([
  homeRoute,
  presetRoute,
  outerRoute,
  unwrittenRoute,
  erroredRoute,
  streamRoute,
  failRoute,
  hangRoute,
  ...laneRoutes,
]);

export function getRouter() {
  return createRouter({ routeTree });
}
