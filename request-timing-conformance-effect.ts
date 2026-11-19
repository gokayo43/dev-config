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
 * `request-timing-effect-driver.ts` runs the table. `effect` is imported as
 * types only: the module is the app's, handed in.
 */
import type * as Fx from "effect";

import {
  MODULES,
  counted,
  expected,
  type Plan,
  runPlan,
  type Step,
} from "./request-timing-effect-driver.ts";

/** The `effect` module an app has installed. */
export type EffectModule = typeof Fx;

/** Waits that pass through each of Effect's shared resources the driver has, run by the check under both entries. */
const TABLE: readonly { readonly through: string; readonly plan: Plan }[] = [
  ...(
    [
      ["locked", "a shared semaphore"],
      ["pooled", "a shared pool"],
    ] as const
  ).map(([held, through]) => ({
    through,
    plan: {
      participants: [
        {
          operation: false,
          startAfter: 0,
          steps: [{ do: held, kind: "store", turns: 3, lazy: false }] satisfies Step[],
        },
        ...[0, 1, 2].map((startAfter) => ({
          operation: true,
          startAfter,
          steps: [
            { do: held, kind: "db", turns: 2, lazy: true },
            { do: held, kind: "out", turns: 1, lazy: false },
          ] satisfies Step[],
        })),
      ],
      handoffs: [],
    },
  })),
  ...(["deferred", "queue", "pubsub", "stream"] as const).map((via) => ({
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

const NEEDS =
  "request timing needs effect 4.0.1 or later, on a host whose process.getBuiltinModule finds node:async_hooks: Bun, or Node 20.16 or later and not 22.0 to 22.2";

/**
 * Rejects unless every wait of the table's Effect programs is counted in the
 * record of the operation that issued it and in no other, run on `effect`
 * through `Effect.runPromise` and through a `ManagedRuntime` alike. The
 * table passes waits through a shared semaphore, pool, Deferred, queue, PubSub
 * and stream, an interrupt whose finalizer waits, a detached fiber, and lazy
 * thenables under `Effect.tryPromise`, beside work outside any operation.
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
