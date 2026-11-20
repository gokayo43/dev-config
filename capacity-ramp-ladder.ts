/**
 * The capacity ramp: a ladder of simultaneous users run through the pinned k6
 * against a target the caller names, stopped at the first step that breaks a
 * bound, and recorded where the repository keeps its history of them.
 *
 * `capacity-ramp.ts` is the argv, the signals and the exit status around this;
 * `tests/capacity-ramp.test.ts` drives it. `docs/commands/capacity-ramp.md` is
 * the page.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

export const MEASURED = 0;
export const NO_MEASUREMENT = 1;
export const WRONG_ARGUMENTS = 2;

/** What every result file carries, so a file in `capacity/` some other tool wrote is told apart from one of these. */
const TOOL = "capacity-ramp";

const DEFAULTS = {
  "start-users": "10",
  "max-users": "320",
  hold: "30s",
  "max-failed": "1%",
  "max-p95": "1s",
};

export const USAGE = `capacity-ramp --health <url> [--path </path>]... [--script <k6 script>]
              [--start-users ${DEFAULTS["start-users"]}] [--max-users ${DEFAULTS["max-users"]}] [--hold ${DEFAULTS.hold}]
              [--max-failed ${DEFAULTS["max-failed"]}] [--max-p95 ${DEFAULTS["max-p95"]}]

Doubles the simultaneous users from --start-users to --max-users, holds each
step for --hold, and stops at the first step whose failed requests exceed
--max-failed or whose 95th percentile of response time exceeds --max-p95.
Writes capacity/<UTC stamp>.json and .md at the root of this repository.
Never point it at a live deployment or at a server on live data:
docs/commands/capacity-ramp.md in @gokayo43/dev-config says why.`;

export class WrongArguments extends Error {}

export interface Bounds {
  /** The share of requests that may fail, 0 to 1. */
  readonly failed: number;
  readonly p95Ms: number;
}

export interface Plan {
  readonly health: string;
  readonly paths: readonly string[];
  /** The repo's own k6 script, relative to the repository root, or nothing for the shipped one. */
  readonly script: string | null;
  readonly steps: readonly number[];
  readonly holdMs: number;
  readonly bounds: Bounds;
}

function wholeNumber(flag: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new WrongArguments(
      `--${flag} is "${value}" — it takes a whole number of users, 1 or more`,
    );
  }
  return Number(value);
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000 } as const;

function durationMs(flag: string, value: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = Number(match?.[1] ?? 0);
  const unit = match?.[2];
  if (unit !== "ms" && unit !== "s" && unit !== "m") {
    throw new WrongArguments(`--${flag} is "${value}" — write a duration such as 500ms, 30s or 2m`);
  }
  const ms = amount * UNIT_MS[unit];
  if (ms === 0)
    throw new WrongArguments(`--${flag} is "${value}" — it has to be longer than nothing`);
  return ms;
}

function share(flag: string, value: string): number {
  const match = /^(\d+(?:\.\d+)?)%$/u.exec(value);
  const written = Number(match?.[1] ?? Number.NaN);
  if (match === null || written >= 100) {
    throw new WrongArguments(`--${flag} is "${value}" — write a percentage below 100, such as 1%`);
  }
  return written / 100;
}

/** Each step twice the one before it, from the first to the last, the last being the maximum itself. */
function ladder(start: number, max: number): number[] {
  if (start > max) {
    throw new WrongArguments(`--start-users ${start} is above --max-users ${max}`);
  }
  const steps: number[] = [];
  for (let users = start; users < max; users *= 2) steps.push(users);
  steps.push(max);
  return steps;
}

/** The command line as the run it asks for; anything it cannot be read as throws `WrongArguments`. */
export function planFrom(args: readonly string[]): Plan {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        health: { type: "string" },
        path: { type: "string", multiple: true },
        script: { type: "string" },
        "start-users": { type: "string", default: DEFAULTS["start-users"] },
        "max-users": { type: "string", default: DEFAULTS["max-users"] },
        hold: { type: "string", default: DEFAULTS.hold },
        "max-failed": { type: "string", default: DEFAULTS["max-failed"] },
        "max-p95": { type: "string", default: DEFAULTS["max-p95"] },
      },
    }));
  } catch (error) {
    throw new WrongArguments(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }

  const health = values.health;
  if (health === undefined) {
    throw new WrongArguments("--health is required: the address the ramp checks before it starts");
  }
  if (!URL.canParse(health) || !/^https?:$/u.test(new URL(health).protocol)) {
    throw new WrongArguments(`--health is "${health}" — it takes an http or https address`);
  }
  const paths = values.path ?? [];
  const unrooted = paths.find((path) => !path.startsWith("/"));
  if (unrooted !== undefined) {
    throw new WrongArguments(
      `--path "${unrooted}" does not start with / — a path is added to the health address's origin`,
    );
  }

  return {
    health,
    paths,
    script: values.script ?? null,
    steps: ladder(
      wholeNumber("start-users", values["start-users"]),
      wholeNumber("max-users", values["max-users"]),
    ),
    holdMs: durationMs("hold", values.hold),
    bounds: {
      failed: share("max-failed", values["max-failed"]),
      p95Ms: durationMs("max-p95", values["max-p95"]),
    },
  };
}

/** One path as one step measured it. `name` is k6's tag: the path for the shipped script, the URL or the script's own name for a repo's. */
export interface PathMeasured {
  readonly method: string;
  readonly name: string;
  readonly requests: number;
  readonly failed: number;
  readonly p95Ms: number;
}

export type Bound = "failed" | "p95";

export interface StepMeasured {
  readonly users: number;
  readonly requests: number;
  /** The share of requests that failed, 0 to 1. */
  readonly failed: number;
  readonly p95Ms: number;
  /** Failed requests by status; `0` is a request that got no answer at all. */
  readonly failures: Readonly<Record<string, number>>;
  /** The bounds this step broke, empty for a step held. */
  readonly broke: readonly Bound[];
  /** Slowest first. */
  readonly paths: readonly PathMeasured[];
}

/** The nearest-rank 95th percentile. */
function p95(durations: number[]): number {
  const sorted = durations.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

/** One path's requests in one step: the durations, and how many of them failed. */
interface Tally {
  readonly method: string;
  readonly name: string;
  readonly ms: number[];
  failed: number;
}

/** What one step's requests come to, before the bounds judge it. */
interface Tallied {
  readonly paths: Map<string, Tally>;
  /** Failed requests by status. */
  readonly failures: Record<string, number>;
}

/** One CSV row as its fields: k6 quotes a field holding a comma or a quote, as a URL can. */
function fieldsOf(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < row.length; at++) {
    const char = row.charAt(at);
    if (quoted && char === '"' && row.charAt(at + 1) === '"') {
      field += '"';
      at++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

const DURATION = "http_req_duration";

/**
 * k6's CSV output as one step's tallies, read a line at a time. The file holds
 * about a dozen rows per request, every metric k6 records, so a step of a
 * million requests decompresses to most of a gigabyte: holding it whole is how
 * a ramp against a fast target runs this process out of memory. What is kept is
 * one number per request. A header missing a column read here is a k6 this was
 * not written for, and throws.
 */
async function talliedIn(csvGz: string): Promise<Tallied> {
  const tallied: Tallied = { paths: new Map(), failures: {} };
  let columns: Record<
    "metric" | "value" | "expected" | "method" | "name" | "status",
    number
  > | null = null;

  const take = (row: string): void => {
    if (row === "") return;
    if (columns === null) {
      const header = fieldsOf(row);
      const at = (name: string): number => {
        const index = header.indexOf(name);
        if (index < 0)
          throw new Error(`k6's CSV output has no ${name} column: its header is ${row}`);
        return index;
      };
      columns = {
        metric: at("metric_name"),
        value: at("metric_value"),
        expected: at("expected_response"),
        method: at("method"),
        name: at("name"),
        status: at("status"),
      };
      return;
    }
    // Most rows are other metrics, passed over without being split.
    if (!row.includes(DURATION)) return;
    const read = columns;
    const fields = fieldsOf(row);
    const cell = (column: keyof typeof read): string => {
      const found = fields[read[column]];
      if (found === undefined)
        throw new Error(`k6's CSV output has a row with no ${column}: ${row}`);
      return found;
    };
    if (cell("metric") !== DURATION) return;
    const method = cell("method");
    const name = cell("name");
    const key = `${method} ${name}`;
    const tally = tallied.paths.get(key) ?? { method, name, ms: [], failed: 0 };
    tallied.paths.set(key, tally);
    tally.ms.push(Number(cell("value")));
    if (cell("expected") === "false") {
      tally.failed++;
      const status = cell("status");
      tallied.failures[status] = (tallied.failures[status] ?? 0) + 1;
    }
  };

  let partial = "";
  const text = Bun.file(csvGz)
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());
  for await (const chunk of text) {
    const rows = (partial + chunk).split("\n");
    partial = rows.pop() ?? "";
    for (const row of rows) take(row);
  }
  take(partial);
  return tallied;
}

/** What one step's requests come to, judged against the bounds; `null` when it recorded none. */
function stepFrom(
  users: number,
  { paths, failures }: Tallied,
  bounds: Bounds,
): StepMeasured | null {
  const tallies = [...paths.values()];
  const all = tallies.flatMap((tally) => tally.ms);
  if (all.length === 0) return null;
  const failed = tallies.reduce((sum, tally) => sum + tally.failed, 0) / all.length;
  const p95Ms = p95(all);
  return {
    users,
    requests: all.length,
    failed,
    p95Ms,
    failures,
    broke: [
      ...(failed > bounds.failed ? (["failed"] as const) : []),
      ...(p95Ms > bounds.p95Ms ? (["p95"] as const) : []),
    ],
    paths: tallies
      .map((tally) => ({
        method: tally.method,
        name: tally.name,
        requests: tally.ms.length,
        failed: tally.failed / tally.ms.length,
        p95Ms: p95(tally.ms),
      }))
      .toSorted((a, b) => b.p95Ms - a.p95Ms),
  };
}

export interface Previous {
  /** The result file, relative to the repository root. */
  readonly file: string;
  readonly held: number | null;
}

export interface Result {
  readonly tool: typeof TOOL;
  readonly startedAt: string;
  readonly k6: string;
  readonly target: {
    readonly health: string;
    readonly paths: readonly string[];
    readonly script: string | null;
  };
  readonly ladder: { readonly steps: readonly number[]; readonly holdMs: number };
  readonly bounds: Bounds;
  /** The last step held, or nothing when the first step broke. */
  readonly held: number | null;
  /** The step that broke, or nothing when every step held. */
  readonly broke: { readonly users: number; readonly bounds: readonly Bound[] } | null;
  readonly steps: readonly StepMeasured[];
  readonly previous: Previous | null;
}

export type Outcome = { readonly result: Result } | { readonly unmeasured: string };

export interface Machine {
  /** The pinned k6 binary. */
  readonly k6: string;
  readonly k6Version: string;
  /** Where progress goes, one line at a time. */
  readonly log: (line: string) => void;
  /** Stops the run: what was measured so far is not a result. */
  readonly signal: AbortSignal;
}

const K6_LOADER = join(import.meta.dir, ".github/actions/_lib/k6.sh");

/** Where the pinned k6 is kept between runs: the user's own cache, which nobody else can write a binary into. */
export function k6Home(env: Record<string, string | undefined>): string {
  const cache = env["XDG_CACHE_HOME"] ?? join(env["HOME"] ?? "", ".cache");
  return join(cache, "dev-config", "k6");
}

/** The pinned k6, fetched and verified by the one loader every ramp here uses, or reused where it already sits under that pin. */
export async function pinnedK6(home: string): Promise<{ k6: string; version: string }> {
  await mkdir(home, { recursive: true });
  const loader = Bun.spawn(
    ["bash", "-c", `. "$1" >&2 && printf '%s\\n%s\\n' "$K6" "$K6_VERSION"`, "k6", K6_LOADER],
    { env: { ...process.env, RUNNER_TEMP: home }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(loader.stdout).text(),
    new Response(loader.stderr).text(),
    loader.exited,
  ]);
  const [k6 = "", version = ""] = out.trim().split("\n");
  if (code !== 0 || k6 === "") throw new Error(`fetching the pinned k6 failed:\n${err}`);
  return { k6, version };
}

/** The script options that set steps of their own, which would make two owners of the ladder. */
const STEP_OPTIONS = ["vus", "duration", "iterations", "stages", "scenarios"];

/** The options a repo's script sets that only the ladder may set, by name, as `k6 inspect` reads them. */
async function stepOptionsIn(k6: string, script: string, cwd: string): Promise<string[]> {
  const inspect = Bun.spawn([k6, "inspect", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(inspect.stdout).text(),
    new Response(inspect.stderr).text(),
    inspect.exited,
  ]);
  if (code !== 0) throw new WrongArguments(`k6 cannot read --script ${script}:\n${err.trim()}`);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`k6 inspect answered something other than an object of options: ${out}`);
  }
  const options = new Map<string, unknown>(Object.entries(parsed));
  return STEP_OPTIONS.filter((option) => (options.get(option) ?? null) !== null);
}

const SHIPPED_SCRIPT = join(import.meta.dir, "capacity-ramp.js");

/** The last lines k6 wrote to stderr, kept as they arrive: a failing target makes it warn once per request. */
async function tailOf(stream: ReadableStream<Uint8Array>, keep: number): Promise<string[]> {
  const kept: string[] = [];
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of stream) {
    const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = lines.pop() ?? "";
    kept.push(...lines);
    kept.splice(0, Math.max(0, kept.length - keep));
  }
  return [...kept, partial].filter((line) => line !== "").slice(-keep);
}

async function runStep(
  plan: Plan,
  users: number,
  machine: Machine,
  cwd: string,
  scratch: string,
): Promise<StepMeasured | { readonly unmeasured: string }> {
  const csv = join(scratch, `${users}.csv.gz`);
  const k6 = Bun.spawn(
    [
      machine.k6,
      "run",
      "--quiet",
      "--no-usage-report",
      "--no-thresholds",
      "--summary-mode=disabled",
      "--system-tags=method,name,status,expected_response",
      `--out=csv=${csv}`,
      `--vus=${users}`,
      `--duration=${plan.holdMs}ms`,
      plan.script ?? SHIPPED_SCRIPT,
    ],
    {
      cwd,
      env: { ...process.env, HEALTH_URL: plan.health, CAPACITY_PATH: plan.paths.join("\n") },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stop = (): void => {
    k6.kill("SIGKILL");
  };
  machine.signal.addEventListener("abort", stop);
  const [tail, code] = await Promise.all([tailOf(k6.stderr, 20), k6.exited]);
  machine.signal.removeEventListener("abort", stop);

  if (machine.signal.aborted) {
    return {
      unmeasured: `the run was stopped during the step of ${users} users, before it finished`,
    };
  }
  if (code !== 0) {
    return {
      unmeasured: `k6 exited ${code} during the step of ${users} users:\n${tail.join("\n")}`,
    };
  }
  return (
    stepFrom(users, await talliedIn(csv), plan.bounds) ?? {
      unmeasured: `k6 recorded no request in the step of ${users} users: the script sent none, or none finished within the step and k6's grace after it`,
    }
  );
}

/** Before the first request: what the run will hit, how hard and for how long at most. */
function announced(plan: Plan): string {
  const what =
    plan.script === null
      ? [plan.health, ...plan.paths.map((path) => new URL(path, plan.health).href)].join(", ")
      : `${plan.script}, with HEALTH_URL=${plan.health}${plan.paths.length === 0 ? "" : ` and CAPACITY_PATH=${plan.paths.join(" ")}`}`;
  const seconds = (plan.steps.length * plan.holdMs) / 1000;
  return [
    `capacity-ramp: about to hit ${what}`,
    `  ${plan.steps.join(", ")} simultaneous users, each step held ${plan.holdMs / 1000}s: up to ${seconds}s of load, stopping at the first step past ${percent(plan.bounds.failed)} failed requests or a p95 of ${plan.bounds.p95Ms} ms`,
  ].join("\n");
}

async function answers(health: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(health, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    await response.arrayBuffer();
    return response.ok ? undefined : `${health} answered ${response.status}`;
  } catch (error) {
    return `${health} did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The directory every result is written into, at the repository's root. */
export const RESULTS = "capacity";

function sameMeasurement(a: Result, plan: Plan): boolean {
  return (
    a.target.health === plan.health &&
    a.target.script === plan.script &&
    a.target.paths.toSorted().join("\n") === plan.paths.toSorted().join("\n") &&
    a.bounds.failed === plan.bounds.failed &&
    a.bounds.p95Ms === plan.bounds.p95Ms
  );
}

/**
 * The latest earlier result of the same measurement: the same target, paths,
 * script and bounds. A JSON file there without this tool's mark is another
 * tool's and is passed over; one with the mark that does not parse throws.
 */
async function previousOf(root: string, plan: Plan): Promise<Previous | null> {
  const directory = join(root, RESULTS);
  const names = await readdir(directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const results = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map(async (name) => {
        const file = join(directory, name);
        const parsed: unknown = JSON.parse(await Bun.file(file).text());
        return { file: relative(root, file), parsed };
      }),
  );
  const ours = results.filter(
    (read): read is { file: string; parsed: Result } =>
      typeof read.parsed === "object" &&
      read.parsed !== null &&
      "tool" in read.parsed &&
      read.parsed.tool === TOOL,
  );
  const match = ours.findLast(({ parsed }) => sameMeasurement(parsed, plan));
  return match === undefined ? null : { file: match.file, held: match.parsed.held };
}

/** `2026-11-20T18:37:02.062Z` as `20261120T183702Z`, which sorts as it reads. */
function stampOf(iso: string): string {
  return `${iso.slice(0, 19).replaceAll(/[-:]/gu, "")}Z`;
}

/**
 * The ramp, from the health check to the result. What it hits, the caller
 * named: nothing here reads a workflow or a config file.
 */
export async function ramp(plan: Plan, machine: Machine, root: string): Promise<Outcome> {
  if (plan.script !== null) {
    const owned = await stepOptionsIn(machine.k6, plan.script, root);
    if (owned.length > 0) {
      throw new WrongArguments(
        `--script ${plan.script} sets ${owned.join(", ")}, and the steps are this command's: remove ${owned.length === 1 ? "it" : "them"} from the script's options`,
      );
    }
  }
  machine.log(announced(plan));
  const startedAt = new Date().toISOString();
  const unanswered = await answers(plan.health, machine.signal);
  if (unanswered !== undefined) return { unmeasured: unanswered };

  const scratch = await mkdtemp(join(tmpdir(), "capacity-ramp-"));
  try {
    const steps: StepMeasured[] = [];
    for (const users of plan.steps) {
      if (machine.signal.aborted) {
        return { unmeasured: `the run was stopped before the step of ${users} users` };
      }
      machine.log(
        `  step ${steps.length + 1} of ${plan.steps.length}: ${users} users for ${plan.holdMs / 1000}s`,
      );
      const step = await runStep(plan, users, machine, root, scratch);
      if ("unmeasured" in step) return step;
      steps.push(step);
      machine.log(`    ${verdictOf(step)}`);
      if (step.broke.length > 0) break;
    }
    const broken = steps.find((step) => step.broke.length > 0);
    return {
      result: {
        tool: TOOL,
        startedAt,
        k6: machine.k6Version,
        target: { health: plan.health, paths: plan.paths, script: plan.script },
        ladder: { steps: plan.steps, holdMs: plan.holdMs },
        bounds: plan.bounds,
        held: steps.findLast((step) => step.broke.length === 0)?.users ?? null,
        broke: broken === undefined ? null : { users: broken.users, bounds: broken.broke },
        steps,
        previous: await previousOf(root, plan),
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function failuresOf(step: StepMeasured): string {
  const listed = Object.entries(step.failures)
    .toSorted(([, a], [, b]) => b - a)
    .map(([status, count]) => `${status === "0" ? "no answer" : status} ×${count}`);
  return listed.length === 0
    ? percent(step.failed)
    : `${percent(step.failed)} (${listed.join(", ")})`;
}

const BOUND_NAMES = { failed: "failed requests", p95: "p95" } satisfies Record<Bound, string>;

function verdictOf(step: StepMeasured): string {
  const measured = `${step.requests} requests, ${failuresOf(step)} failed, p95 ${step.p95Ms.toFixed(1)} ms`;
  return step.broke.length === 0
    ? `held: ${measured}`
    : `broke on ${step.broke.map((bound) => BOUND_NAMES[bound]).join(" and ")}: ${measured}`;
}

function usersOf(held: number | null): string {
  return held === null ? "no step" : `${held} users`;
}

/** The result as a person reads it: the same headings and tables for every run. */
export function markdownOf(result: Result): string {
  const { target, bounds, ladder: steps } = result;
  const deciding = result.steps.at(-1);
  return [
    `# Capacity ramp, ${stampOf(result.startedAt)}`,
    "",
    `- Target: ${target.health}${target.paths.length === 0 ? "" : `, paths ${target.paths.join(", ")}`}`,
    `- Script: ${target.script ?? "the one capacity-ramp ships"}`,
    `- Steps: ${steps.steps.join(", ")} simultaneous users, each held ${steps.holdMs / 1000}s, k6 ${result.k6}`,
    `- Bounds: a step breaks past ${percent(bounds.failed)} failed requests or a p95 of ${bounds.p95Ms} ms`,
    "",
    "## Verdict",
    "",
    `- Held: ${usersOf(result.held)}`,
    `- Broke: ${result.broke === null ? "no step broke a bound" : `${result.broke.users} users, on ${result.broke.bounds.map((bound) => BOUND_NAMES[bound]).join(" and ")}`}`,
    `- Previous run: ${result.previous === null ? "none for this target, these paths and these bounds" : `${usersOf(result.previous.held)} held, in ${result.previous.file}`}`,
    "",
    "## Steps",
    "",
    "| Users | Requests | Failed | p95 | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...result.steps.map(
      (step) =>
        `| ${step.users} | ${step.requests} | ${failuresOf(step)} | ${step.p95Ms.toFixed(1)} ms | ${step.broke.length === 0 ? "held" : `broke: ${step.broke.map((bound) => BOUND_NAMES[bound]).join(", ")}`} |`,
    ),
    "",
    `## Slowest paths at ${deciding?.users ?? 0} users`,
    "",
    "| Path | Requests | Failed | p95 |",
    "| --- | --- | --- | --- |",
    ...(deciding?.paths ?? []).map(
      (path) =>
        `| ${path.method} ${path.name} | ${path.requests} | ${percent(path.failed)} | ${path.p95Ms.toFixed(1)} ms |`,
    ),
    "",
  ].join("\n");
}

/** Writes both files, refusing to overwrite one, and answers their paths. */
export async function recorded(
  root: string,
  result: Result,
): Promise<{ json: string; md: string }> {
  const directory = join(root, RESULTS);
  await mkdir(directory, { recursive: true });
  const base = join(directory, stampOf(result.startedAt));
  const json = `${base}.json`;
  const md = `${base}.md`;
  await writeFile(json, `${JSON.stringify(result, undefined, 2)}\n`, { flag: "wx" });
  await writeFile(md, markdownOf(result), { flag: "wx" });
  return { json, md };
}
