import { a as methodOf, i as beginWait, n as RECORD_VERSION, o as plainStorage, r as WAIT_KINDS, s as requestTiming, t as OperationName } from "./request-timing-operation-DfYtKiLO.js";
//#region request-timing.ts
/**
* Request timing for a plain async program: which operation a wait belongs to,
* carried in `AsyncLocalStorage`. `docs/exports/request-timing.md` is how an
* app adopts it; `request-timing-effect.ts` is the carrier for an Effect
* program, which reads this one's storage only in `carryOperation`.
*/
/**
* Whether an operation is current. An entry connector asks it before opening
* one and opens nothing when it answers true, so work a page runs in-process
* during its own request, such as a server function it calls, counts in the
* page's operation and operations never nest.
*/
function inOperation() {
	return plainStorage.getStore() !== void 0;
}
/**
* Runs `handler` with `operation` as the current one, and answers what it
* answers, unchanged. Every `measure` called from it, or from anything it
* starts that keeps its async context, counts in `operation`.
*/
function within(operation, handler) {
	return plainStorage.run(operation, handler);
}
/**
* Runs `wait` and adds its duration to the current operation under `kind`, or
* to nothing when no operation is current. The operation is read when
* `measure` is called, so a wait belongs to the operation that issued it
* whoever settles it. The answer settles as `wait`'s promise does, with its
* value or its rejection, and a synchronous throw is thrown on. `wait` is
* called once, and a thenable it answers has its `then` called once.
*/
function measure(kind, wait) {
	const operation = plainStorage.getStore();
	if (operation === void 0) return Promise.resolve(wait());
	const end = beginWait(operation, kind);
	let pending;
	try {
		pending = wait();
	} catch (error) {
		end();
		throw error;
	}
	return Promise.resolve(pending).then((value) => {
		end();
		return value;
	}, (error) => {
		end();
		throw error;
	});
}
//#endregion
export { OperationName, RECORD_VERSION, WAIT_KINDS, inOperation, measure, methodOf, requestTiming, within };
