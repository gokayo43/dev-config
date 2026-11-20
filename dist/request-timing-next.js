import { r as timedEntry } from "./request-timing-entry-DUtRZjoK.js";
import { t as marked } from "./request-timing-route-DobjtQAK.js";
import { i as OperationName } from "./request-timing-CRXpA8f5.js";
// request-timing-next.ts
/**
* Request timing's Next.js connector: a wrapper an app puts around each
* handler a `route.ts` exports, which runs every request the handler serves as
* one operation named by the route's pattern. `docs/exports/request-timing.md`
* says how an app mounts it, what its records hold, and why the app states the
* pattern itself.
*/
/**
* Whether a body Next.js sends was sent over time. Next.js sends every body
* chunked, so only the chunks it hands over say: a buffered body is one chunk
* and then its end, and a body that was not finished on the read after its
* first chunk, or was still being read when it stopped, streamed. What a
* source waits on as it is pulled counts in the operation, since it runs in
* the context it was made in, the handler's (measured on Bun 1.4.4 and Node
* 24: a stream's `pull` sees the store its constructor ran under, not its
* reader's).
*/
const streamed = ({ finished, chunks }) => finished ? chunks > 1 : chunks > 0;
/**
* The wrapper, for `timing`. An app makes it once and wraps each handler a
* `route.ts` exports with it, naming the route's pattern as its place under
* `app/` gives it, route groups left out:
*
* ```ts
* export const GET = timedRoute("/api/presets/[id]", async (request, { params }) => ...);
* ```
*
* A request the handler serves is one operation, from the call to the end of
* its response: once the server has taken the last chunk of the body, or at
* once where there is no body to take (no body at all, or a HEAD). Its status
* is the response's; a handler that throws is recorded with the 500 Next.js
* answers; a client that leaves closes it then, `aborted`, with the status the
* handler had produced or 499. A request served while an operation is current
* opens none of its own. The pattern is refused, by throwing, when the module
* that wraps the handler is loaded, which `next build` does for every route.
*/
function requestTimingRoute(timing) {
	return (pattern, handler) => {
		const name = OperationName.registered(pattern);
		const timed = (request, context) => timedEntry(timing, request, () => handler(request, context), () => () => name, (response) => response.body === null || request.method === "HEAD" ? { close: {
			status: response.status,
			aborted: false,
			streamed: false
		} } : {
			watch: response.body,
			streamed
		});
		return marked(timed, {
			kind: "route",
			pattern
		});
	};
}
export { requestTimingRoute };
