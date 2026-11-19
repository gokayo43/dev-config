/**
 * Invariant 3: a wait is counted in exactly one record, that of the operation
 * that issued it, whatever runs beside it and whatever shared resource it
 * passed through; a wait issued outside any operation is counted in none.
 *
 * Generated plans: participants that overlap, each an operation or work
 * outside any operation, each a script of waits with generated kinds, turns
 * and laziness, some held under a contended semaphore or pool, and handoffs
 * between participants, after which the taking side's next wait is its own.
 * A plain async program runs them with promises; an Effect program runs them
 * through the kit's Effect driver, `runPlan`, whose handoffs pass through a
 * Deferred, a queue, a PubSub, a stream and an interrupt whose finalizer
 * waits, and whose waits are also made in detached fibers, through
 * `Effect.runPromise` and through a `ManagedRuntime` built before any
 * operation. Overlap comes from the plan's turns and yields, so no clock
 * takes part. The wrong implementation is Effect resuming a woken fiber on the
 * waker's stack, which this Effect does not do and which the kit's own suite
 * shows its check failing on.
 */
import { describe, expect, test } from "bun:test";
import * as effect from "effect";
import {
  type Arbitrary,
  array,
  asyncProperty,
  boolean,
  constantFrom,
  integer,
  nat,
  record,
} from "fast-check";

import { nth } from "../narrowing.ts";
import { check } from "../property.ts";
import {
  counted,
  expected,
  type Handoff,
  type Plan,
  runPlan,
  type Step,
} from "../request-timing-effect-driver.ts";
import {
  measure,
  OperationName,
  requestTiming,
  type TimingRecord,
  WAIT_KINDS,
  type WaitKind,
  within,
} from "../request-timing.ts";

type Own = Extract<Step, { readonly kind: WaitKind }>["do"];

const kind = constantFrom<WaitKind>(...WAIT_KINDS);
const turns = integer({ min: 0, max: 4 });

/**
 * Handoffs are drawn as numbers and placed into the scripts here: each goes
 * from a participant to one listed after it, so no cycle of waiting can form.
 */
const plans = (own: readonly Own[], vias: readonly Handoff[]): Arbitrary<Plan> =>
  record({
    participants: array(
      record({
        operation: boolean(),
        startAfter: turns,
        steps: array(record({ do: constantFrom(...own), kind, turns, lazy: boolean() }), {
          maxLength: 5,
        }),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    handoffs: array(
      record({
        from: nat(),
        to: nat(),
        fromAt: nat(),
        toAt: nat(),
        via: constantFrom(...vias),
        afterwards: kind,
      }),
      { maxLength: 4 },
    ),
  }).map(({ participants, handoffs }) => {
    const scripts: Step[][] = participants.map((participant) => [...participant.steps]);
    const passing: Handoff[] = [];
    if (scripts.length > 1) {
      for (const handoff of handoffs) {
        const from = handoff.from % (scripts.length - 1);
        const to = from + 1 + (handoff.to % (scripts.length - 1 - from));
        const signal = passing.push(handoff.via) - 1;
        const giver = nth(scripts, from);
        const taker = nth(scripts, to);
        giver.splice(handoff.fromAt % (giver.length + 1), 0, { do: "signal", signal });
        taker.splice(handoff.toAt % (taker.length + 1), 0, {
          do: "await",
          signal,
          afterwards: handoff.afterwards,
        });
      }
    }
    return {
      participants: participants.map((participant, index) => ({
        ...participant,
        steps: nth(scripts, index),
      })),
      handoffs: passing,
    };
  });

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
    give: () => {
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

/** A plan run as a plain async program: a semaphore and a pool are mutexes, a detached wait one started from a then. */
async function runPlain(plan: Plan): Promise<readonly TimingRecord[]> {
  const records: TimingRecord[] = [];
  const timing = requestTiming({
    fault: (error) => {
      throw error;
    },
    sink: (made) => void records.push(made),
    now: () => 0,
  });
  const lock = mutex();
  const pool = mutex();
  const passages = plan.handoffs.map((via) => {
    if (via !== "deferred") return channel();
    const deferred = Promise.withResolvers<void>();
    return { take: () => deferred.promise, give: () => deferred.resolve() };
  });
  const wait = (waited: WaitKind, count: number) => measure(waited, () => turn(count));
  const held = async (by: ReturnType<typeof mutex>, waited: WaitKind, count: number) => {
    await by.acquire();
    try {
      await wait(waited, count);
    } finally {
      by.release();
    }
  };
  const script = async (steps: readonly Step[]) => {
    for (const step of steps) {
      switch (step.do) {
        case "wait":
          await wait(step.kind, step.turns);
          break;
        case "locked":
          await held(lock, step.kind, step.turns);
          break;
        case "pooled":
          await held(pool, step.kind, step.turns);
          break;
        case "detached":
          await Promise.resolve().then(() => wait(step.kind, step.turns));
          break;
        case "await":
          await nth(passages, step.signal).take();
          await wait(step.afterwards, 0);
          break;
        case "signal":
          nth(passages, step.signal).give();
          break;
      }
    }
  };
  await Promise.all(
    plan.participants.map(async (participant, index) => {
      await turn(participant.startAfter);
      if (!participant.operation) return script(participant.steps);
      const operation = timing.open();
      await within(operation, () => script(participant.steps));
      operation.close({
        method: "GET",
        name: OperationName.registered(`/participant/${index}`),
        status: 200,
        aborted: false,
        streamed: false,
      });
    }),
  );
  return records;
}

const OWN: readonly Own[] = ["wait", "locked", "pooled", "detached"];

describe("every wait is counted in the record of the operation that issued it, and in no other", () => {
  test("in a plain async program", () =>
    check(
      asyncProperty(plans(OWN, ["deferred", "queue"]), async (plan) => {
        expect(counted(await runPlain(plan))).toEqual(expected(plan));
      }),
    ));

  test("in an Effect program, run through Effect.runPromise and through a ManagedRuntime", () =>
    check(
      asyncProperty(
        plans(OWN, ["deferred", "queue", "pubsub", "stream", "interrupt"]),
        async (plan) => {
          expect(counted(await runPlan(effect, plan, "runPromise"))).toEqual(expected(plan));
          expect(counted(await runPlan(effect, plan, "managedRuntime"))).toEqual(expected(plan));
        },
      ),
    ));
});
