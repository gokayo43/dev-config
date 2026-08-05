import type { Problem } from "../_lib/gate.ts";

type Metric = Record<string, number>;

export interface Summary {
  readonly metrics?: Record<string, Metric>;
}

export interface Capacity {
  readonly problems: Problem[];
  /** The measurement, for $GITHUB_STEP_SUMMARY. Empty when there was none. */
  readonly markdown: string;
}

function ms(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} ms`;
}

/**
 * Reads a k6 summary and reports the number it measured.
 *
 * The only failure is the absence of a measurement. A latency bound would be
 * measuring the runner GitHub happened to give us, and a gate that fails on
 * that gets disabled within a month — so the numbers are published for trend
 * comparison and nothing here compares them to a target.
 */
export function capacityReport(summary: Summary): Capacity {
  const metrics = summary.metrics ?? {};
  const requests = metrics["http_reqs"];
  const duration = metrics["http_req_duration"] ?? {};
  const failed = metrics["http_req_failed"] ?? {};
  const vus = metrics["vus_max"] ?? {};

  if (requests === undefined || (requests["count"] ?? 0) === 0) {
    return {
      problems: [
        {
          message:
            "the capacity ramp produced no requests — k6 ran but measured nothing, so there is no number to record",
        },
      ],
      markdown: "",
    };
  }

  const rate = requests["rate"] ?? 0;
  const errorRate = (failed["value"] ?? 0) * 100;

  return {
    problems: [],
    markdown: [
      "### Capacity",
      "",
      "| Measurement | Value |",
      "| --- | --- |",
      `| Sustained requests/s | ${rate.toFixed(1)} |`,
      `| Requests | ${requests["count"] ?? 0} |`,
      `| Peak VUs | ${vus["max"] ?? vus["value"] ?? 0} |`,
      `| Failed requests | ${errorRate.toFixed(2)}% |`,
      `| Latency p(95) | ${ms(duration["p(95)"])} |`,
      `| Latency p(99) | ${ms(duration["p(99)"])} |`,
      `| Latency max | ${ms(duration["max"])} |`,
      "",
      "Measured on a CI runner, which is not the deployed shape: read it against",
      "the last run rather than as a capacity claim. The number that answers",
      '"how much load does this hold" comes from a ramp against the deploy.',
      "",
    ].join("\n"),
  };
}
