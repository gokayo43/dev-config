import { a as methodOf } from "./request-timing-operation-DfYtKiLO.js";
import "./request-timing.js";
//#region request-timing-entry.ts
/**
* The endings of `operation`, which serves `request`: `end` is called on every
* ending a connector sees, and the first to arrive closes the operation, named
* by `named` then. The client's abort is one, with `aborted: true` and the
* status of the response `produced` was last handed, or 499 where there was
* none. A sink that throws rejects out of band of the response it measured,
* which the client has already been answered with.
*/
function endings(operation, request, named, isStreamed) {
	const { promise: ending, resolve: end } = Promise.withResolvers();
	ending.then((ended) => {
		operation.close({
			method: methodOf(request.method),
			name: named(),
			...ended
		});
	});
	let last;
	request.signal.addEventListener("abort", () => end({
		status: last?.status ?? 499,
		aborted: true,
		streamed: last !== void 0 && isStreamed(last)
	}), { once: true });
	return {
		end,
		/** Hands over the response the handler produced, whose status an abort after it records. */
		produced: (response) => {
			last = response;
		}
	};
}
/**
* `body`, passed through chunk for chunk, calling `ended` once the last chunk
* has been taken or the client has cancelled it, with `true` for a cancel. A
* high-water mark of nothing reads no chunk ahead of the client, so the source
* is pulled exactly as it was before the connector stood in front of it. A
* source that fails midway has finished too, with `false`, and fails the copy
* with its own error, so the client sees the failure it saw before.
*/
function watched(body, ended) {
	const reader = body.getReader();
	return new ReadableStream({
		pull: (controller) => reader.read().then((chunk) => {
			if (!chunk.done) return controller.enqueue(chunk.value);
			controller.close();
			return ended(false);
		}, (error) => {
			ended(false);
			throw error;
		}),
		cancel: (reason) => {
			ended(true);
			return reader.cancel(reason);
		}
	}, { highWaterMark: 0 });
}
//#endregion
export { watched as n, endings as t };
