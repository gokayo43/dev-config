import { nth } from "./narrowing.js";
import { d as requestTiming, i as OperationName, n as measure, r as within, u as perKind } from "./request-timing-CRXpA8f5.js";
// request-timing-effect-driver.ts
/** The modules of `effect` the driver runs on, every one of which Effect 4 has and Effect 3 lacks at least one of. */
const MODULES = [
	"Context",
	"Deferred",
	"Effect",
	"Exit",
	"Fiber",
	"Layer",
	"ManagedRuntime",
	"Pool",
	"PubSub",
	"Queue",
	"Scope",
	"Semaphore",
	"Stream"
];
const nameOf = (index) => OperationName.registered(`/participant/${index}`);
const byOperation = (a, b) => a.operation.localeCompare(b.operation);
/** What each operation's record must count: the waits its own script issued, and nothing else. */
function expected(plan) {
	return plan.participants.flatMap((participant, index) => {
		if (!participant.operation) return [];
		const counts = perKind(() => 0);
		for (const step of participant.steps) if (step.do === "await") counts[step.afterwards] += 1;
		else if (step.do !== "signal") counts[step.kind] += 1;
		return [{
			operation: nameOf(index).pattern,
			...counts
		}];
	}).toSorted(byOperation);
}
/** What the records count, in `expected`'s shape. */
function counted(records) {
	return records.map((made) => ({
		operation: made.operation,
		...perKind((kind) => made[kind].count)
	})).toSorted(byOperation);
}
const turn = async (count) => {
	for (let index = 0; index < count; index += 1) await Promise.resolve();
};
/** A query that starts when its `then` is called, as every drizzle query does. */
var Lazy = class {
	#run;
	constructor(run) {
		this.#run = run;
	}
	then(fulfilled, rejected) {
		return this.#run().then(fulfilled, rejected);
	}
};
/**
* Runs every participant of `plan` at once, each operation opened through the
* real core and run under its `within`, and answers the records they closed
* into. The semaphore and the pool are built in the layer of a
* `ManagedRuntime` made before any operation is open, and every handoff
* before any participant starts, so none of them carries an operation of its
* own; `entry` says whether a participant's program runs on that runtime or
* through `Effect.runPromise` with its services provided.
*/
async function runPlan(effect, plan, entry) {
	const { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Pool, PubSub } = effect;
	const { Queue, Scope, Semaphore, Stream } = effect;
	const records = [];
	const timing = requestTiming({
		sink: (made) => void records.push(made),
		fault: (error) => {
			throw error;
		},
		now: () => 0
	});
	const Shared = Context.Service("@gokayo43/dev-config/request-timing/conformance/effect/Shared");
	const runtime = ManagedRuntime.make(Layer.effect(Shared, Effect.all({
		lock: Semaphore.make(1),
		pool: Pool.make({
			acquire: Effect.void,
			size: 1
		})
	})));
	const scope = Effect.runSync(Scope.make());
	const passage = (via) => {
		switch (via) {
			case "deferred": return Effect.map(Deferred.make(), (deferred) => ({
				give: Effect.asVoid(Deferred.succeed(deferred, void 0)),
				take: (then) => Effect.andThen(Deferred.await(deferred), then)
			}));
			case "queue": return Effect.map(Queue.unbounded(), (queue) => ({
				give: Effect.asVoid(Queue.offer(queue, void 0)),
				take: (then) => Effect.andThen(Queue.take(queue), then)
			}));
			case "pubsub": return Effect.flatMap(PubSub.unbounded(), (pubsub) => Effect.map(PubSub.subscribe(pubsub), (subscription) => ({
				give: Effect.asVoid(PubSub.publish(pubsub, void 0)),
				take: (then) => Effect.andThen(PubSub.take(subscription), then)
			})));
			case "stream": return Effect.map(Queue.unbounded(), (queue) => ({
				give: Effect.asVoid(Queue.offer(queue, void 0)),
				take: (then) => Stream.runForEach(Stream.take(Stream.fromQueue(queue), 1), () => then)
			}));
			case "interrupt": return Effect.sync(() => {
				let target;
				let given = false;
				return {
					give: Effect.suspend(() => {
						given = true;
						return target === void 0 ? Effect.void : Fiber.interrupt(target);
					}),
					take: (then) => Effect.gen(function* () {
						const waiting = yield* Deferred.make();
						const child = yield* Effect.forkChild(Effect.onInterrupt(Effect.andThen(Deferred.succeed(waiting, void 0), Effect.never), () => then));
						yield* Deferred.await(waiting);
						target = child;
						if (given) yield* Fiber.interrupt(child);
						yield* Fiber.await(child);
					})
				};
			});
		}
	};
	const wait = (kind, turns, lazy) => lazy ? Effect.orDie(Effect.tryPromise(() => new Lazy(() => measure(kind, () => turn(turns))))) : Effect.promise(async () => {
		await turn(1);
		await measure(kind, () => turn(turns));
	});
	try {
		const passages = await Effect.runPromise(Scope.provide(Effect.forEach(plan.handoffs, passage), scope));
		const context = await runtime.context();
		const step = (taken) => {
			switch (taken.do) {
				case "wait": return wait(taken.kind, taken.turns, taken.lazy);
				case "locked": return Effect.flatMap(Effect.service(Shared), ({ lock }) => Semaphore.withPermits(lock, 1, wait(taken.kind, taken.turns, taken.lazy)));
				case "pooled": return Effect.flatMap(Effect.service(Shared), ({ pool }) => Effect.scoped(Effect.andThen(Pool.get(pool), wait(taken.kind, taken.turns, taken.lazy))));
				case "detached": return Effect.gen(function* () {
					const done = yield* Deferred.make();
					yield* Effect.forkDetach(Effect.ensuring(wait(taken.kind, taken.turns, taken.lazy), Deferred.succeed(done, void 0)));
					yield* Deferred.await(done);
				});
				case "await": return nth(passages, taken.signal).take(wait(taken.afterwards, 0, false));
				case "signal": return nth(passages, taken.signal).give;
			}
		};
		const run = (program) => entry === "managedRuntime" ? runtime.runPromise(program) : Effect.runPromise(Effect.provideContext(program, context));
		await Promise.all(plan.participants.map(async (participant, index) => {
			const program = Effect.andThen(Effect.forEach(Array.from({ length: participant.startAfter }), () => Effect.yieldNow, { discard: true }), Effect.forEach(participant.steps, step, { discard: true }));
			if (!participant.operation) return run(program);
			const operation = timing.open();
			await within(operation, () => run(program));
			operation.close({
				method: "GET",
				name: nameOf(index),
				status: 200,
				aborted: false,
				streamed: false
			});
		}));
	} finally {
		await runtime.dispose();
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}
	return records;
}
// request-timing-conformance-effect.ts
/** Waits that pass through each of Effect's shared resources the driver has, run by the check under both entries. */
const TABLE = [
	...[["locked", "a shared semaphore"], ["pooled", "a shared pool"]].map(([held, through]) => ({
		through,
		plan: {
			participants: [{
				operation: false,
				startAfter: 0,
				steps: [{
					do: held,
					kind: "store",
					turns: 3,
					lazy: false
				}]
			}, ...[
				0,
				1,
				2
			].map((startAfter) => ({
				operation: true,
				startAfter,
				steps: [{
					do: held,
					kind: "db",
					turns: 2,
					lazy: true
				}, {
					do: held,
					kind: "out",
					turns: 1,
					lazy: false
				}]
			}))],
			handoffs: []
		}
	})),
	...[
		"deferred",
		"queue",
		"pubsub",
		"stream"
	].map((via) => ({
		through: `a shared ${via}`,
		plan: {
			participants: [
				{
					operation: true,
					startAfter: 0,
					steps: [{
						do: "wait",
						kind: "db",
						turns: 2,
						lazy: false
					}, {
						do: "signal",
						signal: 0
					}]
				},
				{
					operation: true,
					startAfter: 0,
					steps: [
						{
							do: "await",
							signal: 0,
							afterwards: "db"
						},
						{
							do: "signal",
							signal: 1
						},
						{
							do: "wait",
							kind: "store",
							turns: 1,
							lazy: true
						}
					]
				},
				{
					operation: false,
					startAfter: 0,
					steps: [{
						do: "await",
						signal: 1,
						afterwards: "out"
					}]
				}
			],
			handoffs: [via, via]
		}
	})),
	{
		through: "an interrupt whose finalizer waits",
		plan: {
			participants: [{
				operation: true,
				startAfter: 2,
				steps: [
					{
						do: "wait",
						kind: "out",
						turns: 1,
						lazy: false
					},
					{
						do: "signal",
						signal: 0
					},
					{
						do: "wait",
						kind: "db",
						turns: 1,
						lazy: true
					}
				]
			}, {
				operation: true,
				startAfter: 0,
				steps: [{
					do: "await",
					signal: 0,
					afterwards: "store"
				}]
			}],
			handoffs: ["interrupt"]
		}
	},
	{
		through: "a detached fiber",
		plan: {
			participants: [0, 1].map((startAfter) => ({
				operation: true,
				startAfter,
				steps: [{
					do: "detached",
					kind: "db",
					turns: 2,
					lazy: true
				}, {
					do: "detached",
					kind: "out",
					turns: 1,
					lazy: false
				}]
			})),
			handoffs: []
		}
	}
];
const NEEDS = "request timing needs effect 4.0.1 or later, on a host whose process.getBuiltinModule finds node:async_hooks: Bun, or Node 20.16 or later and not 22.0 to 22.2";
/**
* Rejects unless every wait of the table's Effect programs is counted in the
* record of the operation that issued it and in no other, run on `effect`
* through `Effect.runPromise` and through a `ManagedRuntime` alike. The
* table passes waits through a shared semaphore, pool, Deferred, queue, PubSub
* and stream, an interrupt whose finalizer waits, a detached fiber, and lazy
* thenables under `Effect.tryPromise`, beside work outside any operation.
*/
async function requestTimingEffectConforms(effect) {
	const missing = MODULES.filter((name) => !(name in effect));
	if (missing.length > 0) throw new Error(`request timing's Effect check was handed an effect with no ${missing.join(", ")}, so it is older than Effect 4: ${NEEDS}.`);
	const wrong = [];
	for (const entry of ["runPromise", "managedRuntime"]) for (const { through, plan } of TABLE) {
		const want = expected(plan);
		const got = counted(await runPlan(effect, plan, entry));
		if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`through ${through}, run by ${entry}: expected ${JSON.stringify(want)}, counted ${JSON.stringify(got)}`);
	}
	if (wrong.length > 0) throw new Error(`Effect resumed a fiber in another request's context, so a wait was counted in the wrong record or in none; ${NEEDS}.\n${wrong.join("\n")}`);
}
export { requestTimingEffectConforms };
