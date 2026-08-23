/**
 * The response-schema export, driven against a real Elysia app rather than
 * against hand-written route entries. The fact this gate rests on is what
 * `app.routes` holds after every plugin is composed — a shape Elysia owns and
 * can change — so a fixture of literal objects would grade this repo's idea of
 * a route table and prove nothing about the one a consumer passes in.
 */
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { responseSchemaGaps, type Skip } from "../response-schema.ts";
import { containing } from "./matchers.ts";

/**
 * Four routes and the four states a route can be in: declared, undeclared,
 * carrying a hook that is not a response schema, and framework-owned.
 */
const app = new Elysia()
  .get("/health", () => ({ ok: true }), { response: t.Object({ ok: t.Boolean() }) })
  .get("/presets/:id", () => ({ id: "1" }), { response: t.Object({ id: t.String() }) })
  .get("/report.csv", () => "a,b\n")
  .post("/import", () => ({ queued: true }), { beforeHandle: () => undefined });

const FLOOR = 3;

/** The one skip the fixture app legitimately owes — its hand-serialised CSV body. */
const CSV: Skip = {
  method: "GET",
  path: "/report.csv",
  cause: "hand-serialized",
  why: "the handler returns a built CSV document, so the only declarable schema is t.String()",
};

function gaps(skips: readonly Skip[], floor = FLOOR): string[] {
  return responseSchemaGaps({ routes: app.routes, skips, floor });
}

describe("what a composed Elysia app has to satisfy", () => {
  // `app.routes` goes in with no cast. A cast here would be the thing that lets
  // an introspection Elysia has renamed keep type-checking while answering
  // nothing.
  test("an app whose every undeclared route is a named skip passes", () => {
    expect(
      gaps([
        CSV,
        {
          method: "POST",
          path: "/import",
          cause: "binary",
          why: "the handler streams the uploaded bytes straight back",
        },
      ]),
    ).toEqual([]);
  });

  test("an undeclared route nobody argued for fails", () => {
    expect(gaps([CSV])).toEqual([containing("POST /import declares no `response`")]);
  });

  // The fact is `hooks.response`, not `hooks`. A gate reading the hooks object
  // for truthiness calls `/import` declared, because it carries a beforeHandle.
  test("a route carrying some other hook is still undeclared", () => {
    const only = gaps([CSV]);
    expect(only).toHaveLength(1);
    expect(only[0]).toContain("POST /import");
  });
});

describe("the floor under the route table", () => {
  // Introspection that has stopped answering returns an empty list, and an
  // empty list satisfies every other check here.
  test("a table that has gone empty is refused rather than passed", () => {
    expect(responseSchemaGaps({ routes: [], skips: [], floor: 1 })).toEqual([
      containing("the route table has 0 routes, at or below the floor of 1"),
    ]);
  });

  test("a table at the floor is refused too — the floor is a bound, not a target", () => {
    expect(gaps([CSV], app.routes.length)).toEqual([
      containing(`at or below the floor of ${app.routes.length}`),
    ]);
  });

  // Nothing below the floor is worth reporting: the table it would be reported
  // against is the thing under suspicion.
  test("the floor is the only thing said about a table that fails it", () => {
    expect(responseSchemaGaps({ routes: [], skips: [CSV], floor: 1 })).toHaveLength(1);
  });
});

describe("the skips table drains", () => {
  test("a skip for a route that is no longer served is stale", () => {
    expect(
      gaps([CSV, { method: "GET", path: "/gone", cause: "sse", why: "streamed dashboard deltas" }]),
    ).toEqual([
      containing("POST /import declares no `response`"),
      containing("the skip for GET /gone is stale: that route is no longer served"),
    ]);
  });

  // The other half of stale, and the one a length-only check misses: the route
  // is still there and has since been given a schema.
  test("a skip for a route that has since been declared is stale", () => {
    expect(
      gaps([
        CSV,
        { method: "GET", path: "/health", cause: "framework", why: "answered by the platform" },
        {
          method: "POST",
          path: "/import",
          cause: "binary",
          why: "the handler streams the uploaded bytes straight back",
        },
      ]),
    ).toEqual([
      containing("the skip for GET /health is stale: that route declares a response schema now"),
    ]);
  });

  // Two entries for one route: draining either leaves the other standing, so
  // the pair can never be shown to have gone stale.
  test("a route listed twice is refused", () => {
    expect(gaps([CSV, CSV])).toEqual([
      containing("POST /import declares no `response`"),
      containing("the skips table lists GET /report.csv twice"),
    ]);
  });
});

describe("a skip has to carry a reason", () => {
  test.each(["", "   "])("an empty why (%p) is no reason", (why) => {
    expect(gaps([{ ...CSV, why }])).toEqual([
      containing("POST /import declares no `response`"),
      containing("the skip for GET /report.csv gives no reason"),
    ]);
  });

  // The shape a placeholder takes: the category typed a second time.
  test("a why that only restates its cause is no reason", () => {
    expect(gaps([{ ...CSV, why: "Hand-Serialized" }])).toEqual([
      containing("POST /import declares no `response`"),
      containing("the skip for GET /report.csv gives no reason"),
    ]);
  });

  test("a stale skip is reported as stale rather than for its reason", () => {
    expect(
      gaps([CSV, { method: "GET", path: "/gone", cause: "sse", why: "" }]).filter((problem) =>
        problem.includes("/gone"),
      ),
    ).toEqual([containing("is stale")]);
  });
});
