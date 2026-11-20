import { must } from "./narrowing.js";
import { n as registeredNames, r as timedEntry } from "./request-timing-entry-DUtRZjoK.js";
import { c as current, i as OperationName } from "./request-timing-CRXpA8f5.js";
// request-timing-tanstack-start.ts
/**
* Every open operation of a server-function request, by the operation. The
* function middleware reaches it through `AsyncLocalStorage`, so both halves
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
const isStreamed = (headers) => headers.get("transfer-encoding") === "chunked" || /^(?:text\/event-stream|application\/x-tss-framed)\b/u.test(headers.get("content-type") ?? "");
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
	if (!base.startsWith("/") || !base.endsWith("/")) throw new Error(`request timing: serverFnBase is the path server functions are called on, beginning and ending with "/", such as "/_serverFn/"; it was given as ${JSON.stringify(base)}`);
	const router = getRouter();
	const nameOf = registeredNames();
	const routes = Object.values(router.routesById);
	for (const route of routes) if (!route.isRoot) nameOf(route.fullPath);
	/**
	* The route the router matches for `pathname`, as Start's own handler asks
	* it. `**` among the params is Start's mark for a route that matched only a
	* prefix of the path, which renders the not-found page and runs no handler,
	* and the root route answers no path of its own: it is found only for a path
	* no route matched.
	*/
	const routeName = (pathname) => {
		const [, params, found] = router.getMatchedRoutes(pathname);
		const route = found;
		if (route === void 0 || route.isRoot || params["**"] !== void 0) return OperationName.unmatched;
		return nameOf(route.fullPath);
	};
	/** How the operation serving a request to `pathname` is named, once it is open. */
	const naming = (pathname) => (operation) => {
		if (!pathname.startsWith(base)) return () => routeName(pathname);
		const awaiting = {
			id: must(pathname.slice(base.length).split("/")[0]),
			meta: void 0
		};
		awaitingName.set(operation, awaiting);
		return () => awaiting.meta === void 0 ? OperationName.unmatched : nameOf(`${awaiting.meta.filename}:${awaiting.meta.name}`);
	};
	return (request, handlerOptions) => timedEntry(timing, request, () => handler(request, handlerOptions), naming(new URL(request.url).pathname), (response, headers) => {
		const streamed = isStreamed(headers);
		return !headers.has("content-type") || response.body === null ? { close: {
			status: response.status,
			aborted: false,
			streamed
		} } : {
			watch: response.body,
			streamed: () => streamed
		};
	});
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
* which names nothing. A name the core refuses, from a file path with a space,
* `?` or `#`, or longer than it takes, goes to the app's `fault` when the
* operation closes, and the call writes no record.
*/
function nameServerFunction(call) {
	const operation = current.getStore();
	const awaiting = operation === void 0 ? void 0 : awaitingName.get(operation);
	if (awaiting?.meta === void 0 && awaiting?.id === call.serverFnMeta.id) awaiting.meta = call.serverFnMeta;
	return call.next();
}
export { nameServerFunction, timedStartHandler };
