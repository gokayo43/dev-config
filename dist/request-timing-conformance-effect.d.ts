import { g as WaitKind, m as TimingRecord } from "./request-timing-CGWxjLxw.js";
import * as Fx from "effect";
//#region request-timing-conformance-effect.d.ts
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
export type Step = {
  readonly do: "wait" | "locked" | "pooled" | "detached";
  readonly kind: WaitKind;
  readonly turns: number;
  readonly lazy: boolean;
} | {
  readonly do: "await";
  readonly signal: number;
  readonly afterwards: WaitKind;
} | {
  readonly do: "signal";
  readonly signal: number;
};
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
/** What each operation's record must count: the waits its own script issued, and nothing else. */
export declare function expected(plan: Plan): Counted[];
/** What the records count, in `expected`'s shape. */
export declare function counted(records: readonly TimingRecord[]): Counted[];
/**
 * Runs every participant of `plan` at once, each operation opened through the
 * real core and run under its `within`, and answers the records they closed
 * into. The semaphore and the pool are built in the layer of a
 * `ManagedRuntime` made before any operation is open, and every handoff
 * before any participant starts, so none of them carries an operation of its
 * own; `entry` says whether a participant's program runs on that runtime or
 * through `Effect.runPromise` with its services provided.
 */
export declare function runPlan(effect: EffectModule, plan: Plan, entry: Entry): Promise<readonly TimingRecord[]>;
/**
 * Rejects unless every wait of the table's Effect programs is counted in the
 * record of the operation that issued it and in no other, run on `effect`
 * through `Effect.runPromise` and through a `ManagedRuntime` alike. The
 * table passes waits through a shared semaphore, Deferred and queue, an
 * interrupt whose finalizer waits, a detached fiber, and lazy thenables under
 * `Effect.tryPromise`, beside work outside any operation.
 */
export declare function requestTimingEffectConforms(effect: EffectModule): Promise<void>;
//#endregion