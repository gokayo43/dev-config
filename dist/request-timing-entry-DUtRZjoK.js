import { i as OperationName, l as methodOf, r as within, t as inOperation } from "./request-timing-CRXpA8f5.js";
// request-timing-entry.ts
/**
* A router's patterns as names, each registered once, when it is first asked
* for, and remembered.
*/
function registeredNames() {
	const names = /* @__PURE__ */ new Map();
	return (pattern) => {
		const known = names.get(pattern);
		if (known !== void 0) return known;
		const name = OperationName.registered(pattern);
		names.set(pattern, name);
		return name;
	};
}
/**
* The endings of `operation`: the answer is called on every ending a
* connector sees, and the first closes the operation through `timing.finish`,
* which builds the name with `named` inside its guard. So a name or a status
* the core refuses, and a sink that throws, reach the app's `fault`, write no
* record, and never fail the response. The client's abort, read from `signal`,
* is an ending, `aborting`'s; a signal already aborted when the listener would
* be attached, as by a client gone while the framework was still reading the
* request, never fires again, so it ends the operation at once.
*/
function endings(timing, operation, method, named, signal, aborting) {
	let open = true;
	const end = (ended) => {
		if (!open) return;
		open = false;
		timing.finish(operation, () => ({
			method,
			name: named(),
			...ended
		}));
	};
	if (signal?.aborted === true) end(aborting());
	else signal?.addEventListener("abort", () => end(aborting()), { once: true });
	return end;
}
/**
* `body`, passed through chunk for chunk, calling `ended` once the last chunk
* has been taken, the source has failed, or the reader has cancelled, with how
* many chunks were taken; `chunks` reads that count while the body is read. A
* high-water mark of nothing reads no chunk ahead of the reader, so the source
* is pulled exactly as it was before the connector stood in front of it, and
* still in the context it was made in, the handler's. A source that fails
* fails the copy with its own error, so the client sees the failure it saw
* before.
*/
function watched(body, ended) {
	const reader = body.getReader();
	let chunks = 0;
	return {
		stream: new ReadableStream({
			pull: (controller) => reader.read().then((chunk) => {
				if (chunk.done) {
					controller.close();
					return ended({
						aborted: false,
						finished: true,
						chunks
					});
				}
				chunks += 1;
				return controller.enqueue(chunk.value);
			}, (error) => {
				ended({
					aborted: false,
					finished: false,
					chunks
				});
				throw error;
			}),
			cancel: (reason) => {
				ended({
					aborted: true,
					finished: false,
					chunks
				});
				return reader.cancel(reason);
			}
		}, { highWaterMark: 0 }),
		chunks: () => chunks
	};
}
/**
* Serves `request` with `handle` as one operation of `timing`, and answers
* what `handle` answered, its body watched where `answer` says so. Opens none
* where an operation is current: a request served in-process is part of it.
*
* `naming` is handed the operation once it is open and answers how it is
* named at the close. The operation closes once, on the first of: the
* response handed over or its body finished, as `answer` decides; the client's
* abort, with the status of a response being sent, or 499 where there was
* none; a handler that throws, with 500, which is Bun's answer to a fetch that
* throws, the error thrown on. `answer` is handed the response's headers
* copied before its body is read, since Bun drops a content type it derived
* from a buffered body, a typed Blob's or form data's, once that body is read
* as a stream; a watched body goes out with that copy.
*/
function timedEntry(timing, request, handle, naming, answer) {
	if (inOperation()) return Promise.resolve(handle());
	const operation = timing.open();
	let sending;
	const end = endings(timing, operation, methodOf(request.method), naming(operation), request.signal, () => ({
		status: sending?.status ?? 499,
		aborted: true,
		streamed: sending?.streamed() ?? false
	}));
	return new Promise((resolve) => resolve(within(operation, handle))).then((response) => {
		const headers = new Headers(response.headers);
		const how = answer(response, headers);
		if ("close" in how) {
			end(how.close);
			return response;
		}
		const { status, statusText } = response;
		const body = watched(how.watch, ({ aborted, finished, chunks }) => end({
			status,
			aborted,
			streamed: how.streamed({
				finished,
				chunks
			})
		}));
		sending = {
			status,
			streamed: () => how.streamed({
				finished: false,
				chunks: body.chunks()
			})
		};
		return new Response(body.stream, {
			status,
			statusText,
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
}
export { registeredNames as n, timedEntry as r, endings as t };
