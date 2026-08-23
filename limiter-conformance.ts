/**
 * The conformance suite every repo's rate limiter runs against its own module.
 *
 * STACK.md gives the house one inbound limiter — a Redis token bucket keyed on
 * `cf-connecting-ip` with a fallback chain below it — and until this file
 * existed that rule was prose pointing at one repo's implementation. Prose
 * cannot say whether a limiter still holds after a refactor, and this is the
 * fleet's only live-traffic security surface, so the rule is executable here
 * and every repo that ships a limiter imports it.
 *
 * ## What is being asserted
 *
 * One sentence: **no request shape is exempt from metering, no caller's budget
 * is anyone else's, and a limiter that cannot reach its Redis refuses.**
 * Everything below is a way of failing that.
 *
 * The header chain is what makes the first clause hard. `cf-connecting-ip` is
 * trustworthy at the origin because Cloudflare sets it and the origin takes no
 * traffic that did not come through Cloudflare; every header under it in the
 * chain is one the caller can write. So a limiter has to be built the way the
 * fallbacks are meant: not to be fair to callers behind a shared proxy — they
 * deliberately collapse into one bucket — but to make an *unmetered* caller
 * unrepresentable. A caller who omits every header, empties one, or forges the
 * parts nobody upstream stamps must still land in some bucket, and must not be
 * able to move himself out of a bucket he has emptied.
 *
 * ## The state, and what races over it
 *
 * A token bucket is a read-modify-write over a value shared by every request
 * from one caller and by every process serving them. Its invariants:
 *
 * - **A bucket is a state, not an event stream.** Two readers of one key
 *   subtract to the same number of tokens; nothing depends on the order two
 *   unrelated callers arrived in.
 * - **Legal transitions**: a bucket refills toward its cap with time and loses
 *   exactly one token per admitted attempt. It never exceeds its cap and never
 *   drops below zero.
 * - **Never representable**: more admitted attempts against one key, inside one
 *   refill window, than the cap. That is what a concurrent read-then-write
 *   produces — every racer reads a full bucket — and it is why the house
 *   implementation is one Lua script rather than a GET and a SET. The suite
 *   drives it with genuinely overlapping attempts and proves the overlap
 *   happened, because a race test whose requests never interleave passes
 *   against exactly the code it exists to fail.
 * - **A crash midway** loses nothing a caller can observe: the script is
 *   atomic, so a bucket is either advanced or untouched. What a crash between
 *   the write and its expiry leaks is a key that outlives its window, which no
 *   caller can see and this suite therefore does not claim to grade.
 * - **Retry and replay** are not invariants here. Every attempt spends a token
 *   by design; a limiter that deduplicated retries would be metering something
 *   other than requests.
 *
 * ## What the caller supplies
 *
 * A factory rather than a limiter, because two of the cases need a *second*
 * instance — one against a Redis that is gone, one against the same Redis as
 * the first — and a limiter already bound to a connection cannot answer either.
 *
 * The Redis it names is flushed between cases, so it must be a throwaway: point
 * this at a container the suite owns, never at anything a person's data is in.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";

/** One inbound request, as much of it as a limiter is allowed to see. */
export interface Attempt {
  readonly headers: Headers;
  readonly path: string;
  /** The peer address of the socket, or nothing where the server cannot say. */
  readonly socketIp: string | null;
}

/**
 * What the limiter decided. A decision and not a throw: a limiter whose Redis
 * is gone still has to answer, because a caller that cannot tell "refused" from
 * "crashed" has no refusal to act on.
 */
export interface Decision {
  readonly allowed: boolean;
}

export type Limiter = (attempt: Attempt) => Promise<Decision>;

/** The repo's limiter, and the two facts about it only the repo can state. */
export interface Subject {
  /** Builds the limiter against the Redis at this URL, connecting no earlier than its first attempt. */
  readonly make: (redisUrl: string) => Limiter;
  /** A throwaway Redis. **The suite flushes it between cases.** */
  readonly redisUrl: string;
  /** A path this limiter meters — an exempt one would pass every case below vacuously. */
  readonly metered: string;
}

/**
 * How many attempts a case will make before deciding the limiter is not one.
 * It is a bound on the suite's own patience rather than a claim about any
 * repo's cap: the house tiers are tens, and a limiter that has admitted five
 * hundred attempts from one caller inside a few hundred milliseconds is not
 * metering.
 */
const BOUND = 500;

/**
 * How long a refusal has to take. A limiter is on the request hot path, so a
 * decision that arrives in seconds is a stalled request rather than a refused
 * one — and "fails slow" is what a client left on its default reconnect budget
 * does instead of failing closed.
 */
const REFUSAL_ARRIVES_WITHIN = 2_000;

/** The headers and socket a case is arriving with, named rather than assembled at each site. */
interface Caller {
  /** `cf-connecting-ip`, the one header the edge stamps and the caller cannot. */
  readonly cf?: string;
  /** `x-forwarded-for`, every hop of it — the caller writes all but the last. */
  readonly forwarded?: string;
  /** What the server's own socket says, where it says anything. */
  readonly socketIp?: string;
}

function arriving(path: string, { cf, forwarded, socketIp }: Caller): Attempt {
  const headers = new Headers();
  if (cf !== undefined) headers.set("cf-connecting-ip", cf);
  if (forwarded !== undefined) headers.set("x-forwarded-for", forwarded);
  return { headers, path, socketIp: socketIp ?? null };
}

/**
 * How many attempts were admitted before the first refusal, giving up at the
 * bound. The attempt is built per call rather than reused, so that a case can
 * vary the part of the request it is claiming buys nothing.
 */
async function untilRefused(limiter: Limiter, next: (made: number) => Attempt): Promise<number> {
  for (let made = 0; made < BOUND; made++) {
    const { allowed } = await limiter(next(made));
    if (!allowed) return made;
  }
  return BOUND;
}

async function admits(limiter: Limiter, attempt: Attempt): Promise<boolean> {
  return (await limiter(attempt)).allowed;
}

async function flush(redisUrl: string): Promise<void> {
  const client = new RedisClient(redisUrl);
  try {
    await client.send("FLUSHDB", []);
  } finally {
    client.close();
  }
}

/**
 * A Redis URL nothing is listening on, proven by having just stopped listening
 * on it. A hardcoded port would be a guess about the machine; a routable
 * address nothing answers on would hang instead of refusing, and a limiter that
 * hangs is a different defect from one that fails open.
 */
async function unreachable(): Promise<string> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const { port } = server;
  await server.stop(true);
  return `redis://127.0.0.1:${port}`;
}

/** When one attempt was in flight, for the proof that a race test actually raced. */
interface Span {
  readonly started: number;
  readonly ended: number;
}

/** The most attempts that were ever in flight at once. One means nothing overlapped. */
function peakOverlap(spans: readonly Span[]): number {
  const edges = spans.flatMap(({ started, ended }) => [
    { at: started, delta: 1 },
    { at: ended, delta: -1 },
  ]);
  // An end sorts before a start at the same instant, so two attempts that
  // merely touched are not counted as having overlapped.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let inFlight = 0;
  let peak = 0;
  for (const { delta } of edges) {
    inFlight += delta;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

/**
 * Registers the suite. Called at the top level of the repo's own test file,
 * which is the whole of what a repo writes:
 *
 * ```ts
 * conformsAsLimiter({ make: limiterOn, redisUrl: THROWAWAY, metered: "/api/summoner/x" });
 * ```
 */
export function conformsAsLimiter({ make, redisUrl, metered }: Subject): void {
  const at = (caller: Caller): Attempt => arriving(metered, caller);

  describe("as a rate limiter", () => {
    let limiter: Limiter;
    /** What one caller gets on this path, measured rather than declared. */
    let cap = 0;

    beforeAll(async () => {
      limiter = make(redisUrl);
      await flush(redisUrl);
      cap = await untilRefused(limiter, () => at({ cf: "203.0.113.1" }));
    });

    // The floor under every case below. A limiter that admits everything passes
    // "still limited" vacuously, and one that refuses everything passes it for
    // the wrong reason — so the first thing asserted is that there is a budget,
    // and that it is somebody's rather than everybody's.
    test("a caller has a budget, and it runs out", () => {
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThan(BOUND);
    });

    test("a second caller has a budget of its own", async () => {
      await flush(redisUrl);
      await untilRefused(limiter, () => at({ cf: "203.0.113.2" }));
      expect(await admits(limiter, at({ cf: "203.0.113.3" }))).toBe(true);
    });

    // A bucket that lives in the process is a bucket per container, and the
    // deployed shape is more than one. Nothing else here can tell the two
    // apart: an in-memory limiter satisfies every keying case.
    test("a second instance against the same Redis shares the budget", async () => {
      await flush(redisUrl);
      const alongside = make(redisUrl);
      await untilRefused(limiter, () => at({ cf: "203.0.113.8" }));
      expect(await admits(alongside, at({ cf: "203.0.113.8" }))).toBe(false);
    });

    describe("no request shape is exempt", () => {
      // The bottom of the fallback chain: nothing to key on at all. Whatever
      // bucket this lands in, it is a bucket.
      test("a caller sending no headers, from a socket nobody named, is metered", async () => {
        await flush(redisUrl);
        expect(await untilRefused(limiter, () => at({}))).toBeLessThan(BOUND);
      });

      test("a caller the socket can name is metered", async () => {
        await flush(redisUrl);
        expect(await untilRefused(limiter, () => at({ socketIp: "203.0.113.4" }))).toBeLessThan(
          BOUND,
        );
      });

      // `headers.get()` returning "" is the shape that turns a `??` chain into
      // an exemption: the header is present, so the fallback never runs, and
      // the empty string is falsy enough for the next line to wave it through.
      test.each(["cf", "forwarded"] as const)(
        "an empty %s header is a value, not an exemption",
        async (which) => {
          await flush(redisUrl);
          expect(await untilRefused(limiter, () => at({ [which]: "" }))).toBeLessThan(BOUND);
        },
      );
    });

    describe("a caller cannot leave a bucket he has emptied", () => {
      // Everything after the first hop of x-forwarded-for is written by the
      // caller. A limiter keying on the whole header hands out a fresh budget
      // per suffix, which is an unlimited budget.
      test("junk beyond the first hop of x-forwarded-for buys nothing", async () => {
        await flush(redisUrl);
        await untilRefused(limiter, (made) => at({ forwarded: `198.51.100.7, hop-${made}` }));
        expect(await admits(limiter, at({ forwarded: "198.51.100.7, someone-else" }))).toBe(false);
      });

      // The chain has an order for a reason. A limiter reading the
      // caller-written header first is one where every caller behind the edge
      // writes his own key.
      test("a header the caller controls cannot override the one the edge stamps", async () => {
        await flush(redisUrl);
        await untilRefused(limiter, (made) =>
          at({ cf: "203.0.113.5", forwarded: `10.0.0.${made % 250}` }),
        );
        expect(await admits(limiter, at({ cf: "203.0.113.5", forwarded: "10.0.0.251" }))).toBe(
          false,
        );
      });
    });

    // Fail closed. A limiter that waves traffic through when its Redis is gone
    // is a limiter an attacker turns off by taking the Redis down, which is the
    // one moment it is load-bearing. Three attempts rather than one, so that a
    // limiter refusing only the first and then latching open is caught.
    //
    // On a clock, because the third way to get this wrong is to answer
    // eventually: a client left on its default reconnect budget retries a dead
    // address for half a minute before it reports anything, and a limiter that
    // holds the request that long has not refused it. The bound is three orders
    // of magnitude above a refused connection to a local port, so what it fails
    // is a hang and never a slow machine.
    test(
      "a limiter whose Redis is gone refuses",
      async () => {
        const stranded = make(await unreachable());
        for (let made = 0; made < 3; made++) {
          expect(await admits(stranded, at({ cf: "203.0.113.6" }))).toBe(false);
        }
      },
      REFUSAL_ARRIVES_WITHIN,
    );

    // The race the Lua script exists for. Every attempt is launched before any
    // has answered, and the overlap is asserted rather than assumed.
    test("attempts racing on one key never over-admit", async () => {
      await flush(redisUrl);
      const spans: Span[] = [];
      const decisions = await Promise.all(
        Array.from({ length: cap * 2 }, async () => {
          const started = performance.now();
          const allowed = await admits(limiter, at({ cf: "203.0.113.7" }));
          spans.push({ started, ended: performance.now() });
          return allowed;
        }),
      );
      const admitted = decisions.filter(Boolean).length;
      expect(peakOverlap(spans)).toBeGreaterThan(1);
      expect(admitted).toBeGreaterThan(0);
      expect(admitted).toBeLessThanOrEqual(cap);
    });
  });
}
