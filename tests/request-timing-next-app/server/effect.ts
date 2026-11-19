/**
 * The app's Effect side, shaped as the warehouse's: a `Db` service whose `use`
 * takes a promise-returning thunk, an outbound send, and a token cache behind
 * a semaphore, all on one runtime, which procedures reach through `handle` and
 * route handlers through `handleRoute`. Timing on or off, nothing here
 * changes: the clients under the services are what timing wraps.
 */
import { TRPCError } from "@trpc/server";
import { count, eq, sql } from "drizzle-orm";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Semaphore,
} from "effect";

import { clients, type Database, presets, type Transaction } from "./clients.ts";

class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}

class OutsideError extends Data.TaggedError("OutsideError")<{ readonly cause: unknown }> {}

class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}

type AppError = DbError | OutsideError | NotFound;

export class Db extends Context.Service<
  Db,
  {
    readonly use: <A>(f: (db: Database) => PromiseLike<A>) => Effect.Effect<A, DbError>;
    /** One interactive transaction, its body plain async over drizzle's transaction client. */
    readonly transaction: <A>(f: (tx: Transaction) => Promise<A>) => Effect.Effect<A, DbError>;
  }
>()("Db") {}

const DbLive = Layer.succeed(Db, {
  use: (f) =>
    Effect.tryPromise({ try: () => f(clients().db), catch: (cause) => new DbError({ cause }) }),
  transaction: (f) =>
    Effect.tryPromise({
      try: () => clients().db.transaction(f),
      catch: (cause) => new DbError({ cause }),
    }),
});

export class Outside extends Context.Service<
  Outside,
  { readonly send: (path: string) => Effect.Effect<string, OutsideError> }
>()("Outside") {}

const OutsideLive = Layer.succeed(Outside, {
  send: (path) =>
    Effect.tryPromise({
      try: async () => (await clients().send(path)).text(),
      catch: (cause) => new OutsideError({ cause }),
    }),
});

/** One round of the overlap case: how many lanes it waits for, and the deferred the last one completes. */
interface Round {
  readonly lanes: number;
  readonly arrived: number;
  readonly all: Deferred.Deferred<void>;
}

/**
 * The token cache's lock: one permit, which every lane takes in turn, so each
 * lane after the first is woken by the lane that released it. A
 * round holds the permit until every lane it waits for has arrived at it.
 */
export class Turns extends Context.Service<
  Turns,
  {
    readonly hold: (lanes: number, holding: () => void) => Effect.Effect<void>;
    readonly take: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("Turns") {}

const TurnsLive = Layer.effect(
  Turns,
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
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
        Semaphore.withPermits(
          permit,
          1,
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
          return yield* Semaphore.withPermits(permit, 1, work);
        }),
    };
  }),
);

const runtime = ManagedRuntime.make(Layer.mergeAll(DbLive, OutsideLive, TurnsLive));

// Built when the module loads, before any request: a runtime built on its
// first run forks its layer's fibers inside that request's fiber, where they
// keep its operation (docs/exports/request-timing.md, "Effect programs").
await runtime.context();

type AppServices = Db | Outside | Turns;

/** The tRPC adapter: runs a program and raises what tRPC understands. */
export async function handle<A>(program: Effect.Effect<A, AppError | TRPCError, AppServices>) {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const error = failure.value;
  if (error instanceof TRPCError) throw error;
  if (error._tag === "NotFound") throw new TRPCError({ code: "NOT_FOUND", message: error.what });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error._tag });
}

/** The route adapter: runs a program that answers a response, and answers a refusal when it fails. */
export async function handleRoute(program: Effect.Effect<Response, AppError, AppServices>) {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value._tag === "NotFound") {
    return Response.json({ error: failure.value.what }, { status: 404 });
  }
  return Response.json({ error: "unavailable" }, { status: 503 });
}

/** Runs a program with no answer of its own to map, from plain code inside a handler. */
export const run = <A>(program: Effect.Effect<A, AppError, AppServices>) =>
  runtime.runPromise(program);

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

/**
 * A lane of the overlap case: its outbound waits under the token cache's lock,
 * then its database waits, each a drizzle query the thunk hands straight back,
 * or, for a lane in a transaction, the statements of one drizzle transaction.
 */
export const lane = (plan: Plan) =>
  Effect.gen(function* () {
    const outside = yield* Outside;
    yield* (yield* Turns).take(
      Effect.gen(function* () {
        for (let wait = 0; wait < plan.out; wait += 1) yield* outside.send("/token");
      }),
    );
    const db = yield* Db;
    if (plan.tx) {
      yield* db.transaction(async (tx) => {
        for (let wait = 0; wait < plan.db; wait += 1) await tx.select().from(presets);
      });
    } else {
      for (let wait = 0; wait < plan.db; wait += 1) {
        yield* db.use((client) => client.select().from(presets));
      }
    }
    return "done";
  });

/** What a lane waits on: its database waits, whether they run in one transaction, and its outbound waits. */
export interface Plan {
  readonly db: number;
  readonly tx: boolean;
  readonly out: number;
}
