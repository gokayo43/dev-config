import { n as waitOn } from "./request-timing-wait-Cj7WA-Qu.js";
// request-timing-fetch.ts
/**
* Request timing's `fetch` connector: every call, one `out` wait of the
* operation that made it. `docs/exports/request-timing.md` says what an app
* mounts and what a count includes.
*/
/**
* `send` with every call measured as one wait, from the call until the promise
* it answers settles, which is when the response's headers have arrived or the
* call has failed. Reading the body is not part of the wait. The answer is
* `send`'s own promise, and `preconnect` is `send`'s. An app uses the answer in
* place of the global, or installs it as the global, handing it the global it
* replaces: `globalThis.fetch = timedFetch(globalThis.fetch)`.
*/
function timedFetch(send) {
	return Object.assign((...args) => waitOn("out", () => send(...args)), { preconnect: send.preconnect });
}
export { timedFetch };
