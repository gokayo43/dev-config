import { isObject, kindOf, record } from "../_lib/gate.ts";

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
  if (!isObject(parsed)) {
    throw new Error(`the summary is not the k6 export shape: the top level is ${kindOf(parsed)}`);
  }
  // An absent metrics is a summary holding nothing, which the table reports as
  // the run that measured nothing. One that is there and is not an object
  // belongs to a file k6 did not write, and no arithmetic over it means
  // anything — least of all the zero it would otherwise read as.
  const found = parsed["metrics"];
  if (found !== undefined && !isObject(found)) {
    throw new Error(`the summary is not the k6 export shape: metrics is ${kindOf(found)}`);
  }
  const metrics = record(found);
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
 * That absence is the only failure this side of k6, which refuses a run whose
 * requests mostly failed before the summary is read at all. A latency bound
 * would be measuring the runner GitHub happened to give us, and a gate that
 * fails on that gets disabled within a month, so the numbers are published for
 * trend comparison and nothing here compares them to a target.
 */
export function capacityTable(summary: Summary): string | undefined {
  const requests = summary.metrics["http_reqs"];
  if (requests === undefined || (requests["count"] ?? 0) === 0) return undefined;

  return [
    "### Capacity",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    // The whole run over its whole duration, ramp-up and ramp-down included,
    // which is the only rate k6's summary carries: below the plateau, and a
    // trend datum rather than a throughput this app reached.
    `| Mean requests/s (whole run incl. ramp) | ${stat(summary, "http_reqs", "rate").toFixed(1)} |`,
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
