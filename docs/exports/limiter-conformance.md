# The rate-limiter conformance suite

`@gokayo43/dev-config/limiter-conformance.ts` exports `conformsAsLimiter`, a
`describe` block a repo registers against its own rate limiter.

STACK.md gives the house one inbound limiter — a Redis token bucket keyed on
`cf-connecting-ip` with a fallback chain under it — and this is the fleet's only
live-traffic security surface. Until this file existed that rule was prose
pointing at one repo's implementation, and prose cannot say whether a limiter
still holds after a refactor.

```ts
import { conformsAsLimiter } from "@gokayo43/dev-config/limiter-conformance.ts";
import { limiterOn } from "../src/http/ratelimit.ts";

const REDIS_URL = process.env["TEST_REDIS_URL"];
if (REDIS_URL === undefined) {
  throw new Error(
    "TEST_REDIS_URL is not set — this suite flushes the Redis it is given, so it will not guess at one",
  );
}

conformsAsLimiter({
  make: limiterOn,
  redisUrl: REDIS_URL,
  metered: ["/api/summoner/one", "/api/summoner/two"],
});
```

- `make(redisUrl)` builds the limiter against that Redis, connecting no earlier
  than its first attempt. A factory rather than a limiter, because two cases need
  a _second_ instance: one against a Redis that is gone, one against the same
  Redis as the first.
- `redisUrl` is **flushed between cases**. Point it at a throwaway, and read it
  from an environment variable that is _refused_ when unset rather than
  defaulted to `localhost:6379` — a default address is how a suite wipes a Redis
  that four stacks on one box were sharing.
- `metered` is a path the limiter meters. An exempt one would pass every case
  vacuously, which is what the first case is there to catch.

The limiter itself is `(attempt: Attempt) => Promise<Decision>` — headers, path
and socket address in, `{ allowed }` out. A repo whose limiter is an Elysia
`onRequest` plugin writes the two lines that adapt it; the conformance interface
is deliberately about the decision rather than about a framework.

## What it asserts

One sentence: **no request shape is exempt from metering, no caller's budget is
anyone else's, and a limiter that cannot reach its Redis refuses.**

| Case                                                          | The wrong implementation it kills                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| a caller has a budget, and it runs out                        | one that meters nothing — the floor under everything below                               |
| a second caller has a budget of its own                       | one that refuses everything, which passes "still limited" for the wrong reason           |
| a second instance against the same Redis shares the budget    | a bucket kept in the process: a bucket per container, and the deployed shape has several |
| a caller sending no headers, from a socket nobody named       | `if (!ip) return allow` — the exemption at the bottom of the chain                       |
| an empty `cf-connecting-ip` or `x-forwarded-for`              | a `??` chain where the code wanted a name: a present-and-empty header stops it           |
| junk beyond the first hop of `x-forwarded-for`                | keying on the whole header, which is a fresh budget per suffix the caller invents        |
| a caller-controlled header cannot override the edge's         | reading `x-forwarded-for` before `cf-connecting-ip`                                      |
| a limiter whose Redis is gone refuses, **within two seconds** | `catch → allow`, and `catch → eventually` (below)                                        |
| attempts racing on one key never over-admit                   | a GET then a SET: every racer reads a bucket that had a token                            |

## Failing closed is on a clock

A limiter runs on the request hot path, so a decision that arrives in seconds is
a stalled request rather than a refused one. There is a third way to get this
wrong beside open and closed, and it is the easy one to ship: a client left on
its default reconnect budget answers _eventually_. Bun's `RedisClient` retries a
dead address ten times with backoff — about half a minute, measured — and
`ioredis`, which the fleet's one live limiter uses, queues commands offline and
retries by default too. So the knob is per client and both have one:

| client              | what to set                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Bun's `RedisClient` | `maxRetries: 0` (with `autoReconnect: false`), or a small budget under a timeout                     |
| `ioredis`           | `maxRetriesPerRequest: 0` (or a small number) and `enableOfflineQueue: false`, plus `connectTimeout` |

This suite gives the refusal two seconds — three orders of
magnitude more than a refused connection to a local port needs, so what it fails
is a hang and never a slow machine.

The decision is also a decision and not a throw: a caller that cannot tell
"refused" from "crashed" has no refusal to act on.

## What the fallback chain is for

`cf-connecting-ip` is trustworthy at the origin because Cloudflare sets it and
the origin takes no traffic that did not come through Cloudflare. Every header
under it in the chain is one the caller can write.

So the chain is not there to be fair to callers behind a shared proxy — those
collapse into one bucket, deliberately. It is there to make an **unmetered**
caller unrepresentable. A caller who omits every header, empties one, or forges
the parts nobody upstream stamps must still land in some bucket, and must not be
able to move himself out of one he has emptied. Every "still limited" case above
is one way of trying.

## Races, and what is out of reach

A token bucket is a read-modify-write over a value shared by every request from
one caller and by every process serving them. The state that must never be
representable is more admitted attempts against one key, inside one refill
window, than the cap — which is exactly what a concurrent read-then-write
produces, and why the house implementation is one Lua script rather than a GET
and a SET. The suite drives it with genuinely overlapping attempts and **proves the overlap
happened**.

What that proof is about is worth being exact on: it says the attempts were in
flight together — a fact about this harness, and the thing a race test silently
loses when its requests turn out to have been sequential. It says nothing about
whether the limiter serialised them internally, and it does not need to: a
limiter that funnels every attempt through one connection has still been raced
from the caller's side, which is the side an over-admit would arrive from. The
invariant under test is the admitted count.

Two things it does not claim to grade. A crash between the bucket's write and its
expiry leaks a key that outlives its window — atomic as far as any caller can
see, and invisible through this interface. And retry and replay are not
invariants here at all: every attempt spends a token by design, and a limiter
that deduplicated retries would be metering something other than requests.
