import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { constantFrom, integer, nat, property, tuple } from "fast-check";

import type { Route, RouteLog } from "../route-log.ts";
import { allowlistFrom } from "../.github/actions/_lib/gate.ts";
import {
  type Attempt,
  attemptFor,
  budgetFor,
  CLASSES,
  curlFor,
  fuzz,
  type Fuzzed,
  fuzzVerdict,
  INVARIANTS,
  requestFor,
  seedFrom,
} from "../.github/actions/db-gate/fuzz.ts";
import { routeCoverage } from "../.github/actions/db-gate/route-coverage.ts";
import { check } from "../property.ts";
import { containing } from "./matchers.ts";

/**
 * The fuzzer, against an app that answers the way apps answer: one route that
 * falls over on an input nobody bounded, one that leaks its own stack, one that
 * stops answering, one that lies about its content type, and two that are
 * simply correct — including the one that matters most, the route that
 * *refuses* junk properly, since a fuzzer reporting a 400 reports every route
 * in every app and is switched off inside a week.
 *
 * A real server on a real port rather than a stubbed `fetch`: every one of the
 * four invariants is a statement about a response — a status, a header, a body,
 * and a socket that never answered — and a fake would be this suite asserting
 * against its own idea of each of them.
 */

// A case that drives the fuzzer spends its budget and then some — the request
// that was in flight when the budget ran out still has its bound to use. Under
// a five-second default that is a fourfold margin, which is not one on a box
// that also serves four stacks and every other repo's CI. The same 30s the two
// suites that spawn a process tree take, for the same reason.
setDefaultTimeout(30_000);

const OK: Route = { method: "GET", path: "/ok/:id" };
const CAREFUL: Route = { method: "POST", path: "/careful/:id" };
const STRICT: Route = { method: "POST", path: "/strict/:id" };
const TRACING: Route = { method: "GET", path: "/trace" };
const LYING: Route = { method: "GET", path: "/lying-json" };

/** The route that never answers, kept out of the cases that would only wait for it. */
const HANGING: Route = { method: "GET", path: "/hang" };

const ROUTES: readonly Route[] = [OK, CAREFUL, STRICT, TRACING, LYING];

/** A stack trace as a runtime writes one, which is what a handler leaks when it answers with its own error. */
const TRACE = [
  "TypeError: Cannot read properties of undefined (reading 'name')",
  "    at handler (/srv/app/src/routes/things.ts:41:19)",
  "    at Server.fetch (/srv/app/node_modules/elysia/dist/index.js:8:3)",
].join("\n");

/** One request as the server received it, which is what a replay has to reproduce. */
interface Received {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly type: string | null;
  readonly length: number;
}

interface App extends Disposable {
  readonly origin: string;
  /** How many requests each route has taken, which is what a route log reports. */
  hits: () => Map<string, number>;
  /** Every request, in order, so a `curl` can be compared with the `fetch` before it. */
  received: () => Received[];
}

/**
 * The app, on a port nobody chose. Every route is deliberate: `/strict/:id` is
 * the handler that assumes its parameter parses and `/careful/:id` is the same
 * handler written properly, and the difference between what the fuzzer says
 * about the two is the whole of what it is for.
 */
function serving(): App {
  const hits = new Map<string, number>();
  const took = (path: string): void => void hits.set(path, (hits.get(path) ?? 0) + 1);
  const received: Received[] = [];
  const WHOLE = /^[1-9]\d*$/u;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const [, first = "", second = ""] = url.pathname.split("/");
      received.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        type: request.headers.get("content-type"),
        length: (await request.arrayBuffer()).byteLength,
      });

      if (first === "hang") {
        took(HANGING.path);
        // Never resolves, and holds no timer while not resolving: a suite that
        // waits by the clock is what the lint rules over this file refuse.
        return new Promise<Response>(() => {});
      }
      if (first === "trace") {
        took(TRACING.path);
        return new Response(TRACE, { status: 200 });
      }
      if (first === "lying-json") {
        took(LYING.path);
        return new Response("<html>gateway timeout</html>", {
          headers: { "content-type": "application/json" },
        });
      }
      if (first === "strict") {
        took(STRICT.path);
        // The handler nobody bounded: anything that is not a plain positive
        // integer reaches code that cannot cope, and the caller is told so with
        // the one status that means the fault is the app's.
        return WHOLE.test(second)
          ? Response.json({ id: Number(second) })
          : new Response("something went wrong", { status: 500 });
      }
      if (first === "careful") {
        took(CAREFUL.path);
        // The refusal names its own error type and points at a file, which is
        // what a good 400 does and what the first version of the trace matcher
        // read as a leaked stack trace — on every single request.
        return WHOLE.test(second)
          ? Response.json({ id: Number(second) })
          : Response.json(
              { error: "Error: id must be a positive integer — see package.json" },
              { status: 400 },
            );
      }
      took(OK.path);
      return Response.json({ ok: true });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    hits: () => new Map(hits),
    received: () => [...received],
    [Symbol.dispose](): void {
      // Not awaited, and that is the whole of why this fixture is `Disposable`
      // rather than async: `stop(true)` closes the listener at once and answers
      // a promise that settles when the last connection has drained, which for
      // a handler holding a promise that never resolves is never (probed, bun
      // 1.4.0). Awaiting it hangs the case that proves the fuzzer reports a
      // route which stopped answering.
      void server.stop(true);
    },
  };
}

/** Long enough for several rounds over the table, short enough that the suite is not a wait. */
const BUDGET_MS = 900;

/** Long enough that only a route which never answers reaches it. */
const BOUND_MS = 250;

async function fuzzing(
  app: App,
  routes: readonly Route[],
  seed = 1,
  waived: ReadonlySet<string> = new Set(),
): Promise<Fuzzed> {
  return await fuzz({
    origin: app.origin,
    routes,
    waived,
    seed,
    budgetMs: BUDGET_MS,
    boundMs: BOUND_MS,
  });
}

/** What a run said about one route, which is what each case below is about. */
function against(result: Fuzzed, route: Route): string[] {
  return result.failures.filter((failure) => failure.path === route.path).map(({ broke }) => broke);
}

/** A route as a generator draws one, over every shape a router registers. */
const routeOf = tuple(
  constantFrom("GET", "POST", "PUT", "DELETE", "ALL"),
  constantFrom("/things", "/things/:id", "/things/:id/parts/:part", "/*", "/a-b_c.d"),
).map(([method, path]): Route => ({ method, path }));

const seedOf = integer({ min: 0, max: 4_294_967_295 });

/** Everything a shell cannot be handed on one line: the C0 range, and delete. */
// oxlint-disable-next-line no-control-regex -- the control characters are the subject: what this asks of a generated request is that not one of them is in it
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** Whether every byte is one a reader can paste back into a shell, on one line. */
function printable(text: string): boolean {
  return !CONTROL.test(text);
}

/** Everything a request puts on the wire, plus the command that sends it again. */
function everythingIn(attempt: Attempt): string[] {
  return [
    attempt.url,
    ...Object.values(attempt.headers),
    attempt.body?.text ?? "",
    curlFor(attempt),
  ];
}

describe("what the fuzzer sends", () => {
  // The seed is printed so that a failure can be sent again. A generator
  // reading a clock, a counter or `Math.random` would print a seed that
  // reproduces nothing, and every failure it ever found would be an anecdote.
  test("the same seed, route and position produce the same request", () => {
    check(
      property(routeOf, seedOf, nat({ max: 500 }), (route, seed, at) => {
        expect(attemptFor("http://app", route, seed, at)).toEqual(
          attemptFor("http://app", route, seed, at),
        );
      }),
    );
  });

  // The other half, and the one a seed nobody reads would pass: a generator
  // that ignores its seed is perfectly reproducible and searches one point of
  // the domain forever.
  test("a different seed searches somewhere else", () => {
    const sent = (seed: number): string[] =>
      Array.from({ length: 40 }, (_, at) => curlFor(attemptFor("http://app", STRICT, seed, at)));
    expect(sent(1)).not.toEqual(sent(2));
  });

  // Per-route streams, so that adding a route to an app does not change what
  // every other route is asked — which is what makes a seed from last week
  // worth pasting into this week's run.
  test("each route draws from a stream of its own", () => {
    const first = attemptFor("http://app", { method: "GET", path: "/a/:id" }, 9, 0);
    const second = attemptFor("http://app", { method: "GET", path: "/b/:id" }, 9, 0);
    expect(first.url).not.toEqual(second.url.replace("/b/", "/a/"));
  });

  // A newline in a body or a URL is two lines of shell and half an annotation,
  // and the reader of a failure gets neither of them back.
  test("every byte of every request is printable and on one line", () => {
    check(
      property(routeOf, seedOf, nat({ max: 200 }), (route, seed, at) => {
        for (const text of everythingIn(attemptFor("http://app", route, seed, at))) {
          expect(printable(text)).toBe(true);
        }
      }),
    );
  });

  // A parameter left in the URL is a request to a route that does not exist,
  // and a table of them is a fuzzer that only ever tests the 404 handler.
  test("every parameter in the template is replaced by a generated value", () => {
    check(
      property(routeOf, seedOf, nat({ max: 200 }), (route, seed, at) => {
        const { pathname } = new URL(attemptFor("http://app", route, seed, at).url);
        expect(pathname).not.toContain("/:");
        // The catch-all cannot be asked the same way round: a generated value
        // may itself be `*`, and `encodeURIComponent` leaves that character
        // alone. What holds for both is the shape — a substitution never adds
        // or drops a segment, whatever it put in one.
        expect(pathname.split("/")).toHaveLength(route.path.split("/").length);
      }),
    );
  });

  // The other half of the same invariant, and the one a substitution with a
  // constant would pass: what goes into the parameter has to move.
  test("and what it is replaced with moves from position to position", () => {
    const drawn = new Set(
      Array.from(
        { length: 40 },
        (_, at) => new URL(attemptFor("http://app", STRICT, 7, at).url).pathname,
      ),
    );
    expect(drawn.size).toBeGreaterThan(5);
  });

  // A route registered for every method is a handler nobody has ever sent a
  // DELETE to, so the fuzzer picks; a route that registered one method is asked
  // with that one, since anything else measures the router's 405.
  test("a route registered for every method is asked with more than one", () => {
    const drawn = (route: Route): Set<string> =>
      new Set(Array.from({ length: 60 }, (_, at) => attemptFor("http://app", route, 3, at).method));
    expect(drawn({ method: "ALL", path: "/anything" }).size).toBeGreaterThan(1);
    expect(drawn(TRACING)).toEqual(new Set(["GET"]));
  });

  // `fetch` refuses to construct a GET or a HEAD carrying a body, so the
  // generator draws none for those methods — the alternative is a run that dies
  // on its own request rather than on the app's answer. docs/gates/fuzz.md says
  // what that costs.
  test("no body is drawn for a method that cannot carry one", () => {
    check(
      property(nat({ max: 200 }), (at) => {
        expect(attemptFor("http://app", OK, 5, at).body).toBeUndefined();
      }),
    );
  });

  // The megabyte is the point of that class, and a megabyte of shell is not
  // something anybody pastes: the command has to rebuild the body rather than
  // spell it out.
  test("a body too big to paste is written as a command that rebuilds it", () => {
    const huge = Array.from({ length: 200 }, (_, at) =>
      attemptFor("http://app", STRICT, 11, at),
    ).find(({ body }) => (body?.text.length ?? 0) > 1_000_000);
    expect(huge).toBeDefined();
    expect(curlFor(huge ?? attemptFor("http://app", STRICT, 11, 0))).toContain("head -c 1048576");
  });

  // And the rule that class exists to satisfy, held over the whole table rather
  // than over the one member that needed it: a failure is reported as one
  // annotation, and an annotation GitHub will not render is a failure nobody
  // reads. A body class that grows past this and adds no shell recipe fails
  // here, which is why the module has no fallback for one.
  test("and every replay command is short enough to be an annotation", () => {
    check(
      property(routeOf, seedOf, nat({ max: 200 }), (route, seed, at) => {
        expect(curlFor(attemptFor("http://app", route, seed, at)).length).toBeLessThan(16_384);
      }),
    );
  });
});

describe("the command a failure hands back", () => {
  /** Every class the tables declare, which is what "one per class" is counted against. */
  const DECLARED = Object.values(CLASSES).flat();

  /** One attempt per class, found by drawing until each has been seen once. */
  function perClass(origin: string): Map<string, Attempt> {
    const found = new Map<string, Attempt>();
    for (let at = 0; at < 600 && found.size < DECLARED.length; at++) {
      for (const route of [OK, STRICT]) {
        const attempt = attemptFor(origin, route, 3, at);
        for (const named of attempt.drawn) if (!found.has(named)) found.set(named, attempt);
      }
    }
    return found;
  }

  async function shell(command: string): Promise<{ status: number; said: string }> {
    const proc = Bun.spawn(["bash", "-c", `${command} -sS -o /dev/null`], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const said = await new Response(proc.stderr).text();
    return { status: await proc.exited, said };
  }

  // The case the printed command never had. Every class is drawn, sent as the
  // fuzzer sends it, and then sent again by pasting what the report prints —
  // and the two have to arrive as the same request. Before this, 56 of 300
  // printed commands did not run at all: the megabyte body was expanded into a
  // single argv string past the 128 KiB the kernel allows, and every query
  // shaped like a structure was read by curl as a glob.
  test("runs, and arrives as the request it was printed for", async () => {
    using app = serving();
    const drawn = perClass(app.origin);
    expect([...drawn.keys()].toSorted()).toEqual(DECLARED.toSorted());

    for (const [named, attempt] of drawn) {
      const at = app.received().length;
      await fetch(attempt.url, requestFor(attempt, BOUND_MS));
      const { status, said } = await shell(curlFor(attempt));
      expect(`${named}: ${status} ${said}`).toBe(`${named}: 0 `);
      const [sent, replayed] = app.received().slice(at);
      expect(`${named}: ${JSON.stringify(replayed)}`).toBe(`${named}: ${JSON.stringify(sent)}`);
    }
  });
});

describe("what the fuzzer refuses", () => {
  test("a handler that falls over on a parameter it did not bound", async () => {
    using app = serving();
    expect(against(await fuzzing(app, ROUTES), STRICT)).toContainEqual(containing("answered 500"));
  });

  // The case that decides whether this gate is usable at all: junk refused with
  // a 400 is the app working. A gate that graded any non-2xx would report every
  // route of every app that validates.
  test("but not the same handler written properly, which refuses the same junk", async () => {
    using app = serving();
    const result = await fuzzing(app, ROUTES);
    expect(against(result, CAREFUL)).toEqual([]);
    expect(against(result, OK)).toEqual([]);
  });

  test("a handler that answers with its own stack trace", async () => {
    using app = serving();
    expect(against(await fuzzing(app, ROUTES), TRACING)).toContainEqual(
      containing("no stack trace in the body"),
    );
  });

  // The other half of that invariant, and the one that decides whether the gate
  // is usable: `/careful` refuses junk with a 400 whose body says
  // `Error: … package.json`. Read as a leak, that is every correct API failing
  // on every request — which is what the `Error:`-beside-a-filename heuristic
  // did before a frame line was required.
  test("but not a correct refusal that names an error type and a file", async () => {
    using app = serving();
    expect(against(await fuzzing(app, ROUTES), CAREFUL)).toEqual([]);
  });

  test("a route that says JSON and sends something else", async () => {
    using app = serving();
    expect(against(await fuzzing(app, ROUTES), LYING)).toContainEqual(containing("not JSON"));
  });

  test("a route that stops answering at all", async () => {
    using app = serving();
    expect(against(await fuzzing(app, [HANGING, ...ROUTES]), HANGING)).toContainEqual(
      containing("nothing arrived within"),
    );
  });

  // Round-robin, and this is what it buys: a route that eats the budget cannot
  // keep the routes after it in the table from being fuzzed at all. Route by
  // route, everything below `/hang` here would never be reached.
  test("and a route that eats the budget does not starve the rest", async () => {
    using app = serving();
    await fuzzing(app, [HANGING, ...ROUTES]);
    const hits = app.hits();
    for (const { path } of ROUTES) expect(hits.get(path) ?? 0).toBeGreaterThan(0);
  });

  test("a clean app is a clean run that still records its seed", async () => {
    using app = serving();
    const result = await fuzzing(app, [OK], 4242);
    expect(result.failures).toEqual([]);
    expect(result.stopped).toBe(false);
    expect(result.requests).toBeGreaterThan(0);
    expect(fuzzVerdict(result).table).toContain("4242");
  });

  // What is kept and what is printed are two numbers on purpose. An app broken
  // everywhere produces thousands: annotating all of them reports nothing
  // readable, and keeping only what is annotated would answer "how bad is it"
  // with the size of the cap — which is what the artifact said before, while
  // three surfaces called it every failure.
  test("keeps every failure it found and prints the first twenty-five", async () => {
    using app = serving();
    const result = await fuzzing(app, [STRICT]);
    expect(result.failures.length).toBeGreaterThan(25);
    const { problems } = fuzzVerdict(result);
    expect(problems.filter(({ message }) => message.includes("replay it with:"))).toHaveLength(25);
    expect(problems.map(({ message }) => message)).toContainEqual(
      containing(`${result.failures.length} requests broke an invariant`),
    );
  });

  // And it stops rather than spending ten nightly minutes collecting copies of
  // one bug — which at four thousand requests a second is also gigabytes of
  // them held on the way to the artifact. The run says it stopped, so the
  // number is never read as "and no more than these".
  test("and stops once an app has failed enough to have been answered", async () => {
    using app = serving();
    const result = await fuzzing(app, [STRICT]);
    expect(result.stopped).toBe(true);
    expect(fuzzVerdict(result).problems.map(({ message }) => message)).toContainEqual(
      containing(`stopped at ${result.failures.length} failures`),
    );
  });

  // The ramp's exemption is this step's exemption, read from the same input: a
  // route a repo declared destructive, credentialed or outbound is not one to
  // send generated DELETEs at. What it costs is stated rather than silent — a
  // table saying "5 routes fuzzed" over an app serving six is the shape of a
  // floor quietly covering less than it claims.
  test("a route the ramp was told not to reach is not fuzzed either", async () => {
    using app = serving();
    const result = await fuzzing(app, ROUTES, 1, new Set(["POST /strict/:id"]));
    expect(app.hits().get(STRICT.path)).toBeUndefined();
    expect(result.routes).toBe(ROUTES.length - 1);
    expect(result.waived).toBe(1);
    expect(fuzzVerdict(result).table).toContain("| Routes waived by route-allowlist | 1 |");
  });

  // Every route waived, which is a repo that has argued each of them out of the
  // ramp by name. Nothing to send is not a failure, and it is not a silence
  // either.
  test("and a table that is entirely waived is a run with nothing to send", async () => {
    using app = serving();
    const result = await fuzzing(app, [OK], 1, new Set(["GET /ok/:id"]));
    expect(result.requests).toBe(0);
    expect(result.routes).toBe(0);
    expect(fuzzVerdict(result).problems).toEqual([]);
  });

  test("a failure carries the command that sends it again", async () => {
    using app = serving();
    const result = await fuzzing(app, [STRICT]);
    const [first] = result.failures;
    expect(first?.curl).toContain("-X POST");
    expect(first?.status).toBe(500);
    expect(first?.body).toContain("something went wrong");
    expect(fuzzVerdict(result).problems[0]?.message).toContain(first?.curl ?? "");
  });
});

describe("what the fuzzer must not disturb", () => {
  /** The route log as the ramp step captures it: the table, and the counts at that moment. */
  function snapshot(app: App, routes: readonly Route[]): RouteLog {
    const hits = app.hits();
    return {
      routeTable: [...routes],
      counts: routes.map((route) => ({ ...route, count: hits.get(route.path) ?? 0 })),
    };
  }

  // What this proves is the half that is about values: the floor is a function
  // of two snapshots, and a run of the fuzzer between two readings of the same
  // pair cannot change what it says — while the app's own counters demonstrably
  // move past what the second snapshot recorded, which is the traffic that
  // would have been inside it had the step run earlier. That the step *is*
  // ordered after the second capture is a fact about `action.yml`, and
  // `tests/action-evidence.test.ts` is what holds it; no arrangement of these
  // two pure calls could.
  test("a run between two readings of one pair cannot move the floor", async () => {
    using app = serving();
    const table = [OK];
    const before = snapshot(app, table);
    await fetch(`${app.origin}/ok/1`);
    const after = snapshot(app, table);

    const allowlist = allowlistFrom("", "route-allowlist");
    const first = routeCoverage(before, after, allowlist);
    const run = await fuzzing(app, table);
    const second = routeCoverage(before, after, allowlist);

    expect(run.requests).toBeGreaterThan(0);
    expect(app.hits().get(OK.path) ?? 0).toBeGreaterThan(after.counts[0]?.count ?? 0);
    expect(second).toEqual(first);
    expect(second.problems).toEqual([]);
  });
});

describe("every class the tables declare", () => {
  // A class that is never drawn is a class that does not exist, and nothing
  // above would notice: `undefined` sat in the content-type table as "no
  // content type" and `pick` replaced it with the first entry, so the class was
  // never sent once and JSON went at double weight. Counted against what the
  // tables declare rather than against what was seen, since a class nothing
  // draws never appears in a tally of draws.
  test("is drawn, and none is drawn in place of another", () => {
    const drawn = new Map(
      Object.values(CLASSES)
        .flat()
        .map((named) => [named, 0]),
    );
    for (let at = 0; at < 2_000; at++) {
      for (const route of [OK, STRICT]) {
        for (const named of attemptFor("http://app", route, 11, at).drawn) {
          drawn.set(named, (drawn.get(named) ?? 0) + 1);
        }
      }
    }
    expect([...drawn].filter(([, count]) => count === 0)).toEqual([]);
  });

  // The page is a second statement of the tables, and it was already wrong: it
  // listed seven body classes of eight. Held by set equality, the way the
  // React table is held to the base — a class with no row is one a reader never
  // hears of, and a row with no class is advice about a request nothing sends.
  test("has a row on the page, and no row names a class that is gone", async () => {
    const page = await Bun.file(new URL("../docs/gates/fuzz.md", import.meta.url)).text();
    // From under the separator, so the header is not read as a row — the table
    // is found by its first column's name rather than by position, so a section
    // reordered above it still counts.
    const rows = (heading: string, cell: RegExp): string[] => {
      const section = page.slice(page.indexOf(heading));
      const lines = section.slice(0, section.indexOf("\n\n")).split("\n");
      return lines
        .slice(lines.findIndex((line) => line.startsWith("| ---")) + 1)
        .map((line) => cell.exec(line)?.[1]?.trim())
        .filter((named) => named !== undefined)
        .toSorted();
    };
    expect(rows("| Where ", /^\|[^|]*\|([^|]+)\|/u)).toEqual(
      Object.values(CLASSES).flat().toSorted(),
    );
    expect(rows("| Invariant ", /^\|([^|]+)\|/u)).toEqual([...INVARIANTS].toSorted());
  });
});

describe("the run's two dials", () => {
  test("the nightly gets the long budget and every other run the short one", () => {
    expect(budgetFor("false")).toBe(20_000);
    expect(budgetFor("true")).toBe(600_000);
  });

  // A spelling nobody defined would otherwise read as "not nightly", and the
  // long search would quietly never have happened.
  test.each(["", "TRUE", "yes", "1"])("a nightly written %p is refused", (value) => {
    expect(() => budgetFor(value)).toThrow("it takes true or false");
  });

  test("an unseeded run is seeded from the run it is", () => {
    expect(seedFrom("", "18492")).toBe(seedFrom("", "18492"));
    expect(seedFrom("", "18492")).not.toBe(seedFrom("", "18493"));
    expect(seedFrom("  ", "18492")).toBe(seedFrom("", "18492"));
  });

  test("and a seed a reader pasted back is the seed that run uses", () => {
    expect(seedFrom("4242", "18492")).toBe(4242);
    expect(seedFrom(" 4242 ", "18492")).toBe(4242);
  });

  test.each(["-1", "4294967296", "1e5", "abc", "4242.5"])(
    "a seed written %p is refused rather than turned into one",
    (value) => {
      expect(() => seedFrom(value, "18492")).toThrow("fuzz-seed");
    },
  );
});
