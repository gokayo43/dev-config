/**
 * The connector for Bun's own Redis client against a real Redis.
 *
 * Invariant 1, the differential: one scripted sequence run on a bare client
 * and on the wrapped one, each under a key prefix of its own, compared step by
 * step. The bare run is the oracle.
 *
 * What a count includes: what the client sends, run as one operation, against
 * the count the export's page states for it.
 */
import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";

import { rejectionOf } from "../narrowing.ts";
import { timedBunRedis } from "../request-timing-bun-redis.ts";
import { counted, NONE } from "./request-timing-oracle.ts";
import { keyPrefix, REDIS_URL } from "./request-timing-servers.ts";

/** What a step settled with, in a form two runs can be compared by. */
async function outcome(step: () => Promise<unknown>) {
  try {
    return { value: await step() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message };
  }
}

const COUNTER = "return redis.call('incrby', KEYS[1], ARGV[1])";

/** A Bun Redis client of the case's own, closed on disposal. */
function bunRedis() {
  const client = new RedisClient(REDIS_URL);
  return { client, [Symbol.asyncDispose]: async () => client.close() };
}

async function bunScript(client: RedisClient, prefix: string) {
  const key = (name: string) => prefix + name;
  return {
    set: await outcome(() => client.set(key("a"), "1")),
    get: await outcome(() => client.get(key("a"))),
    wrongType: await outcome(() => client.lpush(key("a"), "x")),
    send: await outcome(() => client.send("INCRBY", [key("n"), "2"])),
    eval: await outcome(() => client.send("EVAL", [COUNTER, "1", key("e"), "3"])),
    missing: await outcome(() => client.get(key("absent"))),
  };
}

describe("the Bun Redis connector", () => {
  test("changes nothing its callers see", async () => {
    await using bare = bunRedis();
    await using wrapped = bunRedis();
    const off = await bunScript(bare.client, keyPrefix());
    const on = await counted(() => bunScript(timedBunRedis(wrapped.client), keyPrefix()));
    expect(on.answer).toEqual(off);
    expect(JSON.stringify(off.wrongType)).toContain("WRONGTYPE");
  });

  test("counts each command, `send` and the duplicate it makes as one wait", async () => {
    await using redis = bunRedis();
    const client = timedBunRedis(redis.client);
    const key = keyPrefix();
    const { counts } = await counted(async () => {
      await client.set(key, "1");
      await client.get(key);
      await client.send("INCR", [key]);
      const twin = await client.duplicate();
      await twin.get(key);
      twin.close();
    });
    expect(counts).toEqual({ ...NONE, store: 5 });
  });

  test("counts a command that fails, and a blocking read for as long as it blocked, as one each", async () => {
    await using reader = bunRedis();
    await using writer = bunRedis();
    const client = timedBunRedis(reader.client);
    const key = keyPrefix();
    const { answer, counts } = await counted(async () => {
      const refused = await rejectionOf(client.send("NONSENSE", [key]), Error);
      const popped = client.blpop(key, 5);
      await writer.client.lpush(key, "woken");
      return { refused: refused.message, popped: await popped };
    });
    expect(answer).toMatchObject({ popped: [key, "woken"] });
    expect(counts).toEqual({ ...NONE, store: 2 });
  });

  test("counts a subscription by its reply, and none of its messages", async () => {
    await using listening = bunRedis();
    await using publishing = bunRedis();
    const client = timedBunRedis(listening.client);
    const key = keyPrefix();
    const heard = Promise.withResolvers<string>();
    const { counts } = await counted(async () => {
      await client.subscribe(key, (message) => heard.resolve(message));
      await publishing.client.publish(key, "heard");
      return heard.promise;
    });
    expect(counts).toEqual({ ...NONE, store: 1 });
  });

  test("reads and writes the client's own state on the client", async () => {
    await using redis = bunRedis();
    const client = timedBunRedis(redis.client);
    await client.connect();
    expect(client.connected).toBe(true);
    const closed = Promise.withResolvers<void>();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Bun's client has no `addEventListener`: `onclose` is the one way to hear it close, and writing it through the wrapper is what this case grades
    client.onclose = () => closed.resolve();
    client.close();
    await closed.promise;
    expect(client.connected).toBe(false);
  });
});
