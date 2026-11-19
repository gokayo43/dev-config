import * as Fx from "effect";
//#region request-timing-conformance-effect.d.ts
/** The `effect` module an app has installed. */
export type EffectModule = typeof Fx;
/**
 * Rejects unless every wait of the table's Effect programs is counted in the
 * record of the operation that issued it and in no other, run on `effect`
 * through `Effect.runPromise` and through a `ManagedRuntime` alike. The
 * table passes waits through a shared semaphore, pool, Deferred, queue, PubSub
 * and stream, an interrupt whose finalizer waits, a detached fiber, and lazy
 * thenables under `Effect.tryPromise`, beside work outside any operation.
 */
export declare function requestTimingEffectConforms(effect: EffectModule): Promise<void>;
//#endregion