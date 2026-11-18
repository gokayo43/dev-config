/**
 * The Elysia app the Elysia connector's suite boots: an app shaped like the
 * API, its error handler mounted first, then the request-timing plugin, then
 * its routes, over a real MySQL through drizzle, a real Redis through Bun's
 * client and an outside service through `fetch`. Booted with timing off it is the
 * same app with the bare clients and no plugin, which the differential takes
 * as its oracle.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { eq } from "drizzle-orm";
import { Elysia, sse, t } from "elysia";
import { RedisClient } from "bun";

import { must } from "../narrowing.ts";
import { requestTimingPlugin } from "../request-timing-elysia.ts";
import { timedFetch } from "../request-timing-fetch.ts";
import { timedBunRedis } from "../request-timing-bun-redis.ts";
import { timedPool } from "../request-timing-mysql2.ts";
import { requestTiming } from "../request-timing.ts";
import { faultLine, latch, lines, recordsFrom } from "./request-timing-fixture.ts";
import { keyPrefix, REDIS_URL, scratchDatabase } from "./request-timing-servers.ts";

const presets = mysqlTable("presets", {
  id: int().primaryKey().autoincrement(),
  label: varchar({ length: 64 }).notNull().unique(),
});

/** A refusal the app's error handler answers with 503. */
class Refused extends Error {}

/** A failure the app's error handler itself fails on, which leaves Bun to answer. */
class Broken extends Error {}

/** How many lanes the overlap property can run at once, each a route of its own so its record names it. */
export const LANES = 6;

/** The operation whose record the fixture's sink refuses, by throwing, as a sink whose log has gone would. */
export const UNWRITTEN = "/unwritten";

/** Boots the app on a free loopback port, with request timing on or off. */
export async function presetApp(timed: boolean, connectionLimit = 4) {
  const database = await scratchDatabase(connectionLimit);
  const redis = new RedisClient(REDIS_URL);
  const prefix = keyPrefix();
  const outside = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ outside: true }),
  });
  const sink = lines();
  const timing = requestTiming({
    fault: (error) => sink.write(faultLine(error)),
    sink: (record) => {
      if (record.operation === UNWRITTEN) throw new Error("the sink refused the record");
      sink.write(JSON.stringify({ level: "info", msg: "served" }));
      sink.write(JSON.stringify({ service: "fixture", ...record }));
    },
  });
  const pool = timed ? timedPool(database.pool) : database.pool;
  const store = timed ? timedBunRedis(redis) : redis;
  const send = timed ? timedFetch(fetch) : fetch;
  const db = drizzle(pool);
  const held = latch();
  // The app serving a request in-process, as the API serves its own generated
  // spec; set once the app below exists.
  const inProcess: { handle?: (request: Request) => Promise<Response> } = {};

  // Bun's own answer to a fetch that throws is a page it also logs as a
  // failure, which `bun test` counts against the run; this is the same 500.
  const app = new Elysia({ serve: { error: () => new Response("down", { status: 500 }) } })
    .onError(({ code, error, status }) => {
      if (code === "NOT_FOUND") return status(404, { error: "no such route" });
      if (error instanceof Refused) return status(503, { error: error.message });
      if (error instanceof Broken) throw new Error("the error handler failed too");
      return undefined;
    })
    .use(timed ? requestTimingPlugin(timing) : (plain: Elysia) => plain)
    .get("/presets/:id", async ({ params, status }) => {
      const [preset] = await db
        .select()
        .from(presets)
        .where(eq(presets.id, Number(params.id)));
      if (preset === undefined) return status(404, { error: "no such preset" });
      const total = await db.$count(presets);
      const cached = await store.get(prefix + params.id);
      const remote: unknown = await (await send(outside.url)).json();
      return { preset, total, cached, remote };
    })
    .post(
      "/presets",
      ({ body }) =>
        db.transaction(async (tx) => {
          await tx.insert(presets).values({ label: body.label });
          return tx.select().from(presets).where(eq(presets.label, body.label));
        }),
      { body: t.Object({ label: t.String() }) },
    )
    .get("/stream", async function* () {
      yield "first;";
      await db.select().from(presets);
      yield "second;";
      await store.get(`${prefix}stream`);
      yield "third";
    })
    .get("/events", async function* () {
      yield sse({ event: "preset", data: await db.select().from(presets) });
      yield sse({ event: "done", data: "end" });
    })
    .get("/fail", async () => {
      await db.select().from(presets);
      throw new Refused("refused midway");
    })
    .get("/outer", async () => {
      const inner = await must(inProcess.handle)(new Request("http://in-process/presets/1"));
      await db.select().from(presets);
      return { inner: inner.status };
    })
    .get("/broken", async () => {
      await db.select().from(presets);
      throw new Broken("broken");
    })
    .get("/hang", async () => {
      await db.select().from(presets);
      await held.wait();
      await db.select().from(presets);
      held.done();
      return "too late";
    })
    .get(UNWRITTEN, () => "served")
    // A status no response can be sent with, which Bun answers with the
    // server's own 500.
    .get("/errored", () => Response.error())
    .ws("/socket", { message: (socket, message) => void socket.send(message) })
    .get("/drip", async function* () {
      yield "drop;";
      await held.wait();
      await db.select().from(presets);
      held.done();
      yield "never read";
    });
  for (let lane = 0; lane < LANES; lane += 1) {
    app.get(`/lanes/${lane}`, async ({ query }) => {
      const connection = await pool.getConnection();
      for (let wait = 0; wait < Number(query.db); wait += 1) await connection.query("select 1");
      connection.release();
      for (let wait = 0; wait < Number(query.store); wait += 1) await store.get(`${prefix}lane`);
      for (let wait = 0; wait < Number(query.out); wait += 1)
        await (await send(outside.url)).text();
      return "done";
    });
  }
  inProcess.handle = (request) => app.handle(request);
  app.listen({ port: 0, hostname: "127.0.0.1" });
  const server = app.server;
  if (server === null) throw new Error("the fixture app did not start");

  const records = recordsFrom(sink.next);

  return {
    url: (path: string) => new URL(path, server.url),
    /** The bare pool beneath, which the overlap property holds a connection of. */
    pool: database.pool,
    nextLine: sink.next,
    nextRecord: records.next,
    /** The faults the app's `fault` wrote among the lines read so far, taken. */
    faults: records.faults,
    held,
    [Symbol.asyncDispose]: async () => {
      await app.stop(true);
      await outside.stop(true);
      redis.close();
      await database[Symbol.asyncDispose]();
    },
  };
}
