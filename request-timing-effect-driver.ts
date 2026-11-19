/**
 * The driver request timing's Effect check runs its table through, and the
 * one `tests/request-timing-attribution.test.ts` runs generated plans
 * through: overlapping operations, opened through the real core, whose Effect
 * programs pass waits through what Effect shares between fibers. No export
 * names this file; the build takes it into the check. `effect` is imported as
 * types only: the module is the app's, handed in.
 */
import type * as Fx from "effect";

import { nth } from "./narrowing.ts";
import { type PerKind, perKind } from "./request-timing-operation.ts";
import {
  measure,
  OperationName,
  requestTiming,
  type TimingRecord,
  type WaitKind,
  within,
} from "./request-timing.ts";

/** The modules of `effect` the driver runs on, every one of which Effect 4 has and Effect 3 lacks at least one of. */
export const MODULES = [
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

/** Those modules of the `effect` an app has installed. */
export type EffectModules = Pick<typeof Fx, (typeof MODULES)[number]>;

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
export type Counted = { readonly operation: string } & Readonly<PerKind<number>>;

const nameOf = (index: number) => OperationName.registered(`/participant/${index}`);

const byOperation = (a: Counted, b: Counted) => a.operation.localeCompare(b.operation);

/** What each operation's record must count: the waits its own script issued, and nothing else. */
export function expected(plan: Plan): Counted[] {
  return plan.participants
    .flatMap((participant, index) => {
      if (!participant.operation) return [];
      const counts = perKind(() => 0);
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
    .map((made) => ({ operation: made.operation, ...perKind((kind) => made[kind].count) }))
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
  effect: EffectModules,
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
