import { describe, expect, test } from "bun:test";

import { containing } from "./matchers.ts";

import { capacity, parseSummary } from "../.github/actions/db-gate/capacity.ts";

function tableOf(text: string): string {
  return capacity(parseSummary(text)).table ?? "";
}

function problemsOf(text: string): string[] {
  return capacity(parseSummary(text)).problems.map(({ message }) => message);
}

/** A ramp that answered everything, as k6 exports it. */
function ran(overrides: Record<string, Record<string, number>> = {}): string {
  return JSON.stringify({
    metrics: {
      http_reqs: { count: 100, rate: 10 },
      http_req_duration: { "p(95)": 1, "p(99)": 2, max: 3 },
      http_req_failed: { value: 0 },
      vus_max: { max: 20 },
      ...overrides,
    },
  });
}

// A real `k6 run --summary-export` from a ramp against a live server, with the
// trend stats this gate asks for.
const SUMMARY = parseSummary(await Bun.file(new URL("./k6-summary.json", import.meta.url)).text());

describe("capacity table", () => {
  test("a ramp that measured something records the number", () => {
    const table = capacity(SUMMARY).table ?? "";
    expect(table).toContain("22289.8");
    expect(table).toContain("Latency p(95)");
    expect(table).toContain("Latency p(99)");
  });

  // http_reqs.rate is the whole run divided by its whole duration, ramp-up and
  // ramp-down included, so it sits below the plateau a row calling itself
  // "sustained" was read as.
  test("the requests/s row names the number it is", () => {
    const table = capacity(SUMMARY).table ?? "";
    expect(table).toContain("Mean requests/s (whole run incl. ramp)");
    expect(table).not.toContain("Sustained");
  });

  // The whole point of the gate: it asserts a measurement happened. A latency
  // bound would be measuring the runner, so there is deliberately none.
  test("a slow run is still a run", () => {
    const slow = ran({
      http_reqs: { count: 12, rate: 0.2 },
      http_req_duration: { "p(95)": 9000, "p(99)": 30000, max: 45000 },
    });
    expect(tableOf(slow)).toContain("30000.0 ms");
    expect(problemsOf(slow)).toEqual([]);
  });

  test("the occasional failing request is reported, not refused", () => {
    const flaky = ran({ http_req_failed: { value: 0.09 } });
    expect(tableOf(flaky)).toContain("9.00%");
    expect(problemsOf(flaky)).toEqual([]);
  });

  test.each([
    ["an empty summary", "{}"],
    ["a summary with no requests metric", '{"metrics":{}}'],
    ["a run that made no requests", '{"metrics":{"http_reqs":{"count":0,"rate":0}}}'],
  ])("%s has no number to record", (_, text) => {
    expect(capacity(parseSummary(text)).table).toBeUndefined();
    expect(problemsOf(text)).toEqual([containing("produced no requests")]);
  });

  // The summary is a file this action did not write; a repo may point
  // capacity-script at its own.
  test("a summary missing a stat the table needs says which", () => {
    expect(() => capacity(parseSummary('{"metrics":{"http_reqs":{"count":10,"rate":1}}}'))).toThrow(
      "the k6 summary has no vus_max.max",
    );
  });

  test("a summary that is not JSON at all throws rather than measuring nothing", () => {
    expect(() => parseSummary("not json")).toThrow();
  });

  // Each of these used to narrow silently to an empty metrics map, which the
  // table reports as a ramp that made no requests — a diagnostic pointing at
  // the app when the file is the problem.
  test.each([
    ["a summary that is null", "null", "the top level is null"],
    ["a summary that is a number", "42", "the top level is a number"],
    ["a summary that is an array", "[]", "the top level is an array"],
    ["metrics that is not an object", '{"metrics":42}', "metrics is a number"],
    ["metrics that is null", '{"metrics":null}', "metrics is null"],
  ])("%s says so rather than looking like a run that measured nothing", (_, text, detail) => {
    expect(() => parseSummary(text)).toThrow("the summary is not the k6 export shape");
    expect(() => parseSummary(text)).toThrow(detail);
  });

  // The bound k6 cannot be trusted to carry: a repo pointing capacity-script at
  // its own file replaces every threshold the shipped ramp declared, and the
  // published number would be the throughput of whatever the app returned.
  test("a ramp whose requests mostly failed is refused, whatever ran it", () => {
    expect(problemsOf(ran({ http_req_failed: { value: 0.5 } }))).toEqual([
      containing("50.00% of the ramp's requests failed"),
    ]);
    expect(problemsOf(ran({ http_req_failed: { value: 0.11 } }))).toEqual([
      containing("11.00% of the ramp's requests failed"),
    ]);
    expect(problemsOf(ran({ http_req_failed: { value: 0.1 } }))).toEqual([]);
  });

  test("the table is still published for a run the bound refuses", () => {
    expect(tableOf(ran({ http_req_failed: { value: 0.5 } }))).toContain("50.00%");
  });
});
