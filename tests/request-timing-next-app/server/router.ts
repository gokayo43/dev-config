/**
 * The app's tRPC router: procedures shaped as the warehouse's, each body one
 * `handle(program)`, on a base procedure that carries the request-timing
 * middleware while timing is on.
 */
import { initTRPC, lazy, TRPCError } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { presets } from "./clients.ts";
import { Db, handle, lane, presetById, run, touch } from "./effect.ts";
import { timed } from "./env.ts";
import { held } from "./held.ts";
import { procedureTiming } from "./timing.ts";

const t = initTRPC.create();

const procedure = timed ? t.procedure.use(procedureTiming.middleware) : t.procedure;

/** An input of `{ id }`, as a validator the base procedure runs after the middleware. */
const byId = (raw: unknown) => {
  if (typeof raw !== "object" || raw === null || !("id" in raw) || typeof raw.id !== "number") {
    throw new TypeError("an id is required");
  }
  return { id: raw.id };
};

const plan = (raw: unknown) => {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("db" in raw) ||
    !("out" in raw) ||
    !("tx" in raw) ||
    typeof raw.db !== "number" ||
    typeof raw.out !== "number" ||
    typeof raw.tx !== "boolean"
  ) {
    throw new TypeError("a plan of db and out waits, and whether in a transaction, is required");
  }
  return { db: raw.db, out: raw.out, tx: raw.tx };
};

const label = (raw: unknown) => {
  if (typeof raw !== "string") throw new TypeError("a label is required");
  return raw;
};

/** Every code a TRPCError takes, as tRPC lists them. */
export const TRPC_CODES = Object.keys(TRPC_ERROR_CODES_BY_KEY).filter(
  (key): key is TRPC_ERROR_CODE_KEY => key in TRPC_ERROR_CODES_BY_KEY,
);

const code = (raw: unknown): TRPC_ERROR_CODE_KEY => {
  const known = TRPC_CODES.find((candidate) => candidate === raw);
  if (known === undefined) throw new TypeError("a code tRPC knows is required");
  return known;
};

/**
 * A procedure of a lazily loaded router whose path is longer than the core
 * takes for a name: the envelope cannot check it when the route module loads,
 * so its call meets the refusal when it closes.
 */
export const REFUSED_PROCEDURE = `deferred.${"aProcedurePathLongerThanTheCoreTakes".repeat(8)}`;

/** How many lanes the overlap case can run at once, each a procedure of its own so its record names it. */
export const LANES = 6;

const lanes = Object.fromEntries(
  Array.from({ length: LANES }, (_, index) => [
    `l${index}`,
    procedure.input(plan).query(({ input }) => handle(lane(input))),
  ]),
);

export const appRouter = t.router({
  presets: t.router({
    byId: procedure.input(byId).query(({ input }) => handle(presetById(input.id))),
    add: procedure.input(label).mutation(({ input }) =>
      handle(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.use((client) => client.insert(presets).values({ label: input }));
          return yield* db.use((client) =>
            client.select().from(presets).where(eq(presets.label, input)),
          );
        }),
      ),
    ),
  }),
  fail: t.router({
    throws: procedure.query(async () => {
      await run(touch);
      throw new Error("the procedure failed");
    }),
    code: procedure.input(code).query(async ({ input }) => {
      await run(touch);
      throw new TRPCError({ code: input, message: `refused with ${input}` });
    }),
  }),
  guarded: t.router({
    secret: procedure
      .use(() => {
        throw new TRPCError({ code: "FORBIDDEN", message: "not for you" });
      })
      .query(() => "secret"),
  }),
  held: t.router({
    hang: procedure.query(async () => {
      await run(touch);
      await held.wait();
      await run(touch);
      held.done();
      return "too late";
    }),
  }),
  ticks: t.router({
    count: procedure.subscription(async function* () {
      yield 1;
      await run(touch);
      yield 2;
      await run(touch);
      yield 3;
    }),
  }),
  lanes: t.router(lanes),
  faults: t.router({ unwritten: procedure.query(() => "served") }),
  deferred: lazy(async () =>
    t.router({
      [REFUSED_PROCEDURE.slice("deferred.".length)]: procedure.query(() => "served"),
    }),
  ),
});
