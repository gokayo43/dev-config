import { isObject, kindOf, oneOf, record, type Verdict } from "../_lib/gate.ts";

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
 * Where the ramp ran, which is the whole of what its number means. The same
 * script, the same stages and the same summary say two different things
 * depending on the machine under them, and only the caller knows which it was —
 * so the fact is an input and the prose stays here, in the one place that knows
 * what each of them is worth.
 */
const RAN_ON = ["ci-runner", "deployed-shape"] as const;

export type RanOn = (typeof RAN_ON)[number];

/** The input as one of those, refused rather than defaulted — a default would publish a claim nobody made. */
export function ranOnFrom(value: string): RanOn {
  const found = oneOf(RAN_ON, value);
  if (found === undefined) {
    throw new Error(`ran-on is '${value}' — it names one of: ${RAN_ON.join(", ")}`);
  }
  return found;
}

const CAPTION = {
  "ci-runner": [
    "Measured on a CI runner, which is not the deployed shape: read it against",
    "the last run rather than as a capacity claim. The number that answers",
    '"how much load does this hold" comes from a ramp against the deploy.',
  ],
  "deployed-shape": [
    "Measured against the deployed shape, on the machine that would serve it.",
    "This is the capacity claim testing.md asks for: record the number and the",
    "first bottleneck it hit, and take it again after a change to a hot path.",
  ],
} satisfies Record<RanOn, string[]>;

/**
 * The measurement, for a run summary or a file beside the repo — or nothing,
 * when the ramp made no requests and there is no number to record.
 */
function capacityTable(summary: Summary, ranOn: RanOn): string | undefined {
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
    ...CAPTION[ranOn],
    "",
  ].join("\n");
}

/**
 * A tenth of the ramp's requests. Latency and throughput belong to whatever
 * machine the ramp found, and a gate that fails on those gets disabled within a
 * month — but a request the app refused is refused on any machine, so this one
 * bound says something about the app wherever it ran.
 */
const FAILURE_BOUND = 0.1;

/**
 * What the step publishes and what it fails on, from the one file k6 leaves
 * behind. The bound lives here rather than in the shipped script's thresholds
 * because `capacity-script` replaces that file entirely: a repo ramping with a
 * script of its own would otherwise publish the throughput of its own error
 * page, and the rule that decides what counts as a measurement would have two
 * homes that could disagree.
 *
 * The table is the whole of what this one has to say: the number is in it, and
 * a note repeating a row of it would be a second reading of the same run.
 */
export function capacity(summary: Summary, ranOn: RanOn): Verdict {
  const table = capacityTable(summary, ranOn);
  if (table === undefined) {
    return {
      note: undefined,
      table,
      log: undefined,
      problems: [
        {
          message:
            "the capacity ramp produced no requests — k6 ran but measured nothing, so there is no number to record",
        },
      ],
    };
  }

  const failed = stat(summary, "http_req_failed", "value");
  return {
    note: undefined,
    table,
    log: undefined,
    problems:
      failed > FAILURE_BOUND
        ? [
            {
              message: `${(failed * 100).toFixed(2)}% of the ramp's requests failed, over the ${(FAILURE_BOUND * 100).toFixed(0)}% this gate allows — the published number is the throughput of whatever answered, so fix the app or the path the scenario ramps`,
            },
          ]
        : [],
  };
}
