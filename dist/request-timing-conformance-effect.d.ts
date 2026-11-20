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
import * as Fx from "effect";
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