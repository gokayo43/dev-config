import { record } from "../_lib/gate.ts";

export interface Summary {
  readonly metrics: Record<string, Record<string, number>>;
}

/**
 * Parsed at the boundary rather than asserted through. k6's summary is a file
 * this action did not write — a repo may point `capacity-script` at its own
 * script — so a shape that is not the one read here says so loudly instead of
 * surfacing later as an arithmetic result nobody can explain.
 */
export function parseSummary(text: string): Summary {
  const parsed: unknown = JSON.parse(text);
  const metrics = record(record(parsed)["metrics"]);
  return {
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, stats]) => [
        name,
        Object.fromEntries(
          Object.entries(record(stats)).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        ),
      ]),
    ),
  };
}

function stat(summary: Summary, metric: string, name: string): number {
  const value = summary.metrics[metric]?.[name];
  if (value === undefined) throw new Error(`the k6 summary has no ${metric}.${name}`);
  return value;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

/**
 * The measurement, for $GITHUB_STEP_SUMMARY — or nothing, when the ramp made no
 * requests and there is no number to record.
 *
 * That absence is the only failure. A latency bound would be measuring the
 * runner GitHub happened to give us, and a gate that fails on that gets
 * disabled within a month, so the numbers are published for trend comparison
 * and nothing here compares them to a target.
 */
export function capacityTable(summary: Summary): string | undefined {
  const requests = summary.metrics["http_reqs"];
  if (requests === undefined || (requests["count"] ?? 0) === 0) return undefined;

  return [
    "### Capacity",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    `| Sustained requests/s | ${stat(summary, "http_reqs", "rate").toFixed(1)} |`,
    `| Requests | ${stat(summary, "http_reqs", "count")} |`,
    `| Peak VUs | ${stat(summary, "vus_max", "max")} |`,
    `| Failed requests | ${(stat(summary, "http_req_failed", "value") * 100).toFixed(2)}% |`,
    `| Latency p(95) | ${ms(stat(summary, "http_req_duration", "p(95)"))} |`,
    `| Latency p(99) | ${ms(stat(summary, "http_req_duration", "p(99)"))} |`,
    `| Latency max | ${ms(stat(summary, "http_req_duration", "max"))} |`,
    "",
    "Measured on a CI runner, which is not the deployed shape: read it against",
    "the last run rather than as a capacity claim. The number that answers",
    '"how much load does this hold" comes from a ramp against the deploy.',
    "",
  ].join("\n");
}
