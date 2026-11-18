/**
 * Invariant 3: a wait is counted in exactly one record, that of the operation
 * that issued it, whatever runs beside it and whatever shared resource it
 * passed through; a wait issued outside any operation is counted in none.
 *
 * One property per carrier over generated plans: participants that overlap,
 * each an operation or background work, each a script of waits with generated
 * kinds and delays, some taken under a contended semaphore, and handoffs
 * between participants through a Deferred or a queue, after which the waiting
 * side's next wait is its own. A delay is a number of turns of the carrier's
 * scheduler (`await` for the plain one, `Effect.yieldNow` for the Effect one),
 * so the overlap comes from the plan and no clock takes part. The plain-delay
 * property alone misses the handoffs, which is where a fiber resumes on the
 * stack of the one that released it.
 *
 * The Effect carrier's property is also run against a carrier that keeps the
 * operation in `AsyncLocalStorage`, and must fail there: that is the design
 * the FiberRef carrier exists to replace.
 */
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Queue } from "effect";
import {
  type Arbitrary,
  array,
  asyncProperty,
  boolean,
  constantFrom,
  integer,
  nat,
  oneof,
  record,
} from "fast-check";

import { nth } from "../narrowing.ts";
import { check } from "../property.ts";
import * as effectCarrier from "../request-timing-effect.ts";
import * as plainCarrier from "../request-timing.ts";
import {
  type Operation,
  OperationName,
  requestTiming,
  type TimingRecord,
  WAIT_KINDS,
  type WaitKind,
} from "../request-timing.ts";

type Step =
  | { readonly do: "wait"; readonly kind: WaitKind; readonly turns: number }
  | { readonly do: "locked"; readonly kind: WaitKind; readonly turns: number }
  | { readonly do: "await"; readonly signal: number; readonly afterwards: WaitKind }
  | { readonly do: "signal"; readonly signal: number };

interface Participant {
  /** An operation, or work outside any operation. */
  readonly operation: boolean;
  readonly startAfter: number;
  readonly steps: readonly Step[];
}

interface Plan {
  readonly participants: readonly Participant[];
  /** What each handoff passes through, by signal number. */
  readonly signals: readonly ("deferred" | "queue")[];
}

const kind = constantFrom<WaitKind>(...WAIT_KINDS);
const turns = integer({ min: 0, max: 4 });
const own: Arbitrary<Step> = oneof(
  record({ do: constantFrom("wait" as const), kind, turns }),
  record({ do: constantFrom("locked" as const), kind, turns }),
);

/**
 * Handoffs are drawn as numbers and placed into the scripts here: each goes
 * from a participant to one listed after it, so no cycle of waiting can form,
 * and a semaphore is held across a single wait and no handoff, so nothing
 * waits while holding it.
 */
const plans: Arbitrary<Plan> = record({
  participants: array(
    record({ operation: boolean(), startAfter: turns, steps: array(own, { maxLength: 5 }) }),
    { minLength: 1, maxLength: 6 },
  ),
  handoffs: array(
    record({
      from: nat(),
      to: nat(),
      fromAt: nat(),
      toAt: nat(),
      via: constantFrom("deferred" as const, "queue" as const),
      afterwards: kind,
    }),
    { maxLength: 4 },
  ),
}).map(({ participants, handoffs }) => {
  const scripts = participants.map((participant) => [...participant.steps]);
  const signals: ("deferred" | "queue")[] = [];
  if (scripts.length > 1) {
    for (const handoff of handoffs) {
      const from = handoff.from % (scripts.length - 1);
      const to = from + 1 + (handoff.to % (scripts.length - 1 - from));
      const signal = signals.push(handoff.via) - 1;
      const sender = scripts[from] ?? [];
      const receiver = scripts[to] ?? [];
      sender.splice(handoff.fromAt % (sender.length + 1), 0, { do: "signal", signal });
      receiver.splice(handoff.toAt % (receiver.length + 1), 0, {
        do: "await",
        signal,
        afterwards: handoff.afterwards,
      });
    }
  }
  return {
    participants: participants.map((participant, index) => ({
      ...participant,
      steps: scripts[index] ?? [],
    })),
    signals,
  };
});

const nameOf = (index: number) => OperationName.registered(`/participant/${index}`);

/** What each operation's record must count, by operation name: the waits it issued itself. */
function expected(plan: Plan) {
  return plan.participants.flatMap((participant, index) => {
    if (!participant.operation) return [];
    const counts = { db: 0, out: 0, store: 0 };
    for (const step of participant.steps) {
      if (step.do === "wait" || step.do === "locked") counts[step.kind] += 1;
      if (step.do === "await") counts[step.afterwards] += 1;
    }
    return [{ operation: nameOf(index).pattern, ...counts }];
  });
}

const counted = (records: readonly TimingRecord[]) =>
  records
    .map((made) => ({
      operation: made.operation,
      db: made.db.count,
      out: made.out.count,
      store: made.store.count,
    }))
    .toSorted((a, b) => a.operation.localeCompare(b.operation));

// --- the plain carrier -------------------------------------------------------

const turn = async (count: number) => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

/** A semaphore of one permit that hands it to the next waiter by resolving that waiter's promise. */
function mutex() {
  let held = false;
  const waiters: (() => void)[] = [];
  return {
    acquire: async () => {
      if (!held) {
        held = true;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
    release: () => {
      const next = waiters.shift();
      if (next === undefined) held = false;
      else next();
    },
  };
}

/** A queue whose taker is resumed from the stack of whoever offers. */
function channel() {
  let offered = 0;
  const takers: (() => void)[] = [];
  return {
    offer: () => {
      const taker = takers.shift();
      if (taker === undefined) offered += 1;
      else taker();
    },
    take: async () => {
      if (offered > 0) {
        offered -= 1;
        return;
      }
      await new Promise<void>((resolve) => takers.push(resolve));
    },
  };
}

async function runPlain(plan: Plan): Promise<readonly TimingRecord[]> {
  const records: TimingRecord[] = [];
  const timing = requestTiming({ sink: (made) => void records.push(made), now: () => 0 });
  const lock = mutex();
  const handoffs = plan.signals.map((via) => {
    if (via === "deferred") {
      const deferred = Promise.withResolvers<void>();
      return { taken: () => deferred.promise, given: () => deferred.resolve() };
    }
    const queue = channel();
    return { taken: queue.take, given: queue.offer };
  });
  const wait = (waited: WaitKind, count: number) => plainCarrier.measure(waited, () => turn(count));
  const script = async (steps: readonly Step[]) => {
    for (const step of steps) {
      switch (step.do) {
        case "wait":
          await wait(step.kind, step.turns);
          break;
        case "locked":
          await lock.acquire();
          try {
            await wait(step.kind, step.turns);
          } finally {
            lock.release();
          }
          break;
        case "await":
          await nth(handoffs, step.signal).taken();
          await wait(step.afterwards, 0);
          break;
        case "signal":
          nth(handoffs, step.signal).given();
          break;
      }
    }
  };
  await Promise.all(
    plan.participants.map(async (participant, index) => {
      await turn(participant.startAfter);
      if (!participant.operation) return script(participant.steps);
      const operation = timing.open();
      await plainCarrier.within(operation, () => script(participant.steps));
      operation.close({
        method: "GET",
        name: nameOf(index),
        status: 200,
        aborted: false,
        streamed: false,
      });
    }),
  );
  return records;
}

// --- the Effect carrier ------------------------------------------------------

/** What an Effect program's edge does with an operation, and how its waits are measured. */
interface EffectCarrier {
  readonly serve: (operation: Operation, handler: Effect.Effect<void>) => Promise<void>;
  readonly measure: (kind: WaitKind, wait: Effect.Effect<void>) => Effect.Effect<void>;
}

const fiberCarrier: EffectCarrier = {
  serve: (operation, handler) => Effect.runPromise(effectCarrier.within(operation, handler)),
  measure: effectCarrier.measure,
};

/**
 * The carrier this export does not build: the edge runs the handler inside the
 * plain carrier's `AsyncLocalStorage`, and a wait reads the operation from it
 * wherever the fiber happens to be running.
 */
const storageCarrier: EffectCarrier = {
  serve: (operation, handler) => plainCarrier.within(operation, () => Effect.runPromise(handler)),
  measure: (waited, wait) =>
    Effect.suspend(() => {
      const settled = Promise.withResolvers<void>();
      void plainCarrier.measure(waited, () => settled.promise);
      return Effect.ensuring(
        wait,
        Effect.sync(() => settled.resolve()),
      );
    }),
};

/**
 * The crossing an app with plain handlers makes: the entry connector opens the
 * operation in the plain carrier, and the handler hands its program to the
 * runtime through `carryOperation`, after which only the fiber is read.
 */
const crossingCarrier: EffectCarrier = {
  serve: (operation, handler) =>
    plainCarrier.within(operation, () => Effect.runPromise(effectCarrier.carryOperation(handler))),
  measure: effectCarrier.measure,
};

/**
 * A crossing that leaves the operation in `AsyncLocalStorage` alone: the
 * handler hands its program to the runtime as it is, and a wait in it takes the
 * fiber's operation where there is one and the storage's where there is not.
 */
const storageCrossing: EffectCarrier = {
  serve: (operation, handler) => plainCarrier.within(operation, () => Effect.runPromise(handler)),
  measure: (waited, wait) =>
    Effect.flatMap(effectCarrier.inOperation, (carried) =>
      carried ? effectCarrier.measure(waited, wait) : storageCarrier.measure(waited, wait),
    ),
};

const yields = (count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow(), { discard: true });

async function runEffect(plan: Plan, carrier: EffectCarrier): Promise<readonly TimingRecord[]> {
  const records: TimingRecord[] = [];
  const timing = requestTiming({ sink: (made) => void records.push(made), now: () => 0 });
  const lock = Effect.runSync(Effect.makeSemaphore(1));
  const handoffs = plan.signals.map((via) => {
    if (via === "deferred") {
      const deferred = Effect.runSync(Deferred.make<void>());
      return {
        taken: Deferred.await(deferred),
        given: Effect.asVoid(Deferred.succeed(deferred, undefined)),
      };
    }
    const queue = Effect.runSync(Queue.unbounded<void>());
    return { taken: Queue.take(queue), given: Effect.asVoid(Queue.offer(queue, undefined)) };
  });
  const wait = (waited: WaitKind, count: number) => carrier.measure(waited, yields(count));
  const step = (taken: Step): Effect.Effect<void> => {
    switch (taken.do) {
      case "wait":
        return wait(taken.kind, taken.turns);
      case "locked":
        return lock.withPermits(1)(wait(taken.kind, taken.turns));
      case "await":
        return Effect.zipRight(nth(handoffs, taken.signal).taken, wait(taken.afterwards, 0));
      case "signal":
        return nth(handoffs, taken.signal).given;
    }
  };
  const script = (steps: readonly Step[]) => Effect.forEach(steps, step, { discard: true });
  await Promise.all(
    plan.participants.map(async (participant, index) => {
      const handler = Effect.zipRight(yields(participant.startAfter), script(participant.steps));
      if (!participant.operation) return Effect.runPromise(handler);
      const operation = timing.open();
      await carrier.serve(operation, handler);
      operation.close({
        method: "GET",
        name: nameOf(index),
        status: 200,
        aborted: false,
        streamed: false,
      });
    }),
  );
  return records;
}

const attributed = (run: (plan: Plan) => Promise<readonly TimingRecord[]>) =>
  check(
    asyncProperty(plans, async (plan) => {
      expect(counted(await run(plan))).toEqual(
        expected(plan).toSorted((a, b) => a.operation.localeCompare(b.operation)),
      );
    }),
  );

describe("every wait is counted in the record of the operation that issued it, and in no other", () => {
  test("in a plain async program", () => attributed(runPlain));

  test("in an Effect program, carried in the fiber", () =>
    attributed((plan) => runEffect(plan, fiberCarrier)));

  test("in an Effect program a plain handler hands to its runtime through the crossing", () =>
    attributed((plan) => runEffect(plan, crossingCarrier)));

  test("and not through a crossing that leaves the operation in AsyncLocalStorage", async () => {
    await expect(attributed((plan) => runEffect(plan, storageCrossing))).rejects.toThrow(
      "Property failed",
    );
  });

  test("and not in an Effect program carried in AsyncLocalStorage", async () => {
    await expect(attributed((plan) => runEffect(plan, storageCarrier))).rejects.toThrow(
      "Property failed",
    );
  });
});
