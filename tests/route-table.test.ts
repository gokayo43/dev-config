import { describe, expect, test } from "bun:test";

import { parseRouteLog } from "../.github/actions/db-gate/route-table.ts";
import type { RouteLog } from "../route-log.ts";

/**
 * The route log as the database job reads it off the app, which both gates over
 * the route table are handed. `route-log.json` is a real fetch of
 * project-template's route-log endpoint, captured from that producer under an
 * app carrying the scaffold's own shape: the cors plugin's two OPTIONS routes,
 * an `.all` auth route, and a few of its own.
 */
const read = (text: string): RouteLog => parseRouteLog(text, "the route log");

const CAPTURED = read(await Bun.file(new URL("./route-log.json", import.meta.url)).text());

describe("a route log that will not read", () => {
  // The capture still carries `counts`, which an app sends until it moves its
  // pin past the release that stopped reading it: a reader that still
  // required or checked the key would refuse every such app.
  test("the captured payload is read as the endpoint wrote it, and its counts are not read", () => {
    expect(CAPTURED.routeTable).toContainEqual({ method: "ALL", path: "/api/auth/*" });
    // The instrument does not report its own route.
    expect(CAPTURED.routeTable.some(({ path }) => path === "/__route-log")).toBe(false);
    expect(read('{"routeTable":[{"method":"GET","path":"/x"}],"counts":{}}')).toEqual({
      routeTable: [{ method: "GET", path: "/x" }],
    });
  });

  // Dropping an entry quietly would shrink what the gates read to whatever the
  // app spelled correctly, and they would pass while asking less.
  test.each([
    ['{"routeTable":[{"path":"/presets"}]}', 'which is not a {"method","path"} pair'],
    ['{"routeTable":["GET /health"]}', 'which is not a {"method","path"} pair'],
  ])("an entry that will not read is named rather than dropped (%s)", (text, detail) => {
    expect(() => read(text)).toThrow(detail);
  });

  // Each of these is otherwise readable as an app serving nothing, which is a
  // diagnostic pointing at the app when the payload is the problem.
  test.each([
    ["null", "the top level is null"],
    ["42", "the top level is a number"],
    ["[]", "the top level is an array"],
    ["{}", "routeTable is absent"],
    ['{"routeTable":{}}', "routeTable is an object"],
  ])("a payload that is not a route log (%s) says so", (text, detail) => {
    expect(() => read(text)).toThrow("is not a route log");
    expect(() => read(text)).toThrow(detail);
  });

  // Logic 4: the refusal lived in the fuzzer, and route compatibility runs
  // first, so it never showed; that step advised committing an empty snapshot
  // instead, or on a live repo retiring every route. Refused where the log is
  // read, it is the first thing either gate says.
  test("an empty route table is refused where it is read, before either gate grades it", () => {
    expect(() => read('{"routeTable":[]}')).toThrow("the route log reports an empty routeTable");
  });

  test("a payload that is not JSON at all throws rather than reading as no routes", () => {
    expect(() => read("not json")).toThrow("the route log is not JSON");
  });
});
