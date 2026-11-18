//#region request-timing-entry.ts
/**
* What every entry connector is built from: a response body passed through to
* the client unchanged, watched for the moment it has finished. No export
* names this file; the connectors' builds share it as a chunk.
*/
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
export { watched as t };
