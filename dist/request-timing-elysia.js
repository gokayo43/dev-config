import { must } from "./narrowing.js";
import { n as registeredNames, r as timedEntry } from "./request-timing-entry-DUtRZjoK.js";
import { i as OperationName } from "./request-timing-CRXpA8f5.js";
// request-timing-elysia.ts
/**
* A body Elysia streams is one it sends chunked with no length: every
* generator, `ReadableStream` and `sse()` a handler answers, and every response
* that says `transfer-encoding: chunked` itself.
*/
const isStreamed = (response) => response.headers.get("transfer-encoding") === "chunked";
/**
* Elysia's own type says its handler answers a Function; what it answers is
* the Response every route and error handler is mapped to.
*/
function asResponse(answered) {
	if (!(answered instanceof Response)) throw new TypeError("request timing: Elysia answered a request with no Response");
	return answered;
}
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
* app serves in-process while an operation is current opens none of its own.
* Mounting it throws, naming the route, where a route was registered ahead of
* it, and `app.listen` throws where a route's pattern is not one the core
* takes; an app served without `listen` meets that pattern at its first
* request, where the name goes to the app's `fault` and no record is written.
*/
function requestTimingPlugin(timing) {
	const matchedRoutes = /* @__PURE__ */ new WeakMap();
	/** The requests Bun's server took over as WebSockets, whose client received 101. */
	const upgraded = /* @__PURE__ */ new WeakSet();
	const nameOf = registeredNames();
	const matched = (context) => {
		matchedRoutes.set(context.request, context.route);
	};
	const serve = (handle, request) => timedEntry(timing, request, () => Promise.resolve(handle(request)).then(asResponse), () => () => {
		const pattern = matchedRoutes.get(request);
		return pattern === void 0 ? OperationName.unmatched : nameOf(pattern);
	}, (response) => !isStreamed(response) || response.body === null ? { close: {
		status: upgraded.has(request) ? 101 : response.status,
		aborted: false,
		streamed: false
	} } : {
		watch: response.body,
		streamed: () => true
	});
	return (app) => {
		const [preceding] = app.routes;
		if (preceding !== void 0) throw new Error(`request timing: ${preceding.method} ${preceding.path} was registered before the request-timing plugin, which names only the routes registered after it; mount the plugin ahead of every route`);
		app.wrap((handle, request) => () => serve(handle, request)).onTransform({ as: "global" }, matched).onStart(({ routes, server }) => {
			for (const route of routes) nameOf(route.path);
			const running = must(server);
			const upgrade = running.upgrade.bind(running);
			running.upgrade = (request, ...options) => {
				const taken = upgrade(request, ...options);
				if (taken) upgraded.add(request);
				return taken;
			};
		});
		return app;
	};
}
export { requestTimingPlugin };
