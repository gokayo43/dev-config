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

function problems(text: string, allowlist = ""): string[] {
  return routeCoverage(text, allowlistFrom(allowlist)).problems.map(({ message }) => message);
}

describe("the route-coverage floor", () => {
  const ROUTES = table(
    { method: "GET", path: "/health" },
    { method: "GET", path: "/presets/:id" },
    { method: "POST", path: "/presets" },
  );

  test("a route the ramp never reaches is the whole point of the floor", () => {
    expect(problems(log(ROUTES, served("GET", "/health"), served("GET", "/presets/:id")))).toEqual([
      "POST /presets is served but no ramp request exercises it — extend the capacity scenario, or list it in route-allowlist with a reason",
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
    expect(problems(preflight, "OPTIONS /*")).toEqual([]);
    expect(problems(preflight, "options /*")).toEqual([]);
  });

  // The same rule extra-paths carries in the pin gate: an escape hatch nobody
  // can see rotting is how a gate quietly stops covering what it names.
  test("an allowlist entry the app does not serve is a stale hatch", () => {
    const gone = log(table({ method: "GET", path: "/health" }), served("GET", "/health"));
    expect(problems(gone, "POST /retired")).toEqual([
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
    expect(routeCoverage(covered, allowlistFrom("OPTIONS /*")).summary).toBe(
      "route coverage: 1 of 2 routes exercised by the ramp, 1 allowlisted",
    );
  });
});
