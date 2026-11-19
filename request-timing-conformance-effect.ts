/**
 * The conformance kit's check of an app's own Effect: whether a wait an
 * Effect program makes is counted in the record of the operation that issued
 * it, and in no other, when the program passes through what Effect shares
 * between fibers. An adopting app that runs Effect calls it in its own suite,
 * handing it the `effect` module it has installed:
 *
 * ```ts
 * import * as effect from "effect";
 *
 * test("request timing counts an Effect program's waits", () => requestTimingEffectConforms(effect));
 * ```
 *
 * Request timing carries the operation in `AsyncLocalStorage` alone. That is
 * right inside an Effect program only because Effect, from 4.0.1, keeps the
 * async context a fiber suspended in and resumes the fiber in it, rather than
 * on the stack of whichever fiber woke it; it finds `AsyncResource` for that
 * through `process.getBuiltinModule("node:async_hooks")`, once, when its
 * module loads, and without it falls back to the waker's stack silently. Its
 * 4.0.1 changelog states this and no Effect page promises it, so the check
 * asks the app's own Effect, on the app's own runtime.
 *
 * `runPlan` is the driver the check runs its table through, and the one
 * `tests/request-timing-attribution.test.ts` runs generated plans through.
 * `effect` is imported as types only: the module is the app's, handed in.
 */
import type * as Fx from "effect";

import { nth } from "./narrowing.ts";
import {
  measure,
  OperationName,
  requestTiming,
  type TimingRecord,
  type WaitKind,
  within,
} from "./request-timing.ts";

/** The `effect` module an app has installed. */
export type EffectModule = typeof Fx;

/**
 * One step of a participant's script. A wait is one measured wait of `kind`
 * that takes `turns` turns of the microtask queue, made in plain code under
 * `Effect.promise`, after an await of its own, or, `lazy`, in the `then` of a
 * thenable handed to `Effect.tryPromise`, as a drizzle query is. It is made
 * as it is (`wait`), holding a shared one-permit semaphore (`locked`) or the
 * one item of a shared pool (`pooled`), or in a detached fiber the script
 * waits for (`detached`). `await` takes handoff `signal` and then makes one
 * wait of `afterwards`, and `signal` gives it.
 */
export type Step =
  | {
      readonly do: "wait" | "locked" | "pooled" | "detached";
      readonly kind: WaitKind;
      readonly turns: number;
      readonly lazy: boolean;
    }
  | { readonly do: "await"; readonly signal: number; readonly afterwards: WaitKind }
  | { readonly do: "signal"; readonly signal: number };

/**
 * What a handoff passes through. For `stream` the taker's wait is made inside
 * the stream's `runForEach`; for `interrupt` the taker's wait is the finalizer
 * of a fiber it forked, which the giver interrupts, or the taker does where
 * the giver came first.
 */
export type Handoff = "deferred" | "queue" | "pubsub" | "stream" | "interrupt";

/** An operation, or work outside any operation, and its script, begun after `startAfter` yields. */
export interface Participant {
  readonly operation: boolean;
  readonly startAfter: number;
  readonly steps: readonly Step[];
}

/**
 * Participants that run at once, and what each handoff passes through, by
 * signal number. Each signal is given once and taken once, by a participant
 * listed after the giver, so no cycle of waiting can form; a semaphore or a
 * pool item is held across one wait and nothing else.
 */
export interface Plan {
  readonly participants: readonly Participant[];
  readonly handoffs: readonly Handoff[];
}

/** How each participant's program is run: `Effect.runPromise`, or a `ManagedRuntime` built before any operation. */
export type Entry = "runPromise" | "managedRuntime";

/** What one operation's record counts, by kind. */
export interface Counted {
  readonly operation: string;
  readonly db: number;
  readonly out: number;
  readonly store: number;
}

const nameOf = (index: number) => OperationName.registered(`/participant/${index}`);

const byOperation = (a: Counted, b: Counted) => a.operation.localeCompare(b.operation);

/** What each operation's record must count: the waits its own script issued, and nothing else. */
export function expected(plan: Plan): Counted[] {
  return plan.participants
    .flatMap((participant, index) => {
      if (!participant.operation) return [];
      const counts = { db: 0, out: 0, store: 0 };
      for (const step of participant.steps) {
        if (step.do === "await") counts[step.afterwards] += 1;
        else if (step.do !== "signal") counts[step.kind] += 1;
      }
      return [{ operation: nameOf(index).pattern, ...counts }];
    })
    .toSorted(byOperation);
}

/** What the records count, in `expected`'s shape. */
export function counted(records: readonly TimingRecord[]): Counted[] {
  return records
    .map((made) => ({
      operation: made.operation,
      db: made.db.count,
      out: made.out.count,
      store: made.store.count,
    }))
    .toSorted(byOperation);
}

const turn = async (count: number) => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

/** A query that starts when its `then` is called, as every drizzle query does. */
class Lazy implements PromiseLike<void> {
  readonly #run: () => Promise<void>;

  constructor(run: () => Promise<void>) {
    this.#run = run;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- the subject: a drizzle query is a thenable that runs, and measures, when Effect.tryPromise calls its then
  then<Fulfilled = void, Rejected = never>(
    fulfilled?: ((value: void) => Fulfilled | PromiseLike<Fulfilled>) | null,
    rejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): PromiseLike<Fulfilled | Rejected> {
    return this.#run().then(fulfilled, rejected);
  }
}

/** What a handoff's giver runs, and what its taker runs before `then`, or around it. */
interface Passage {
  readonly give: Fx.Effect.Effect<void>;
  readonly take: (then: Fx.Effect.Effect<void>) => Fx.Effect.Effect<void>;
}

/**
 * Runs every participant of `plan` at once, each operation opened through the
 * real core and run under its `within`, and answers the records they closed
 * into. The semaphore and the pool are built in the layer of a
 * `ManagedRuntime` made before any operation is open, and every handoff
 * before any participant starts, so none of them carries an operation of its
 * own; `entry` says whether a participant's program runs on that runtime or
 * through `Effect.runPromise` with its services provided.
 */
export async function runPlan(
  effect: EffectModule,
  plan: Plan,
  entry: Entry,
): Promise<readonly TimingRecord[]> {
  const { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Pool, PubSub } = effect;
  const { Queue, Scope, Semaphore, Stream } = effect;
  const records: TimingRecord[] = [];
  const timing = requestTiming({
    sink: (made) => void records.push(made),
    fault: (error) => {
      throw error;
    },
    now: () => 0,
  });

  const Shared = Context.Service<{
    readonly lock: Fx.Semaphore.Semaphore;
    readonly pool: Fx.Pool.Pool<void>;
  }>("@gokayo43/dev-config/request-timing/conformance/effect/Shared");
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Shared,
      Effect.all({ lock: Semaphore.make(1), pool: Pool.make({ acquire: Effect.void, size: 1 }) }),
    ),
  );
  const scope = Effect.runSync(Scope.make());

  const passage = (via: Handoff): Fx.Effect.Effect<Passage, never, Fx.Scope.Scope> => {
    switch (via) {
      case "deferred":
        return Effect.map(Deferred.make<void>(), (deferred) => ({
          give: Effect.asVoid(Deferred.succeed(deferred, undefined)),
          take: (then) => Effect.andThen(Deferred.await(deferred), then),
        }));
      case "queue":
        return Effect.map(Queue.unbounded<void>(), (queue) => ({
          give: Effect.asVoid(Queue.offer(queue, undefined)),
          take: (then) => Effect.andThen(Queue.take(queue), then),
        }));
      case "pubsub":
        return Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          Effect.map(PubSub.subscribe(pubsub), (subscription) => ({
            give: Effect.asVoid(PubSub.publish(pubsub, undefined)),
            take: (then) => Effect.andThen(PubSub.take(subscription), then),
          })),
        );
      case "stream":
        return Effect.map(Queue.unbounded<void>(), (queue) => ({
          give: Effect.asVoid(Queue.offer(queue, undefined)),
          take: (then) => Stream.runForEach(Stream.take(Stream.fromQueue(queue), 1), () => then),
        }));
      case "interrupt":
        return Effect.sync(() => {
          let target: Fx.Fiber.Fiber<never> | undefined;
          let given = false;
          return {
            give: Effect.suspend(() => {
              given = true;
              return target === undefined ? Effect.void : Fiber.interrupt(target);
            }),
            take: (then) =>
              Effect.gen(function* () {
                // A fiber interrupted before it starts never runs its body, so
                // never installs the finalizer: the child is interrupted only
                // once it has said it is waiting.
                const waiting = yield* Deferred.make<void>();
                const child = yield* Effect.forkChild(
                  Effect.onInterrupt(
                    Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never),
                    () => then,
                  ),
                );
                yield* Deferred.await(waiting);
                target = child;
                if (given) yield* Fiber.interrupt(child);
                yield* Fiber.await(child);
              }),
          };
        });
    }
  };

  const wait = (kind: WaitKind, turns: number, lazy: boolean): Fx.Effect.Effect<void> =>
    lazy
      ? Effect.orDie(Effect.tryPromise(() => new Lazy(() => measure(kind, () => turn(turns)))))
      : Effect.promise(async () => {
          await turn(1);
          await measure(kind, () => turn(turns));
        });

  try {
    const passages = await Effect.runPromise(
      Scope.provide(Effect.forEach(plan.handoffs, passage), scope),
    );
    const context = await runtime.context();
    const step = (taken: Step): Fx.Effect.Effect<void, never, typeof Shared.Identifier> => {
      switch (taken.do) {
        case "wait":
          return wait(taken.kind, taken.turns, taken.lazy);
        case "locked":
          return Effect.flatMap(Effect.service(Shared), ({ lock }) =>
            Semaphore.withPermits(lock, 1, wait(taken.kind, taken.turns, taken.lazy)),
          );
        case "pooled":
          return Effect.flatMap(Effect.service(Shared), ({ pool }) =>
            Effect.scoped(
              Effect.andThen(Pool.get(pool), wait(taken.kind, taken.turns, taken.lazy)),
            ),
          );
        case "detached":
          return Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            yield* Effect.forkDetach(
              Effect.ensuring(
                wait(taken.kind, taken.turns, taken.lazy),
                Deferred.succeed(done, undefined),
              ),
            );
            yield* Deferred.await(done);
          });
        case "await":
          return nth(passages, taken.signal).take(wait(taken.afterwards, 0, false));
        case "signal":
          return nth(passages, taken.signal).give;
      }
    };
    const run = (program: Fx.Effect.Effect<void, never, typeof Shared.Identifier>) =>
      entry === "managedRuntime"
        ? runtime.runPromise(program)
        : Effect.runPromise(Effect.provideContext(program, context));

    await Promise.all(
      plan.participants.map(async (participant, index) => {
        const program = Effect.andThen(
          Effect.forEach(Array.from({ length: participant.startAfter }), () => Effect.yieldNow, {
            discard: true,
          }),
          Effect.forEach(participant.steps, step, { discard: true }),
        );
        if (!participant.operation) return run(program);
        const operation = timing.open();
        await within(operation, () => run(program));
        operation.close({
          method: "GET",
          name: nameOf(index),
          status: 200,
          aborted: false,
          streamed: false,
        });
      }),
    );
  } finally {
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  return records;
}

/** Waits that pass through each of Effect's shared resources, run by the check under both entries. */
const TABLE: readonly { readonly through: string; readonly plan: Plan }[] = [
  {
    through: "a shared semaphore",
    plan: {
      participants: [
        {
          operation: false,
          startAfter: 0,
          steps: [{ do: "locked", kind: "store", turns: 3, lazy: false }],
        },
        ...[0, 1, 2].map((startAfter) => ({
          operation: true,
          startAfter,
          steps: [
            { do: "locked", kind: "db", turns: 2, lazy: true },
            { do: "locked", kind: "out", turns: 1, lazy: false },
          ] satisfies Step[],
        })),
      ],
      handoffs: [],
    },
  },
  ...(["deferred", "queue"] as const).map((via) => ({
    through: `a shared ${via}`,
    plan: {
      participants: [
        {
          operation: true,
          startAfter: 0,
          steps: [
            { do: "wait", kind: "db", turns: 2, lazy: false },
            { do: "signal", signal: 0 },
          ] satisfies Step[],
        },
        {
          operation: true,
          startAfter: 0,
          steps: [
            { do: "await", signal: 0, afterwards: "db" },
            { do: "signal", signal: 1 },
            { do: "wait", kind: "store", turns: 1, lazy: true },
          ] satisfies Step[],
        },
        {
          operation: false,
          startAfter: 0,
          steps: [{ do: "await", signal: 1, afterwards: "out" }] satisfies Step[],
        },
      ],
      handoffs: [via, via],
    },
  })),
  {
    through: "an interrupt whose finalizer waits",
    plan: {
      participants: [
        {
          operation: true,
          startAfter: 2,
          steps: [
            { do: "wait", kind: "out", turns: 1, lazy: false },
            { do: "signal", signal: 0 },
            { do: "wait", kind: "db", turns: 1, lazy: true },
          ],
        },
        {
          operation: true,
          startAfter: 0,
          steps: [{ do: "await", signal: 0, afterwards: "store" }],
        },
      ],
      handoffs: ["interrupt"],
    },
  },
  {
    through: "a detached fiber",
    plan: {
      participants: [0, 1].map((startAfter) => ({
        operation: true,
        startAfter,
        steps: [
          { do: "detached", kind: "db", turns: 2, lazy: true },
          { do: "detached", kind: "out", turns: 1, lazy: false },
        ] satisfies Step[],
      })),
      handoffs: [],
    },
  },
];

/** The modules `runPlan` takes from the app's `effect`, every one of which Effect 4 has. */
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
  "Stream",
] as const;

const NEEDS =
  "request timing needs effect 4.0.1 or later, on a host whose process.getBuiltinModule finds node:async_hooks: Bun, or Node 20.16 or later and not 22.0 to 22.2";

/**
 * Rejects unless every wait of the table's Effect programs is counted in the
 * record of the operation that issued it and in no other, run on `effect`
 * through `Effect.runPromise` and through a `ManagedRuntime` alike. The
 * table passes waits through a shared semaphore, Deferred and queue, an
 * interrupt whose finalizer waits, a detached fiber, and lazy thenables under
 * `Effect.tryPromise`, beside work outside any operation.
 */
export async function requestTimingEffectConforms(effect: EffectModule): Promise<void> {
  const missing = MODULES.filter((name) => !(name in effect));
  if (missing.length > 0) {
    throw new Error(
      `request timing's Effect check was handed an effect with no ${missing.join(", ")}, so it is older than Effect 4: ${NEEDS}.`,
    );
  }
  const wrong: string[] = [];
  for (const entry of ["runPromise", "managedRuntime"] as const) {
    for (const { through, plan } of TABLE) {
      const want = expected(plan);
      const got = counted(await runPlan(effect, plan, entry));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        wrong.push(
          `through ${through}, run by ${entry}: expected ${JSON.stringify(want)}, counted ${JSON.stringify(got)}`,
        );
      }
    }
  }
  if (wrong.length > 0) {
    throw new Error(
      `Effect resumed a fiber in another request's context, so a wait was counted in the wrong record or in none; ${NEEDS}.\n${wrong.join("\n")}`,
    );
  }
}
