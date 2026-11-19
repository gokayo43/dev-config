/**
 * The composition root and the one bridge into it, as the template's
 * `src/server/runtime.ts` and its edge have them.
 */
import { Context, Effect, Layer, ManagedRuntime, Semaphore } from "effect";

import { Db, DbLive } from "./db.ts";

/**
 * One permit every lane takes for its queries, so a lane waiting on it is
 * resumed by the fiber of another request that released it.
 */
export class Contended extends Context.Service<
  Contended,
  { readonly semaphore: Semaphore.Semaphore }
>()("Contended") {}

const ContendedLive = Layer.effect(
  Contended,
  Effect.map(Semaphore.make(1), (semaphore) => ({ semaphore })),
);

const AppLayer = Layer.mergeAll(DbLive, ContendedLive);

export const runtime = ManagedRuntime.make(AppLayer);

// Built when the module loads, before any request: a runtime built on its
// first run forks its layer's fibers inside that request's fiber, where they
// keep its operation (docs/exports/request-timing.md, "Effect programs").
await runtime.context();

/** Runs `program` for a route or a server function, in the operation of the request it serves. */
export const run = <A, E>(program: Effect.Effect<A, E, Db | Contended>): Promise<A> =>
  runtime.runPromise(program);
