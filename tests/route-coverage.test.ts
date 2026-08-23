import { describe, expect, test } from "bun:test";

import { allowlistFrom, type Verdict } from "../.github/actions/_lib/gate.ts";
import type { RouteLog } from "../route-log.ts";
import { parseRouteLog, routeCoverage } from "../.github/actions/db-gate/route-coverage.ts";

import { containing } from "./matchers.ts";

/**
 * Two real fetches of project-template's route-log endpoint, captured from that
 * producer under an app carrying the scaffold's own shape — the cors plugin's
 * two OPTIONS routes, an `.all` auth route, and a few of its own — with traffic
 * arranged the way a run arranges it:
 *
 * - `GET /health` answered the boot poll **and** the ramp — exercised
 *   throughout, and the case a sampled announcement reads as uncovered whenever
 *   the two fall inside one interval. It is why coverage is a difference.
 * - `GET /ready` was touched before the ramp only, and must stay uncovered:
 *   traffic this action made is not the scenario's.
 * - `GET /presets`, `GET /presets/:id` and the `ALL /api/auth/*` route were
 *   reached by the ramp alone.
 * - `POST /presets` and the two OPTIONS routes were never reached at all.
 * - `/events` carries both `ALL /events` and a `GET /events` of its own, and the
 *   ramp sent it GETs. The router hands those to the concrete handler, so the
 *   catch-all is uncovered: it is one path, two routes, and only one of them ran.
 */
async function fixture(when: string): Promise<RouteLog> {
  return parseRouteLog(
    await Bun.file(new URL(`./route-log-${when}.json`, import.meta.url)).text(),
    `the ${when} fixture`,
  );
}

const BEFORE = await fixture("before");
const AFTER = await fixture("after");

function coverage(allowlist = "", before = BEFORE, after = AFTER): Verdict {
  return routeCoverage(before, after, allowlistFrom(allowlist, "route-allowlist"));
}

function problems(allowlist = "", before = BEFORE, after = AFTER): string[] {
  return coverage(allowlist, before, after).problems.map(({ message }) => message);
}

/** A route log written by hand, for the shapes a working producer cannot be asked to emit. */
function log(routeTable: RouteLog["routeTable"], counts: RouteLog["counts"] = []): RouteLog {
  return { routeTable, counts };
}

const WAIVED = [
  "OPTIONS / -- answered by the cors plugin before the request reaches a route",
  "OPTIONS /* -- answered by the cors plugin before the request reaches a route",
].join("\n");

describe("the route-coverage floor", () => {
  test("a route the ramp never reaches is the whole point of the floor", () => {
    expect(problems()).toEqual([
      containing("OPTIONS / is served but no ramp request exercises it"),
      containing("OPTIONS /* is served but no ramp request exercises it"),
      containing("GET /ready is served but no ramp request exercises it"),
      containing("POST /presets is served but no ramp request exercises it"),
      containing("ALL /events is served but no ramp request exercises it"),
    ]);
  });

  // The race a counter has no room for: the boot step's health poll and the ramp
  // both reached GET /health, and a floor that had to place a sampled
  // announcement on one side of the boundary could credit the poll's traffic to
  // the ramp, or the ramp's to neither.
  test("a route the poll reached and the ramp reached again is covered", () => {
    expect(problems()).not.toContainEqual(containing("GET /health"));
    expect(coverage().note).toContain("5 of 10 routes exercised");
  });

  // ROUTE_LOG is on from boot, so the poll that waits for the app to answer
  // moves counters of its own. Crediting those would pass a scenario that never
  // touched the route as though it had.
  test("a route the boot poll reached and the ramp did not is uncovered", () => {
    expect(problems()).toContainEqual(
      containing("GET /ready is served but no ramp request exercises it"),
    );
  });

  test("a method is part of the route: the ramp's GET /presets does not cover POST /presets", () => {
    expect(problems()).toContainEqual(
      containing("POST /presets is served but no ramp request exercises it"),
    );
  });

  // The app names the route its router matched, so a concrete path arrives
  // already resolved: /presets/42 is served by /presets/:id and nothing else.
  test("a parameterised route is covered by the concrete path that matched it", () => {
    expect(problems()).not.toContainEqual(containing("/presets/:id"));
  });

  // A route registered for every method is reached by whichever one the ramp
  // used, which is how `.all("/api/auth/*")` is covered by one GET.
  test("a route serving every method is covered by any one of them", () => {
    expect(problems()).not.toContainEqual(containing("/api/auth/*"));
  });

  // ...but only by the methods it actually answers. `/events` carries a GET
  // route of its own, so the router hands the ramp's GETs to that one and the
  // catch-all beside it never runs — and one path reports both, so crediting
  // every count on the path would mark a handler covered on its neighbour's
  // traffic.
  test("a catch-all is not covered by a request its concrete neighbour answered", () => {
    expect(problems()).toContainEqual(
      containing("ALL /events is served but no ramp request exercises it"),
    );
    expect(problems()).not.toContainEqual(containing("GET /events is served"));
  });

  test("a method no route of its own claims is what does cover the catch-all", () => {
    const table = [
      { method: "ALL", path: "/events" },
      { method: "GET", path: "/events" },
    ];
    const posted = log(table, [{ method: "POST", path: "/events", count: 4 }]);
    expect(problems("", log(table), posted)).toEqual([
      containing("GET /events is served but no ramp request exercises it"),
    ]);
  });

  test("an allowlisted route is covered by the reason recorded beside it", () => {
    expect(
      problems(`${WAIVED}\nGET /ready -- a readiness probe the ramp has no reason to hold`),
    ).toEqual([containing("POST /presets is served"), containing("ALL /events is served")]);
  });

  test("the allowlist reads a method in either case", () => {
    expect(problems(WAIVED.toLowerCase())).toEqual([
      containing("GET /ready is served"),
      containing("POST /presets is served"),
      containing("ALL /events is served"),
    ]);
  });

  test("the log carries a line for a green step to show the floor ran", () => {
    const clean = `${WAIVED}
      GET /ready -- a readiness probe the ramp has no reason to hold
      POST /presets -- a write path the read-only ramp has no body for
      ALL /events -- the ramp sends no method the GET route beside it does not answer`;
    expect(problems(clean)).toEqual([]);
    expect(coverage(clean).note).toBe(
      "route coverage: 5 of 10 routes exercised by the ramp, 5 allowlisted",
    );
  });

  // Without a table there is no floor at all, and a step that passes on a silent
  // app is exactly the "never load-tested" case this exists to catch.
  test("an app that reported no route table fails rather than passing vacuously", () => {
    expect(problems("", log([]), log([]))).toEqual([containing("reported an empty routeTable")]);
    expect(coverage("", log([]), log([])).note).toBe("route coverage: no route table");
  });
});

describe("the price of the hatch", () => {
  // The same price a lint directive pays: an exemption nobody had to justify is
  // one nobody can review a year later. The gate charges it, rather than each
  // entry point remembering to.
  test("an entry that waives a route without saying why is refused", () => {
    expect(problems("OPTIONS /*")).toContainEqual(
      containing("route-allowlist waives OPTIONS /* without saying why"),
    );
  });

  // One mistake earns one diagnostic. Each of these entries is a line its
  // author is going back to anyway, so the second question — is this route even
  // served, did the ramp reach it, is it a route at all — is noise on top of an
  // answer they already have. stack-gate and the timestamptz gate charge the
  // hatch the same way, and this was the one that did not.
  test.each(["POST /retired", "GET /health", "/health"])(
    "an entry with no reason (%s) is not asked the second question",
    (entry) => {
      expect(problems(entry).filter((message) => message.includes(entry))).toEqual([
        containing("without saying why"),
      ]);
    },
  );

  // The other half of that rule: it still waives its route, so the floor does
  // not report the route as well. Two diagnostics for one line, either way
  // round, is the thing being avoided.
  test("an entry with no reason still waives the route it names", () => {
    expect(problems("GET /ready")).toEqual([
      containing("route-allowlist waives GET /ready without saying why"),
      containing("OPTIONS / is served"),
      containing("OPTIONS /* is served"),
      containing("POST /presets is served"),
      containing("ALL /events is served"),
    ]);
  });

  // The same rule extra-paths carries in the pin gate: an escape hatch nobody
  // can see rotting is how a gate quietly stops covering what it names.
  test("an allowlist entry the app does not serve is a stale hatch", () => {
    expect(problems("POST /retired -- gone in the rewrite")).toContainEqual(
      containing("route-allowlist names POST /retired, which this app does not serve"),
    );
  });

  // The other way a hatch rots: the route it waives is now ramped, so the reason
  // written beside it — that the ramp cannot reach this — has stopped being true.
  test("an entry waiving a route the ramp did exercise is refused", () => {
    expect(problems("GET /health -- the ramp cannot reach this")).toContainEqual(
      containing("route-allowlist waives GET /health, which the ramp did exercise"),
    );
  });

  test("the same entry against a route the ramp did not exercise is the hatch working", () => {
    expect(problems("GET /ready -- the ramp cannot reach this")).not.toContainEqual(
      containing("GET /ready"),
    );
  });

  // The same parse rule through the gate: split, the entry waived nothing and
  // sent the reader to their route table over a mistake they did not make.
  test("a reason with a comma in it waives its route and reports nothing else", () => {
    expect(
      problems("GET /ready -- a readiness probe, and holding one proves nothing about capacity"),
    ).toEqual([
      containing("OPTIONS / is served"),
      containing("OPTIONS /* is served"),
      containing("POST /presets is served"),
      containing("ALL /events is served"),
    ]);
  });

  // Read as a route, `/health` has no method: reporting it as a route the app
  // does not serve would send the reader looking for the wrong mistake.
  test.each(["/health -- no method", "GET -- no path", "GET /a /b -- two paths"])(
    "an entry that is not a route (%s) says so",
    (entry) => {
      expect(problems(entry)).toContainEqual(containing("is not a route — write 'METHOD /path'"));
    },
  );
});

const read = (text: string): RouteLog => parseRouteLog(text, "the route log");

describe("a route log that will not read", () => {
  test("the captured payload is read as the endpoint wrote it", () => {
    expect(AFTER.routeTable).toContainEqual({ method: "ALL", path: "/api/auth/*" });
    expect(AFTER.counts).toContainEqual({ method: "GET", path: "/health", count: 50 });
    // The instrument reports neither its own route nor its own traffic.
    expect(AFTER.routeTable.some(({ path }) => path === "/__route-log")).toBe(false);
    expect(AFTER.counts.some(({ path }) => path === "/__route-log")).toBe(false);
  });

  // Dropping an entry quietly would shrink the floor to whatever the app spelled
  // correctly, and the step would pass while covering less.
  test.each([
    ['{"routeTable":[{"path":"/presets"}],"counts":[]}', 'which is not a {"method","path"} pair'],
    ['{"routeTable":["GET /health"],"counts":[]}', 'which is not a {"method","path"} pair'],
    [
      '{"routeTable":[],"counts":[{"method":"GET","path":"/x"}]}',
      'which is not a {"method","path","count"} row',
    ],
    [
      '{"routeTable":[],"counts":[{"method":"GET","path":"/x","count":"12"}]}',
      'which is not a {"method","path","count"} row',
    ],
  ])("an entry that will not read is named rather than dropped (%s)", (text, detail) => {
    expect(() => read(text)).toThrow(detail);
  });

  // Each of these used to be readable as a floor covering nothing, which is a
  // diagnostic pointing at the app when the payload is the problem.
  test.each([
    ["null", "the top level is null"],
    ["42", "the top level is a number"],
    ["[]", "the top level is an array"],
    ['{"counts":[]}', "routeTable is absent"],
    ['{"routeTable":{},"counts":[]}', "routeTable is an object"],
    ['{"routeTable":[]}', "counts is absent"],
    ['{"routeTable":[],"counts":{}}', "counts is an object"],
  ])("a payload that is not a route log (%s) says so", (text, detail) => {
    expect(() => read(text)).toThrow("is not a route log");
    expect(() => read(text)).toThrow(detail);
  });

  test("a payload that is not JSON at all throws rather than covering nothing", () => {
    expect(() => read("not json")).toThrow();
  });
});
