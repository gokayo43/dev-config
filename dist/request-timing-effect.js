import { i as beginWait, o as plainStorage } from "./request-timing-operation-Dti3zFz_.js";
import { Effect, FiberRef } from "effect";
//#region request-timing-effect.ts
/**
* Request timing for an Effect program: which operation a wait belongs to,
* carried in the fiber. Never in `AsyncLocalStorage`: a fiber that waits on a
* shared semaphore, Deferred or queue resumes on the stack of the fiber that
* released it and inherits that fiber's store (measured on Bun 1.4.4 with
* effect 3.22.1: 38 of 40 queries attributed to the wrong request). The one
* place it reads that storage is `carryOperation`, synchronously, in the
* caller's context, before any fiber runs.
* `docs/exports/request-timing.md` is how an app adopts it.
*/
/**
* A fiber forked under an operation inherits it. A joined child never hands
* its operation back to the parent, whatever it ran under.
*/
const current = FiberRef.unsafeMake(void 0, { join: (parent) => parent });
/**
* Runs `handler` with `operation` as the current one, and answers what it
* answers, unchanged. Every `measure` in it, and in every fiber it forks,
* counts in `operation`.
*/
const within = (operation, handler) => Effect.locally(handler, current, operation);
/**
* Runs `wait` and adds its duration to the current fiber's operation under
* `kind`, or answers `wait` itself when the fiber has none. The wait ends when
* `wait` exits: with a value, a failure, a defect or an interruption.
*/
const measure = (kind, wait) => FiberRef.getWith(current, (operation) => {
	if (operation === void 0) return wait;
	return Effect.suspend(() => {
		const end = beginWait(operation, kind);
		return Effect.ensuring(wait, Effect.sync(() => end()));
	});
});
/**
* Whether the fiber has an operation: the Effect carrier's half of the
* no-nesting rule an entry connector holds to, as the plain `inOperation` is.
*/
const inOperation = FiberRef.getWith(current, (operation) => Effect.succeed(operation !== void 0));
/**
* The crossing from a plain handler into an Effect program: `program` with the
* plain carrier's current operation, read now, carried in its fiber, or
* `program` itself when none is current. Call it where the handler hands the
* program to its runtime, `runtime.runPromise(carryOperation(program))`, since
* `AsyncLocalStorage` holds the right operation only up to that call; a
* program carried once and run again later keeps the operation it was carried
* with.
*/
function carryOperation(program) {
	const operation = plainStorage.getStore();
	return operation === void 0 ? program : within(operation, program);
}
//#endregion
export { carryOperation, inOperation, measure, within };
