import { c as Timing } from "./request-timing-operation-BW73YQNi.js";
import "./request-timing.js";
import { AnyElysia } from "elysia";
//#region request-timing-elysia.d.ts
/**
 * The plugin, for `timing`: `app.use(requestTimingPlugin(timing))`, mounted
 * before the app's routes, since Elysia applies a hook only to the routes
 * registered after it.
 *
 * Every request the app serves, matched or not, runs inside one operation,
 * from before its `onRequest` hooks to the end of its response: a buffered
 * response once Elysia hands it to the server, a streamed one after its last
 * chunk, and either once the client has gone. The operation is named by the
 * route Elysia matched, as registered, or `unmatched`; its status is the
 * response's, whatever error handler made it, 101 for a request Bun upgraded
 * to a WebSocket, or 499 for a client gone before there was one. A request the
 * app serves in-process while an operation is current opens none of its own. Mounting it throws, naming the route, where a route was
 * registered ahead of it, and `app.listen` throws where a route's pattern is
 * not one the core takes.
 */
export declare function requestTimingPlugin(timing: Timing): <App extends AnyElysia>(app: App) => App;
//#endregion