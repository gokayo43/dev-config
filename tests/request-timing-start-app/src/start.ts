/**
 * The Start instance: the CSRF check Start asks every app to mount for its
 * server functions, and, timed, the function middleware that names the
 * operation of a server function called over HTTP.
 */
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { nameServerFunction } from "../../../request-timing-tanstack-start.ts";
import { timed } from "./timing.ts";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" }),
  ],
  functionMiddleware: timed
    ? [createMiddleware({ type: "function" }).server(nameServerFunction)]
    : [],
}));
