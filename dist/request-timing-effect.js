import { i as beginWait, o as plainStorage } from "./request-timing-operation-gsGVMm95.js";
import { Effect, FiberRef } from "effect";
//#region request-timing-effect.ts
/**
* Request timing for an Effect program: which operation a wait belongs to,
* carried in the fiber. Never in `AsyncLocalStorage`: a fiber that waits on a
* shared semaphore, Deferred or queue resumes on the stack of the fiber that
* released it and inherits that fiber's store (measured on Bun 1.4.4 with
* effect 3.22.1: 38 of 40 queries attributed to the wrong request). It
* touches that storage at the two crossings alone: `carryOperation` reads it,
* synchronously, in the caller's context, before any fiber runs, and
* `tryPromiseCarried` sets it from the fiber, or clears it, while it calls a
* thunk and starts what the thunk answers.
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
/**
* Calls `evaluate` and starts what it answers, both inside the scope. A lazy
* thenable, such as a drizzle query, runs only once its `then` is called, and
* `Effect.tryPromise` calls `then` after this function has returned, outside
* any scope, so `then` is called here, once and synchronously, as
* `Effect.tryPromise` would call it. A throw from `evaluate` leaves the scope
* and reaches `Effect.tryPromise` as it would have; a throw from `then` rejects
* the promise, which `Effect.tryPromise` fails with alike.
*/
const started = (evaluate, signal) => {
	const answered = evaluate(signal);
	return new Promise((resolve, reject) => {
		answered.then(resolve, reject);
	});
};
/** Runs and starts `evaluate` under the plain carrier with `operation`, or under none at all. */
const carriedOut = (operation, evaluate) => (signal) => operation === void 0 ? plainStorage.exit(() => started(evaluate, signal)) : plainStorage.run(operation, () => started(evaluate, signal));
function tryPromiseCarried(given) {
	return FiberRef.getWith(current, (operation) => {
		const evaluate = typeof given === "function" ? given : given.try;
		const carried = carriedOut(operation, evaluate);
		return typeof given === "function" ? Effect.tryPromise(carried) : Effect.tryPromise({
			try: carried,
			catch: given.catch
		});
	});
}
//#endregion
export { carryOperation, inOperation, measure, tryPromiseCarried, within };
