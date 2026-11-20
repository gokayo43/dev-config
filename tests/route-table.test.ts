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
  test("the captured payload is read as the endpoint wrote it", () => {
    expect(CAPTURED.routeTable).toContainEqual({ method: "ALL", path: "/api/auth/*" });
    expect(CAPTURED.counts).toContainEqual({ method: "GET", path: "/health", count: 50 });
    // The instrument reports neither its own route nor its own traffic.
    expect(CAPTURED.routeTable.some(({ path }) => path === "/__route-log")).toBe(false);
    expect(CAPTURED.counts.some(({ path }) => path === "/__route-log")).toBe(false);
  });

  // Dropping an entry quietly would shrink what the gates read to whatever the
  // app spelled correctly, and they would pass while asking less.
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

  // Each of these is otherwise readable as an app serving nothing, which is a
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

  test("a payload that is not JSON at all throws rather than reading as no routes", () => {
    expect(() => read("not json")).toThrow("the route log is not JSON");
  });
});
