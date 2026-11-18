import { a as methodOf, t as OperationName } from "./request-timing-operation-De4y0ZtW.js";
import { within } from "./request-timing.js";
//#region request-timing-elysia.ts
/**
* A body Elysia streams is one it sends chunked with no length: every
* generator, `ReadableStream` and `sse()` a handler answers, and every response
* that says `transfer-encoding: chunked` itself.
*/
const isStreamed = (response) => response.headers.get("transfer-encoding") === "chunked";
/**
* `body`, passed through chunk for chunk, calling `ended` once the last chunk
* has been taken or the client has cancelled it. Elysia ends a source that
* fails as though it had finished, so a read never rejects here. A
* high-water mark of nothing reads no chunk ahead of the client, so the source
* is pulled exactly as it was before the connector stood in front of it.
*/
function watched(body, ended) {
	const reader = body.getReader();
	return new ReadableStream({
		pull: (controller) => reader.read().then((chunk) => {
			if (!chunk.done) return controller.enqueue(chunk.value);
			controller.close();
			return ended(false);
		}),
		cancel: (reason) => {
			ended(true);
			return reader.cancel(reason);
		}
	}, { highWaterMark: 0 });
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
* response's, whatever error handler made it, or 499 for a client gone before
* there was one. Mounting it throws, naming the route, where a route was
* registered ahead of it, and `app.listen` throws where a route's pattern is
* not one the core takes.
*/
function requestTimingPlugin(timing) {
	const matchedRoutes = /* @__PURE__ */ new WeakMap();
	const names = /* @__PURE__ */ new Map();
	const nameOf = (pattern) => {
		const known = names.get(pattern);
		if (known !== void 0) return known;
		const name = OperationName.registered(pattern);
		names.set(pattern, name);
		return name;
	};
	const matched = (context) => {
		matchedRoutes.set(context.request, context.route);
	};
	const serve = (handle, request) => {
		const operation = timing.open();
		const { promise: ending, resolve: end } = Promise.withResolvers();
		ending.then((ended) => {
			const pattern = matchedRoutes.get(request);
			operation.close({
				method: methodOf(request.method),
				name: pattern === void 0 ? OperationName.unmatched : nameOf(pattern),
				...ended
			});
		});
		let produced;
		request.signal.addEventListener("abort", () => end({
			status: produced?.status ?? 499,
			aborted: true,
			streamed: produced !== void 0 && isStreamed(produced)
		}), { once: true });
		return new Promise((resolve) => resolve(within(operation, () => handle(request)))).then((response) => {
			if (!(response instanceof Response)) throw new TypeError("request timing: Elysia answered a request with no Response");
			produced = response;
			if (!isStreamed(response) || response.body === null) {
				end({
					status: response.status,
					aborted: false,
					streamed: false
				});
				return response;
			}
			const body = watched(response.body, (aborted) => end({
				status: response.status,
				aborted,
				streamed: true
			}));
			return new Response(body, response);
		}, (error) => {
			end({
				status: 500,
				aborted: false,
				streamed: false
			});
			throw error;
		});
	};
	return (app) => {
		const [preceding] = app.routes;
		if (preceding !== void 0) throw new Error(`request timing: ${preceding.method} ${preceding.path} was registered before the request-timing plugin, which names only the routes registered after it; mount the plugin ahead of every route`);
		app.wrap((handle, request) => () => serve(handle, request)).onTransform({ as: "global" }, matched).onStart(({ routes }) => {
			for (const route of routes) nameOf(route.path);
		});
		return app;
	};
}
//#endregion
export { requestTimingPlugin };
