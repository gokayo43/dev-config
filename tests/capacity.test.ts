import { describe, expect, test } from "bun:test";

import { capacityReport, type Summary } from "../.github/actions/db-gate/capacity.ts";
import { containing } from "./matchers.ts";

// A real `k6 run --summary-export` from a ramp against a live server, with the
// trend stats this gate asks for.
const SUMMARY = (await Bun.file(new URL("./k6-summary.json", import.meta.url)).json()) as Summary;

describe("capacity report", () => {
  test("a ramp that measured something records the number", () => {
    const { problems, markdown } = capacityReport(SUMMARY);
    expect(problems).toEqual([]);
    expect(markdown).toContain("Sustained requests/s");
    expect(markdown).toContain("22289.8");
    expect(markdown).toContain("Latency p(95)");
    expect(markdown).toContain("Latency p(99)");
  });

  // The whole point of the gate: it asserts a measurement happened. A latency
  // bound would be measuring the runner, so there is deliberately none.
  test("a slow run is still a run", () => {
    const slow: Summary = {
      metrics: {
        http_reqs: { count: 12, rate: 0.2 },
        http_req_duration: { "p(95)": 9000, "p(99)": 30000, max: 45000 },
      },
    };
    expect(capacityReport(slow).problems).toEqual([]);
    expect(capacityReport(slow).markdown).toContain("30000.0 ms");
  });

  test("a failing request is reported, not refused", () => {
    const flaky: Summary = {
      metrics: {
        http_reqs: { count: 100, rate: 10 },
        http_req_failed: { value: 0.25 },
      },
    };
    expect(capacityReport(flaky).problems).toEqual([]);
    expect(capacityReport(flaky).markdown).toContain("25.00%");
  });

  test.each([
    ["an empty summary", {}],
    ["a summary with no requests metric", { metrics: {} }],
    ["a run that made no requests", { metrics: { http_reqs: { count: 0, rate: 0 } } }],
  ])("%s is the one failure: there is no number to record", (_, summary: Summary) => {
    const { problems, markdown } = capacityReport(summary);
    expect(problems.map(({ message }) => message)).toEqual([containing("produced no requests")]);
    expect(markdown).toBe("");
  });
});
