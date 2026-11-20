/**
 * `send` with every call measured as one wait, from the call until the promise
 * it answers settles, which is when the response's headers have arrived or the
 * call has failed. Reading the body is not part of the wait. The answer is
 * `send`'s own promise, and `preconnect` is `send`'s. An app uses the answer in
 * place of the global, or installs it as the global, handing it the global it
 * replaces: `globalThis.fetch = timedFetch(globalThis.fetch)`.
 */
export declare function timedFetch(send: typeof fetch): typeof fetch;