/**
 * The house rate limiter, and every way of building it wrong that the
 * conformance suite exists to refuse.
 *
 * The correct one is STACK.md's rule as code: a Redis token bucket, keyed
 * through the fallback chain that starts at `cf-connecting-ip`, refusing when
 * Redis will not answer. It is here rather than in a fixture string because a
 * fixture nobody type-checks is a fixture that stops compiling quietly, and
 * because what a flaw *is* has to be reviewable — each one below is a single
 * decision taken the other way, named for the hole it opens.
 *
 * A limiter with a `flaw` parameter is not a shape any product would ship. It
 * is the shape a mutation table takes when the mutations have to be readable:
 * one implementation, one switch per decision point, so that "this case kills
 * this wrong implementation" is a pairing a reader can check rather than a
 * claim in a report.
 */
import { RedisClient } from "bun";

import type { Decision, Limiter } from "../limiter-conformance.ts";

/**
 * Every way of getting it wrong that the suite names a case for. The value is
 * the flaw, so a fixture reads as the sentence the case has to refuse.
 */
export const FLAWS = [
  "admits-everything",
  "refuses-everything",
  "exempts-an-unkeyed-caller",
  "exempts-an-empty-header",
  "trusts-the-forwarded-header-first",
  "keys-on-every-hop",
  "keeps-the-bucket-in-the-process",
  "reads-then-writes",
  "fails-open",
  "keys-on-the-path",
] as const;

export type Flaw = (typeof FLAWS)[number];

/**
 * Small on purpose. The cap is what the suite discovers by spending it, and
 * every case that spends one pays a Redis round trip per token — so the
 * fixture's tier is the smallest number that still leaves room for a race to
 * be visible.
 */
const CAP = 8;

/** Tokens per second. A window of a minute, the same shape as the house tiers. */
const REFILL = CAP / 60;

/**
 * KEYS[1] = the bucket. ARGV = [cap, refillPerSecond, nowMs]. Returns
 * [allowed, remaining].
 *
 * One script rather than a GET and a SET, which is the whole of what makes the
 * bucket safe under concurrent writers: Redis runs it to completion before any
 * other client is served, so no two racers can both read a bucket that only had
 * one token left.
 */
const ACQUIRE = `
local held = redis.call('HMGET', KEYS[1], 't', 's')
local cap = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens = tonumber(held[1])
local seen = tonumber(held[2])
if tokens == nil then tokens = cap; seen = now end
tokens = math.min(cap, tokens + math.max(0, now - seen) / 1000.0 * refill)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HMSET', KEYS[1], 't', tokens, 's', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / refill * 1000) + 2000)
return {allowed, math.floor(tokens)}
`;

const ADMITTED: Decision = { allowed: true };
const REFUSED: Decision = { allowed: false };

/** The first hop of `x-forwarded-for` — the only part of it no caller downstream wrote. */
function firstHop(forwarded: string | null): string | undefined {
  return forwarded?.split(",", 1)[0];
}

/**
 * The first of these that names somebody. An empty header is *not* a name: it
 * is a header the caller sent to stop the chain, and stopping the chain is the
 * hole the chain exists to close.
 */
function firstNamed(...candidates: readonly (string | null | undefined)[]): string | undefined {
  return candidates.map((each) => each?.trim()).find((each) => each !== undefined && each !== "");
}

/**
 * Which bucket an attempt spends from. `cf-connecting-ip` first because it is
 * the one header the edge stamps and a caller cannot; everything under it
 * collapses whole proxies into one bucket, deliberately — the chain exists to
 * make an unmetered caller unrepresentable, not to be fair.
 */
function clientKey(headers: Headers, socketIp: string | null, flaw: Flaw | undefined): string {
  const cf = headers.get("cf-connecting-ip");
  const forwarded = headers.get("x-forwarded-for");

  if (flaw === "exempts-an-empty-header") {
    // `??` where the chain wants a name: a header that is present and empty
    // stops the chain, and the caller arrives with no key at all.
    return cf ?? firstNamed(firstHop(forwarded), socketIp) ?? "unkeyed";
  }
  if (flaw === "trusts-the-forwarded-header-first") {
    return firstNamed(firstHop(forwarded), cf, socketIp) ?? "unkeyed";
  }
  if (flaw === "keys-on-every-hop") {
    // The whole header, suffix and all — so a caller appending anything at all
    // is a caller with a bucket nobody has spent from.
    return firstNamed(cf, forwarded, socketIp) ?? "unkeyed";
  }
  if (flaw === "exempts-an-unkeyed-caller") {
    return firstNamed(cf, firstHop(forwarded), socketIp) ?? "";
  }
  return firstNamed(cf, firstHop(forwarded), socketIp) ?? "unkeyed";
}

/** A bucket as the flawed in-process variant holds it: tokens, and when they were counted. */
interface Bucket {
  tokens: number;
  seen: number;
}

/**
 * One element of a Redis multi-bulk reply as a number, or nothing where the
 * reply does not hold one. The client types its answers `any`, so this is where
 * they stop being that.
 */
function numberAt(reply: unknown, index: number): number | undefined {
  if (!Array.isArray(reply)) return undefined;
  const held: unknown = reply[index];
  if (typeof held === "number") return held;
  if (typeof held !== "string") return undefined;
  const parsed = Number(held);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The same arithmetic the script does, for the two variants that do it outside Redis. */
function spend(bucket: Bucket, now: number): boolean {
  const tokens = Math.min(CAP, bucket.tokens + (Math.max(0, now - bucket.seen) / 1000) * REFILL);
  const allowed = tokens >= 1;
  bucket.tokens = allowed ? tokens - 1 : tokens;
  bucket.seen = now;
  return allowed;
}

/**
 * The limiter, built the house way or built with one named flaw. Nothing
 * connects until the first attempt, which is what lets a case hand it a Redis
 * that is not there.
 */
export function houseLimiter(redisUrl: string, flaw?: Flaw): Limiter {
  // `maxRetries: 0` is what makes the refusal arrive. Bun's client retries a
  // dead address ten times with backoff before it reports anything, so a
  // limiter that leaves the default on does not fail open — it fails *slow*,
  // holding the request for half a minute, which is the failure the
  // conformance suite's clock is on.
  const client = new RedisClient(redisUrl, { autoReconnect: false, maxRetries: 0 });
  /** Only the in-process variant reads this; a real limiter keeps nothing here. */
  const inProcess = new Map<string, Bucket>();

  return async ({ headers, path, socketIp }) => {
    if (flaw === "admits-everything") return ADMITTED;
    if (flaw === "refuses-everything") return REFUSED;

    // The hole the two exempting flaws open. The chain ends in a sentinel, so a
    // correct key is never empty and this never fires for the house build.
    const caller = clientKey(headers, socketIp, flaw);
    if (caller === "") return ADMITTED;
    // A bucket per route reads as caution and is the absence of a limit: on any
    // API with a path parameter it is a bucket per parameter value.
    const key = flaw === "keys-on-the-path" ? `${path}:${caller}` : caller;

    if (flaw === "keeps-the-bucket-in-the-process") {
      const bucket = inProcess.get(key) ?? { tokens: CAP, seen: Date.now() };
      inProcess.set(key, bucket);
      return { allowed: spend(bucket, Date.now()) };
    }

    try {
      if (flaw === "reads-then-writes") {
        // A read, then a write, with the network in between: every racer reads
        // the same bucket and every one of them thinks it had a token.
        const held: unknown = await client.send("HMGET", [`rl:${key}`, "t", "s"]);
        const bucket: Bucket = {
          tokens: numberAt(held, 0) ?? CAP,
          seen: numberAt(held, 1) ?? Date.now(),
        };
        const allowed = spend(bucket, Date.now());
        await client.send("HMSET", [
          `rl:${key}`,
          "t",
          String(bucket.tokens),
          "s",
          String(bucket.seen),
        ]);
        return { allowed };
      }

      const answer: unknown = await client.send("EVAL", [
        ACQUIRE,
        "1",
        `rl:${key}`,
        String(CAP),
        String(REFILL),
        String(Date.now()),
      ]);
      return { allowed: numberAt(answer, 0) === 1 };
    } catch {
      // The one decision this whole conformance suite exists over. Open, an
      // attacker turns the limiter off by taking the Redis down, at the one
      // moment it is load-bearing.
      return flaw === "fails-open" ? ADMITTED : REFUSED;
    }
  };
}
