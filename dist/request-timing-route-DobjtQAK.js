// request-timing-route.ts
/**
* The mark an entry connector leaves on a route handler it wrapped, and the
* one way the conformance kit's route-tree check reads it back. No export
* names this file; the Next.js and tRPC connectors' builds share it as a chunk,
* and the kit, which ships as source, imports it as source.
*
* The mark is a property under a registered symbol, never a module's own
* WeakMap: the app's route modules hold the built connector, while the kit
* that reads them runs this file's source, so the two are different module
* instances that agree only on `Symbol.for`'s key.
*/
const MARK = Symbol.for("@gokayo43/dev-config/request-timing/route");
/** `handler`, marked as `mark` says. */
function marked(handler, mark) {
	Object.defineProperty(handler, MARK, { value: mark });
	return handler;
}
export { marked as t };
