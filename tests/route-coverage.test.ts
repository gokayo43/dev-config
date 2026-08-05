import { describe, expect, test } from "bun:test";

import { allowlistFrom } from "../.github/actions/_lib/gate.ts";
import { routeCoverage } from "../.github/actions/db-gate/route-coverage.ts";
import { containing } from "./matchers.ts";

/** The two line shapes the app under load prints, among everything else it logs. */
function table(...routes: { method: string; path: string }[]): string {
  return JSON.stringify({ routeTable: routes });
}

function served(method: string, path: string): string {
  return JSON.stringify({ routeServed: { method, path } });
}

// A boot log as the step actually captures it: the migrate output, Bun's own
// lines and the app's log records sit around the two the gate reads.
const NOISE = [
  "$ bun src/main.ts",
  '{"message":"listening","logLevel":"INFO"}',
  "not json at all",
  "",
];

function log(...lines: string[]): string {
  return [...NOISE, ...lines].join("\n");
}

/** The whole log doubles as the ramp's window unless a case says otherwise. */
function problems(text: string, allowlist = "", underRamp = text): string[] {
  const read = allowlistFrom(allowlist, "route-allowlist");
  return [...read.problems, ...routeCoverage({ all: text, underRamp }, read.entries).problems].map(
    ({ message }) => message,
  );
}

describe("the route-coverage floor", () => {
  const ROUTES = table(
    { method: "GET", path: "/health" },
    { method: "GET", path: "/presets/:id" },
    { method: "POST", path: "/presets" },
  );

  test("a route the ramp never reaches is the whole point of the floor", () => {
    expect(problems(log(ROUTES, served("GET", "/health"), served("GET", "/presets/:id")))).toEqual([
      "POST /presets is served but no ramp request exercises it — ramp it from capacity-path or the capacity script, or list it in route-allowlist with a reason",
    ]);
  });

  test("a ramp that reaches every route leaves nothing to say", () => {
    const covered = log(
      ROUTES,
      served("GET", "/health"),
      served("GET", "/presets/:id"),
      served("POST", "/presets"),
    );
    expect(problems(covered)).toEqual([]);
  });

  // The app names the route its router matched, so a concrete path arrives
  // already resolved: /presets/42 is served by /presets/:id and nothing else.
  test("a parameterised route is covered by the concrete path that matched it", () => {
    const hit = log(table({ method: "GET", path: "/presets/:id" }), served("GET", "/presets/:id"));
    expect(problems(hit)).toEqual([]);
  });

  test("a method is part of the route: GET /x does not cover POST /x", () => {
    const wrongMethod = log(
      table({ method: "GET", path: "/presets" }, { method: "POST", path: "/presets" }),
      served("GET", "/presets"),
    );
    expect(problems(wrongMethod)).toEqual([containing("POST /presets is served")]);
  });

  // A route registered for every method is reached by whichever one the ramp
  // used, which is how `.all("/api/auth/*")` is covered by one GET.
  test("a route serving every method is covered by any one of them", () => {
    const auth = log(table({ method: "ALL", path: "/api/auth/*" }), served("GET", "/api/auth/*"));
    expect(problems(auth)).toEqual([]);
  });

  test("an allowlisted route is covered by the reason recorded beside it", () => {
    const preflight = log(
      table({ method: "GET", path: "/health" }, { method: "OPTIONS", path: "/*" }),
      served("GET", "/health"),
    );
    expect(problems(preflight)).toEqual([containing("OPTIONS /* is served")]);
    expect(problems(preflight, "OPTIONS /* -- answered before the hook runs")).toEqual([]);
    expect(problems(preflight, "options /* -- answered before the hook runs")).toEqual([]);
  });

  // The same rule extra-paths carries in the pin gate: an escape hatch nobody
  // can see rotting is how a gate quietly stops covering what it names.
  test("an allowlist entry the app does not serve is a stale hatch", () => {
    const gone = log(table({ method: "GET", path: "/health" }), served("GET", "/health"));
    expect(problems(gone, "POST /retired -- gone in v2")).toEqual([
      containing("route-allowlist names POST /retired, which this app does not serve"),
    ]);
  });

  // Without the table there is no floor at all, and a step that passes on a
  // silent app is exactly the "never load-tested" case this exists to catch.
  test("an app that printed no route table fails rather than passing vacuously", () => {
    expect(problems(log(served("GET", "/health")))).toEqual([
      containing("no route table reached the log"),
    ]);
  });

  test("the log carries a line for a green step to show the floor ran", () => {
    const covered = log(
      table({ method: "GET", path: "/health" }, { method: "OPTIONS", path: "/*" }),
      served("GET", "/health"),
    );
    expect(
      routeCoverage(
        { all: covered, underRamp: covered },
        allowlistFrom("OPTIONS /* -- answered before the hook runs", "route-allowlist").entries,
      ).summary,
    ).toBe("route coverage: 1 of 2 routes exercised by the ramp, 1 allowlisted");
  });
});

describe("what counts as coverage", () => {
  const ROUTES = table({ method: "GET", path: "/health" }, { method: "POST", path: "/presets" });

  // ROUTE_LOG is on from boot, so the poll that waits for the app to answer
  // writes routeServed lines of its own. Crediting those would let a scenario
  // that never touches the health route pass as if it had.
  test("a route the boot poll reached and the ramp did not is uncovered", () => {
    const boot = log(ROUTES, served("GET", "/health"));
    const underRamp = served("POST", "/presets");
    expect(problems(`${boot}\n${underRamp}`, "", underRamp)).toEqual([
      containing("GET /health is served but no ramp request exercises it"),
    ]);
  });

  test("the table is still read from before the ramp, where the app printed it", () => {
    const boot = log(ROUTES, served("GET", "/health"));
    const underRamp = [served("GET", "/health"), served("POST", "/presets")].join("\n");
    expect(problems(`${boot}\n${underRamp}`, "", underRamp)).toEqual([]);
  });
});

describe("a route table that will not read", () => {
  // Dropping the entry silently would shrink the floor to whatever the app
  // spelled correctly, and the step would pass while covering less.
  test("a malformed entry is named rather than dropped", () => {
    const partial = log(
      JSON.stringify({ routeTable: [{ method: "GET", path: "/health" }, { path: "/presets" }] }),
      served("GET", "/health"),
    );
    expect(problems(partial)).toEqual([
      containing('names {"path":"/presets"}, which is not a {"method","path"} pair'),
    ]);
  });

  test("an entry that is not an object at all is named too", () => {
    const junk = log(JSON.stringify({ routeTable: ["GET /health"] }));
    expect(problems(junk)).toEqual([
      containing('names "GET /health", which is not a {"method","path"} pair'),
      containing("no route table reached the log"),
    ]);
  });
});

describe("the price of the hatch", () => {
  const ROUTES = table({ method: "GET", path: "/health" }, { method: "OPTIONS", path: "/*" });
  const RAN = log(ROUTES, served("GET", "/health"));
  // A tree with nothing else wrong, so a malformed entry is the only thing left
  // to report: it waives no route, since there is no route to read out of it.
  const COVERED = log(table({ method: "GET", path: "/health" }), served("GET", "/health"));

  // The same price a lint directive pays: an exemption nobody had to justify is
  // one nobody can review a year later.
  test("an entry that waives a route without saying why is refused", () => {
    expect(problems(RAN, "OPTIONS /*")).toEqual([
      containing("route-allowlist waives OPTIONS /* without saying why"),
    ]);
  });

  test("the reason is stripped before the entry is compared", () => {
    expect(
      problems(RAN, "OPTIONS /* -- the cors plugin answers these before the hook runs"),
    ).toEqual([]);
  });

  // Read as a route, `/health` has no method: reporting it as a route the app
  // does not serve would send the reader looking for the wrong mistake.
  test.each(["/health -- no method", "GET -- no path", "GET /a /b -- two paths"])(
    "an entry that is not a route (%s) says so",
    (entry) => {
      expect(problems(COVERED, entry)).toEqual([
        containing("is not a route — write 'METHOD /path'"),
      ]);
    },
  );
});
