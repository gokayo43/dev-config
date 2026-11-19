/**
 * Whether this process's `effect` is the runtime `interleaving.ts` was written
 * against. Importing it throws on any Effect but 4, and `verifyRuntime` runs
 * small programs, each on Effect alone, that check every fact about Effect's
 * runtime the export rests on. No export names this file; `interleaving.ts`
 * imports it first.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { Context, Deferred, Effect, Fiber, Scheduler, Tracer } from "effect";
import effectManifest from "effect/package.json" with { type: "json" };

// Every name `interleaving.ts` and this module import from effect is exported
// by Effect 3 too, so on Effect 3 the imports link and this check is what
// speaks.
const { version } = effectManifest;
if (!version.startsWith("4.")) {
  throw new Error(
    `@gokayo43/dev-config/interleaving runs on effect 4, and this process's effect is ${version}: Effect ${version.split(".")[0]} schedules fibers in a way simulate cannot drive`,
  );
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;

const nativeTracer = Context.get(Context.empty(), Tracer.Tracer);

/**
 * `program` run under a scheduler that answers `yields` and runs every task
 * first in first out, recording what the runtime asked and queued, the fibers
 * whose ops the tracer's context hook saw, and the op whose async context was
 * the current one at each ask and each task queued.
 */
function witness(
  program: Effect.Effect<unknown>,
  yields: (fiber: AnyFiber, ask: number) => boolean,
) {
  const context = new AsyncLocalStorage<number>();
  const asks: {
    fiber: AnyFiber;
    count: number;
    running: boolean;
    task: number;
    op: number | undefined;
  }[] = [];
  const queued: {
    run: () => void;
    by: AnyFiber | undefined;
    afterAsk: number;
    op: number | undefined;
  }[] = [];
  const traced = new Set<AnyFiber>();
  let task = -1;
  let ops = 0;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      asks.push({
        fiber,
        count: fiber.currentOpCount,
        running: Fiber.getCurrent() === fiber,
        task,
        op: context.getStore(),
      });
      return yields(fiber, asks.length - 1);
    },
    makeDispatcher: () => ({
      scheduleTask: (run) =>
        void queued.push({
          run,
          by: Fiber.getCurrent(),
          afterAsk: asks.length - 1,
          op: context.getStore(),
        }),
      flush: () => undefined,
    }),
  };
  const tracer = Tracer.make({
    span: (options) => nativeTracer.span(options),
    context: (primitive, fiber) => {
      traced.add(fiber);
      return context.run(ops++, () => primitive["~effect/Effect/evaluate"](fiber));
    },
  });
  const root = Effect.runForkWith(Context.make(Tracer.Tracer, tracer))(program, { scheduler });
  for (task = 0; task < queued.length && task < 1_000; task++) queued[task]?.run();
  return { root, asks, queued, traced };
}

const note = (log: string[], step: string) => Effect.sync(() => void log.push(step));

/** The orders a fiber `b` takes against `a`'s two steps, told to yield at each ask in turn. */
function ordersAgainst(steps: (log: string[]) => Effect.Effect<void>): Set<string> {
  const orders = new Set<string>();
  for (let at = 0; at < 64; at++) {
    const log: string[] = [];
    witness(
      Effect.gen(function* () {
        const a = yield* Effect.forkChild(steps(log));
        const b = yield* Effect.forkChild(note(log, "b"));
        yield* Fiber.join(a);
        yield* Fiber.join(b);
      }),
      (_fiber, ask) => ask === at,
    );
    orders.add(log.join(" "));
  }
  return orders;
}

/**
 * The facts about Effect's runtime everything `simulate` finds rests on, each
 * checked by a small program. A release that broke one would leave race
 * properties passing without reaching a race, the page's account of what a
 * search can cut false, the priority strategy ranking the wrong fiber, a run's
 * fibers alive after it, or a run parked where Effect loses an interruption.
 */
const facts: readonly { readonly fact: string; readonly holds: () => boolean }[] = [
  {
    fact: "asks the scheduler between two steps joined by andThen, so a fiber can run between them",
    holds: () =>
      ordersAgainst((log) => note(log, "a1").pipe(Effect.andThen(note(log, "a2")))).has("a1 b a2"),
  },
  {
    fact: "runs two steps joined by map without asking the scheduler between them",
    holds: () =>
      !ordersAgainst((log) => note(log, "a1").pipe(Effect.map(() => void log.push("a2")))).has(
        "a1 b a2",
      ),
  },
  {
    fact: "asks with the fiber whose op comes next, its op count 1 on the first op of a slice, and names the fiber that queues a task as the current one, so a fork's first op is its child's and a yield's first op is the yielder's",
    holds: () => {
      let child: AnyFiber | undefined;
      const { root, asks, queued } = witness(
        Effect.gen(function* () {
          const forked = yield* Effect.forkChild(Effect.void);
          child = forked;
          yield* Effect.yieldNow;
          yield* Fiber.join(forked);
        }),
        () => false,
      );
      const firstOf = (index: number) => asks.find((ask) => ask.task === index);
      const [fork, yielded] = queued;
      return (
        asks.every(({ running }) => running) &&
        fork?.by === root &&
        firstOf(0)?.fiber === child &&
        firstOf(0)?.count === 1 &&
        yielded?.by === root &&
        firstOf(1)?.fiber === root &&
        firstOf(1)?.count === 1
      );
    },
  },
  {
    fact: "queues a fiber's continuation from that fiber, before asking anything else, when the scheduler tells it to yield",
    holds: () => {
      const { root, asks, queued } = witness(
        Effect.gen(function* () {
          yield* Effect.void;
          yield* Effect.void;
        }),
        (_fiber, ask) => ask === 1,
      );
      const [continuation] = queued;
      const resumed = asks.find((ask) => ask.task === 0);
      return (
        queued.length === 1 &&
        continuation?.by === root &&
        continuation.afterAsk === 1 &&
        resumed?.fiber === root &&
        resumed.count > 1
      );
    },
  },
  {
    fact: "hands the tracer's context hook every op of every fiber, those under Scheduler.PreventSchedulerYield included",
    holds: () => {
      let detached: AnyFiber | undefined;
      const { traced } = witness(
        Effect.gen(function* () {
          const never = yield* Deferred.make<void>();
          detached = yield* Effect.forkDetach(Deferred.await(never));
        }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
        () => false,
      );
      return detached !== undefined && traced.has(detached);
    },
  },
  {
    fact: "runs every slice after the root's first through the scheduler's dispatchers, so a program of forks, yields and deferreds finishes once their tasks have run",
    holds: () => {
      const { root } = witness(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const waiter = yield* Effect.forkChild(
            Deferred.await(gate).pipe(Effect.andThen(Effect.yieldNow)),
          );
          const opener = yield* Effect.forkChild(
            Effect.yieldNow.pipe(Effect.andThen(Deferred.succeed(gate, undefined))),
          );
          yield* Effect.yieldNow;
          yield* Fiber.joinAll([waiter, opener]);
        }),
        () => false,
      );
      return root.pollUnsafe() !== undefined;
    },
  },
  {
    fact: "runs a forked fiber's first op in the async context of the op that forked it",
    holds: () => {
      const { asks, queued } = witness(
        Effect.gen(function* () {
          yield* Fiber.join(yield* Effect.forkChild(Effect.void));
        }),
        () => false,
      );
      const [fork] = queued;
      const first = asks.find((ask) => ask.task === 0);
      return fork?.op !== undefined && first?.op === fork.op;
    },
  },
];

let runtimeAnswered = false;

/** Throws, once per process, naming the first fact about Effect's runtime that no longer holds. */
export function verifyRuntime(): void {
  if (runtimeAnswered) return;
  for (const { fact, holds } of facts) {
    if (!holds()) {
      throw new Error(
        `this process's effect no longer ${fact}, which simulate rests on; it was written against effect 4.1.4`,
      );
    }
  }
  runtimeAnswered = true;
}
