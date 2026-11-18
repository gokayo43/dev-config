/**
 * The composition root and the one bridge into it, as the template's
 * `src/server/runtime.ts` and its edge have them, with the crossing in the
 * export's page asks for: `run` carries the handler's operation into the
 * program's fiber.
 */
import { Effect, Layer, ManagedRuntime } from "effect";

import { carryOperation } from "../../../request-timing-effect.ts";
import { Db } from "./db.ts";

/**
 * One permit every lane takes for its queries, so a lane waiting on it is
 * resumed by the fiber of another request that released it.
 */
export class Contended extends Effect.Service<Contended>()("Contended", {
  effect: Effect.map(Effect.makeSemaphore(1), (semaphore) => ({ semaphore })),
}) {}

const AppLayer = Layer.mergeAll(Db.Default, Contended.Default);

export const runtime = ManagedRuntime.make(AppLayer);

/** Runs `program` for a route or a server function, in the operation of the request it serves. */
export const run = <A, E>(program: Effect.Effect<A, E, Db | Contended>): Promise<A> =>
  runtime.runPromise(carryOperation(program));
