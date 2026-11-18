import { t as OperationName } from "./request-timing-operation-gsGVMm95.js";
import { inOperation, within } from "./request-timing.js";
import { t as endings } from "./request-timing-entry-Dp_bovEo.js";
import { t as marked } from "./request-timing-route-BhLXYn3w.js";
//#region request-timing-next.ts
/**
* Request timing's Next.js connector: a wrapper an app puts around each
* handler a `route.ts` exports, which runs every request the handler serves as
* one operation named by the route's pattern. `docs/exports/request-timing.md`
* says how an app mounts it, what its records hold, and why the app states the
* pattern itself.
*/
/**
* `body`, passed through chunk for chunk, with `ended` called once the last
* chunk has been taken, the source has failed, or the client has cancelled.
* Not `request-timing-entry.ts`'s `watched`, since Next.js sends every body
* chunked and only the chunks the body hands over say whether it streamed.
* The source still runs in the context it was made in, the handler's, so what
* it waits on as it is pulled counts in the operation (measured on Bun 1.4.4
* and Node 24: a stream's `pull` sees the store its constructor ran under, not
* its reader's). A high-water mark of nothing reads no chunk ahead of
* the server, so the source is pulled exactly as it was without the wrapper.
*
* A body counts as streamed once it has handed over a chunk and was then not
* finished on the next read: a buffered body is one chunk and then its end.
* `delivered` counts the chunks handed over, for the client's abort to read.
*/
function counted(body, delivered, ended) {
	const reader = body.getReader();
	return new ReadableStream({
		pull: (controller) => reader.read().then((chunk) => {
			if (chunk.done) {
				controller.close();
				ended({
					aborted: false,
					streamed: delivered.chunks > 1
				});
				return;
			}
			delivered.chunks += 1;
			controller.enqueue(chunk.value);
		}, (error) => {
			ended({
				aborted: false,
				streamed: delivered.chunks > 0
			});
			controller.error(error);
		}),
		cancel: (reason) => {
			ended({
				aborted: true,
				streamed: delivered.chunks > 0
			});
			return reader.cancel(reason);
		}
	}, { highWaterMark: 0 });
}
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
		const timed = (request, context) => {
			if (inOperation()) return Promise.resolve(handler(request, context));
			const operation = timing.open();
			const delivered = { chunks: 0 };
			const { end, produced } = endings(operation, request, () => name, () => delivered.chunks > 0);
			return new Promise((resolve) => resolve(within(operation, () => handler(request, context)))).then((response) => {
				produced(response);
				if (response.body === null || request.method === "HEAD") {
					end({
						status: response.status,
						aborted: false,
						streamed: false
					});
					return response;
				}
				const body = counted(response.body, delivered, (how) => end({
					status: response.status,
					...how
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
		return marked(timed, {
			kind: "route",
			pattern
		});
	};
}
//#endregion
export { requestTimingRoute };
