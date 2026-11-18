/**
 * The app's Effect side, shaped as the warehouse's: a `Db` service whose `use`
 * takes a promise-returning thunk, an outbound send, and a token cache behind
 * a semaphore, all on one runtime, which procedures reach through `handle` and
 * route handlers through `handleRoute`. With timing on, the adapters cross in
 * with `carryOperation` and the services cross back out with
 * `tryPromiseCarried`; with it off they are the plain Effect calls.
 */
import { TRPCError } from "@trpc/server";
import { count, eq, sql } from "drizzle-orm";
import { Cause, Data, Deferred, Effect, Exit, Layer, ManagedRuntime, Option, Ref } from "effect";

import { carryOperation, tryPromiseCarried } from "../../../request-timing-effect.ts";
import { clients, type Database, presets } from "./clients.ts";
import { timed } from "./env.ts";

class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}

class OutsideError extends Data.TaggedError("OutsideError")<{ readonly cause: unknown }> {}

class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}

type AppError = DbError | OutsideError | NotFound;

const tryPromise = timed ? tryPromiseCarried : Effect.tryPromise;

const carry = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  timed ? carryOperation(program) : program;

export class Db extends Effect.Service<Db>()("Db", {
  sync: () => ({
    use: <A>(f: (db: Database) => Promise<A>) =>
      tryPromise({ try: () => f(clients().db), catch: (cause) => new DbError({ cause }) }),
  }),
}) {}

export class Outside extends Effect.Service<Outside>()("Outside", {
  sync: () => ({
    send: (path: string) =>
      tryPromise({
        try: async () => (await clients().send(path)).text(),
        catch: (cause) => new OutsideError({ cause }),
      }),
  }),
}) {}

/** One round of the overlap case: how many lanes it waits for, and the deferred the last one completes. */
interface Round {
  readonly lanes: number;
  readonly arrived: number;
  readonly all: Deferred.Deferred<void>;
}

/**
 * The token cache's lock: one permit, which every lane takes in turn, so each
 * lane after the first resumes on the stack of the lane that released it. A
 * round holds the permit until every lane it waits for has arrived at it.
 */
export class Turns extends Effect.Service<Turns>()("Turns", {
  effect: Effect.gen(function* () {
    const permit = yield* Effect.makeSemaphore(1);
    const round = yield* Ref.make<Round>({
      lanes: 0,
      arrived: 0,
      all: yield* Deferred.make<void>(),
    });
    return {
      /**
       * Holds the permit for a round of `lanes`, calling `holding` once held,
       * until all of them are queued for it. A lane counts itself and asks for
       * the permit in one synchronous step of its fiber, which suspends only at
       * the permit, so when the last has counted itself every lane is waiting.
       */
      hold: (lanes: number, holding: () => void) =>
        permit.withPermits(1)(
          Effect.gen(function* () {
            const all = yield* Deferred.make<void>();
            yield* Ref.set(round, { lanes, arrived: 0, all });
            yield* Effect.sync(holding);
            yield* Deferred.await(all);
          }),
        ),
      take: <A, E, R>(work: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(round, (current) => ({
            ...current,
            arrived: current.arrived + 1,
          }));
          if (now.arrived === now.lanes) yield* Deferred.succeed(now.all, undefined);
          return yield* permit.withPermits(1)(work);
        }),
    };
  }),
}) {}

const runtime = ManagedRuntime.make(Layer.mergeAll(Db.Default, Outside.Default, Turns.Default));

type AppServices = Db | Outside | Turns;

/** The tRPC adapter: runs a program and raises what tRPC understands. */
export async function handle<A>(program: Effect.Effect<A, AppError | TRPCError, AppServices>) {
  const exit = await runtime.runPromiseExit(carry(program));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const error = failure.value;
  if (error instanceof TRPCError) throw error;
  if (error._tag === "NotFound") throw new TRPCError({ code: "NOT_FOUND", message: error.what });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error._tag });
}

/** The route adapter: runs a program that answers a response, and answers a refusal when it fails. */
export async function handleRoute(program: Effect.Effect<Response, AppError, AppServices>) {
  const exit = await runtime.runPromiseExit(carry(program));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value._tag === "NotFound") {
    return Response.json({ error: failure.value.what }, { status: 404 });
  }
  return Response.json({ error: "unavailable" }, { status: 503 });
}

/** Runs a program with no answer of its own to map, from plain code inside a handler. */
export const run = <A>(program: Effect.Effect<A, AppError, AppServices>) =>
  runtime.runPromise(carry(program));

/** A preset and how many there are, and what the outside service says: two database waits and one outbound. */
export const presetById = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [preset] = yield* db.use((client) =>
      client.select().from(presets).where(eq(presets.id, id)),
    );
    if (preset === undefined) return yield* new NotFound({ what: "no such preset" });
    const [total] = yield* db.use((client) => client.select({ total: count() }).from(presets));
    const remote = yield* (yield* Outside).send("/remote");
    return { preset, total: total?.total, remote };
  });

/** One database wait. */
export const touch = Effect.flatMap(Db, (db) => db.use((client) => client.execute(sql`select 1`)));

/** A lane of the overlap case: its outbound waits under the token cache's lock, then its database waits. */
export const lane = (plan: { readonly db: number; readonly out: number }) =>
  Effect.gen(function* () {
    const outside = yield* Outside;
    yield* (yield* Turns).take(
      Effect.gen(function* () {
        for (let wait = 0; wait < plan.out; wait += 1) yield* outside.send("/token");
      }),
    );
    for (let wait = 0; wait < plan.db; wait += 1) yield* touch;
    return "done";
  });
