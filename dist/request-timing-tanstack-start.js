import { must } from "./narrowing.js";
import { o as plainStorage, t as OperationName } from "./request-timing-operation-gsGVMm95.js";
import { inOperation, within } from "./request-timing.js";
import { n as watched, t as endings } from "./request-timing-entry-Dp_bovEo.js";
//#region request-timing-tanstack-start.ts
/**
* Every open operation of a server-function request, by the operation. The
* function middleware reaches it through the plain carrier, so both halves
* agree on which request a call belongs to without either reading the other's
* state.
*/
const awaitingName = /* @__PURE__ */ new WeakMap();
/**
* Start's own path for server-function calls when an app configures none:
* `serverFns.base` of the Start plugin, `/_serverFn`, under the router's
* basepath `/`.
*/
const DEFAULT_SERVER_FN_BASE = "/_serverFn/";
/**
* A body sent over time rather than at once: a server-sent event stream, a
* server function's framed answer (a stream, an async iterable or a promise it
* returns unresolved), and every response that says `transfer-encoding:
* chunked` itself. A rendered page is not one, since its time to the last byte
* is the page's own work.
*/
const isStreamed = (response) => response.headers.get("transfer-encoding") === "chunked" || /^(?:text\/event-stream|application\/x-tss-framed)\b/u.test(response.headers.get("content-type") ?? "");
/**
* Start's server-entry handler with every request it serves run as one
* operation, for `timing`: `export default { fetch: timedStartHandler(timing,
* createStartHandler(defaultStreamHandler), getRouter) }`.
*
* The operation lasts from the request to the last byte of its response, or
* until the client goes away. A page or a server route is named by the route
* the router matches, as registered (`/presets/$id`), and a server function
* called over HTTP by the name `nameServerFunction` gives it; a request
* neither names is `unmatched`. Its status is the response's, 500 where the
* handler threw and the server answered, and 499 for a client gone before
* there was one. A request served in-process while an operation is current,
* such as the server function a page's loader calls, opens none of its own.
*
* `getRouter` is the app's own, called once now: every route the router
* registers is named here, so a pattern the core refuses throws at startup
* and never on a request.
*/
function timedStartHandler(timing, handler, getRouter, options = {}) {
	const base = options.serverFnBase ?? DEFAULT_SERVER_FN_BASE;
	const router = getRouter();
	const names = /* @__PURE__ */ new Map();
	const routes = Object.values(router.routesById);
	for (const route of routes) if (!route.isRoot) names.set(route.fullPath, OperationName.registered(route.fullPath));
	/**
	* The route the router matches for `pathname`, as Start's own handler asks
	* it. `**` among the params is Start's mark for a route that matched only a
	* prefix of the path, which renders the not-found page and runs no handler.
	*/
	const routeName = (pathname) => {
		const [, params, found] = router.getMatchedRoutes(pathname);
		const route = found;
		if (route === void 0 || params["**"] !== void 0) return OperationName.unmatched;
		return names.get(route.fullPath) ?? OperationName.unmatched;
	};
	const serve = (request, handlerOptions) => {
		const operation = timing.open();
		const { pathname } = new URL(request.url);
		let name;
		if (pathname.startsWith(base)) {
			const awaiting = {
				id: must(pathname.slice(base.length).split("/")[0]),
				name: void 0
			};
			awaitingName.set(operation, awaiting);
			name = () => awaiting.name ?? OperationName.unmatched;
		} else {
			const matched = routeName(pathname);
			name = () => matched;
		}
		const { end, produced } = endings(operation, request, name, isStreamed);
		return new Promise((resolve) => resolve(within(operation, () => handler(request, handlerOptions)))).then((response) => {
			produced(response);
			const streamed = isStreamed(response);
			const headers = new Headers(response.headers);
			if (!headers.has("content-type") || response.body === null) {
				end({
					status: response.status,
					aborted: false,
					streamed
				});
				return response;
			}
			const body = watched(response.body, (aborted) => end({
				status: response.status,
				aborted,
				streamed
			}));
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}, (error) => {
			end({
				status: 500,
				aborted: false,
				streamed: false
			});
			throw error;
		});
	};
	return (request, handlerOptions) => inOperation() ? handler(request, handlerOptions) : serve(request, handlerOptions);
}
/**
* The server half of a global function middleware, which names the operation
* of a server function called over HTTP: in `src/start.ts`,
* `functionMiddleware: [createMiddleware({ type: "function" }).server(nameServerFunction)]`,
* listed first.
*
* The name is the function's file and variable, `src/server/presets.ts:listPresets`,
* which Start's compiler records and which no build changes, where the id in
* the request's path is a hash a reader cannot read back. The id is used only
* to tell the call the request made from a call its handler makes in-process,
* which names nothing. A file whose path the core refuses, one with a space, `?` or `#`,
* throws on the function's every call.
*/
function nameServerFunction(call) {
	const operation = plainStorage.getStore();
	const awaiting = operation === void 0 ? void 0 : awaitingName.get(operation);
	if (awaiting?.name === void 0 && awaiting?.id === call.serverFnMeta.id) awaiting.name = OperationName.registered(`${call.serverFnMeta.filename}:${call.serverFnMeta.name}`);
	return call.next();
}
//#endregion
export { nameServerFunction, timedStartHandler };
