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
import { isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * How long a request the shipped script sends has to answer before k6 records
 * it as getting no answer, which is k6's own default grace at the end of a step.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long k6 lets a step's last iterations run past its hold before it cuts
 * them off. Five seconds over the shipped script's request timeout, so k6 has
 * recorded every request that script sent, answered or not, before it cuts
 * anything off.
 */
const GRACE_MS = REQUEST_TIMEOUT_MS + 5_000;

export const USAGE = `capacity-ramp --health <url> [--path </path>]... [--script <k6 script>]
              [--start-users ${DEFAULTS["start-users"]}] [--max-users ${DEFAULTS["max-users"]}] [--hold ${DEFAULTS.hold}]
              [--max-failed ${DEFAULTS["max-failed"]}] [--max-p95 ${DEFAULTS["max-p95"]}]

Doubles the simultaneous users from --start-users to --max-users, holds each
step for --hold (1s or more), and stops at the first step whose failed requests
exceed --max-failed or whose 95th percentile of response time exceeds --max-p95.
Writes capacity/<UTC stamp>.json and .md at the root of this repository.
Never point it at a live deployment or at a server on live data:
docs/commands/capacity-ramp.md in @gokayo43/dev-config says why.`;

/** The command line cannot be read as a run: exit 2, with the usage. */
export class WrongArguments extends Error {}

/** The run ends without a measurement: exit 1, and no result is written. */
export class Unmeasured extends Error {}

export interface Bounds {
  /** The share of requests that may fail, 0 to 1. */
  readonly failed: number;
  readonly p95Ms: number;
}

export interface Plan {
  readonly health: string;
  readonly paths: readonly string[];
  /** The repo's own k6 script as an absolute path, or nothing for the shipped one. */
  readonly script: string | null;
  readonly steps: readonly [number, ...number[]];
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

function durationMs(flag: string, value: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  if (match === null) {
    throw new WrongArguments(
      `--${flag} is "${value}" — write a duration in ms, s or m, such as 30s`,
    );
  }
  const ms = Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1000 : 1);
  if (ms === 0) {
    throw new WrongArguments(`--${flag} is "${value}" — it has to be longer than nothing`);
  }
  return ms;
}

function share(flag: string, value: string): number {
  const match = /^(\d+(?:\.\d+)?)%$/u.exec(value);
  if (match === null || Number(match[1]) >= 100) {
    throw new WrongArguments(`--${flag} is "${value}" — write a percentage below 100, such as 1%`);
  }
  return Number(match[1]) / 100;
}

/** Each step twice the one before it, from the first to the last, the last being the maximum itself. */
function ladder(start: number, max: number): [number, ...number[]] {
  if (start > max) {
    throw new WrongArguments(`--start-users ${start} is above --max-users ${max}`);
  }
  const steps: [number, ...number[]] = [start];
  for (let users = start * 2; users < max; users *= 2) steps.push(users);
  if (max > start) steps.push(max);
  return steps;
}

/**
 * The command line as the run it asks for, with a relative `--script` read
 * from `cwd`; anything it cannot be read as throws `WrongArguments`.
 */
export function planFrom(args: readonly string[], cwd: string): Plan {
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
  const holdMs = durationMs("hold", values.hold);
  if (holdMs < 1000) {
    throw new WrongArguments(`--hold is "${values.hold}" — k6 holds a step for 1s at the least`);
  }

  return {
    health,
    paths,
    script: values.script === undefined ? null : resolve(cwd, values.script),
    steps: ladder(
      wholeNumber("start-users", values["start-users"]),
      wholeNumber("max-users", values["max-users"]),
    ),
    holdMs,
    bounds: {
      failed: share("max-failed", values["max-failed"]),
      p95Ms: durationMs("max-p95", values["max-p95"]),
    },
  };
}

/**
 * What makes two runs' held steps comparable: the same k6, aimed at the same
 * target the same way, up the same ladder, judged by the same bounds. Stored
 * in every result and compared whole, so what a result records and what the
 * next run compares it on are one value.
 */
export interface Measurement {
  readonly k6: string;
  readonly health: string;
  /** Sorted: the same paths named in another order are the same measurement. */
  readonly paths: readonly string[];
  /** The repo's own script relative to the repository root, or nothing for the shipped one. */
  readonly script: string | null;
  readonly steps: readonly number[];
  readonly holdMs: number;
  readonly bounds: Bounds;
}

function measurementOf(plan: Plan, k6Version: string, root: string): Measurement {
  return {
    k6: k6Version,
    health: plan.health,
    paths: plan.paths.toSorted(),
    script: plan.script === null ? null : relative(root, plan.script),
    steps: plan.steps,
    holdMs: plan.holdMs,
    bounds: plan.bounds,
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
  /** Every request the step sent, the ones cut off included. */
  readonly requests: number;
  /** The share of requests that failed, 0 to 1. */
  readonly failed: number;
  readonly p95Ms: number;
  /** Failed requests by status; `0` is a request that got no answer at all. */
  readonly failures: Readonly<Record<string, number>>;
  /**
   * Iterations of the script still running when k6 cut the step off, each
   * counted as one failed request that lasted the grace, the least it can have
   * taken. No path's row carries them, since k6 records nothing of a request it
   * cuts off.
   */
  readonly cutOff: number;
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

/** What one step's output comes to, before the bounds judge it. */
interface Tallied {
  readonly paths: Map<string, Tally>;
  /** Failed requests by status. */
  readonly failures: Record<string, number>;
  /** Iterations the step started, as the counter `stepScript` adds counts them. */
  started: number;
  /** Iterations k6 counted as ended, which leaves out the ones it cut off. */
  ended: number;
}

/** The counter `stepScript` adds to at the start of every iteration. */
const STARTED = "capacity_ramp_started";

/** A JSON object's fields, or nothing where the value is not an object. */
function fieldsOf(value: unknown): ReadonlyMap<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map(Object.entries(value))
    : undefined;
}

/** One point of k6's JSON output: its value and its tags. A line of another shape is a k6 this was not written for, and throws. */
function pointIn(line: string): { readonly value: number; readonly tag: (name: string) => string } {
  const data = fieldsOf(fieldsOf(JSON.parse(line))?.get("data"));
  const value = data?.get("value");
  const tags = fieldsOf(data?.get("tags"));
  if (typeof value !== "number" || tags === undefined) {
    throw new Error(`k6 wrote a point this does not read: ${line}`);
  }
  return {
    value,
    tag: (name) => {
      const found = tags.get(name);
      if (typeof found !== "string")
        throw new Error(`k6 wrote a point with no ${name} tag: ${line}`);
      return found;
    },
  };
}

/** How each point this reads begins, which every other line of k6's output does not. */
const POINT = (metric: string): string => `{"metric":"${metric}","type":"Point"`;

/**
 * k6's JSON output as one step's tallies, read a line at a time. The file holds
 * about a dozen lines per request, every metric k6 records, so a step of a
 * million requests decompresses to most of a gigabyte: holding it whole is how
 * a ramp against a fast target runs this process out of memory. What is kept is
 * one number per request.
 */
async function talliedIn(jsonGz: string): Promise<Tallied> {
  const tallied: Tallied = { paths: new Map(), failures: {}, started: 0, ended: 0 };
  const take = (line: string): void => {
    if (line.startsWith(POINT("http_req_duration"))) {
      const { value, tag } = pointIn(line);
      const method = tag("method");
      const name = tag("name");
      const key = `${method} ${name}`;
      const tally = tallied.paths.get(key) ?? { method, name, ms: [], failed: 0 };
      tallied.paths.set(key, tally);
      tally.ms.push(value);
      if (tag("expected_response") === "false") {
        tally.failed++;
        const status = tag("status");
        tallied.failures[status] = (tallied.failures[status] ?? 0) + 1;
      }
    } else if (line.startsWith(POINT(STARTED))) {
      tallied.started += pointIn(line).value;
    } else if (line.startsWith(POINT("iterations"))) {
      tallied.ended += pointIn(line).value;
    }
  };

  let partial = "";
  const text = Bun.file(jsonGz)
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());
  for await (const chunk of text) {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  take(partial);
  return tallied;
}

/** What one step's requests come to, judged against the bounds; `null` when it sent none. */
function stepFrom(
  users: number,
  { paths, failures, started, ended }: Tallied,
  bounds: Bounds,
): StepMeasured | null {
  const tallies = [...paths.values()];
  const cutOff = started - ended;
  const durations = [
    ...tallies.flatMap((tally) => tally.ms),
    ...Array<number>(cutOff).fill(GRACE_MS),
  ];
  if (durations.length === 0) return null;
  const failed =
    (tallies.reduce((sum, tally) => sum + tally.failed, 0) + cutOff) / durations.length;
  const p95Ms = p95(durations);
  return {
    users,
    requests: durations.length,
    failed,
    p95Ms,
    failures,
    cutOff,
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
  readonly measurement: Measurement;
  /** The last step held, or nothing when the first step broke. */
  readonly held: number | null;
  /** The step that broke, or nothing when every step held. */
  readonly broke: { readonly users: number; readonly bounds: readonly Bound[] } | null;
  /** Every step run, the last of them the one that decided the run. */
  readonly steps: readonly [StepMeasured, ...StepMeasured[]];
  readonly previous: Previous | null;
}

export interface Machine {
  /** The pinned k6 binary. */
  readonly k6: string;
  readonly k6Version: string;
  /** Where progress goes, one line at a time. */
  readonly log: (line: string) => void;
  /** Stops the run: what was measured so far is not a result. */
  readonly signal: AbortSignal;
}

/** The run was stopped, which ends it without a measurement however far it got. */
function unlessStopped(signal: AbortSignal, when: string): void {
  if (signal.aborted) throw new Unmeasured(`the run was stopped ${when}`);
}

const K6_LOADER = join(import.meta.dir, ".github/actions/_lib/k6.sh");

/**
 * Where the pinned k6 is kept between runs: the user's own cache, which nobody
 * else can write a binary into. A relative `XDG_CACHE_HOME` is passed over, as
 * the XDG Base Directory specification says; with no absolute directory at all
 * there is no cache, and the run is refused rather than keeping k6 under
 * whatever directory it runs in, where a checkout could carry a binary and the
 * receipt that makes it trusted.
 */
function k6HomeIn(env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env["XDG_CACHE_HOME"] ?? "";
  const home = env["HOME"] ?? "";
  if (isAbsolute(xdg)) return join(xdg, "dev-config", "k6");
  if (isAbsolute(home)) return join(home, ".cache", "dev-config", "k6");
  throw new Unmeasured(
    "neither XDG_CACHE_HOME nor HOME names an absolute directory, so there is no cache to keep the pinned k6 in",
  );
}

/**
 * The pinned k6, fetched and verified by the one loader every ramp here uses,
 * or reused where it already sits under that pin. `env` is the environment the
 * loader runs in and the cache is read from.
 */
export async function pinnedK6(
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<{ k6: string; version: string }> {
  const home = k6HomeIn(env);
  await mkdir(home, { recursive: true });
  const loader = Bun.spawn(
    [
      "bash",
      "-c",
      `. "$1" "$2" >&2 && printf '%s\\n%s\\n' "$K6" "$K6_VERSION"`,
      "k6",
      K6_LOADER,
      home,
    ],
    { env: { ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const stop = (): void => {
    loader.kill();
  };
  signal.addEventListener("abort", stop);
  const [out, err, code] = await Promise.all([
    new Response(loader.stdout).text(),
    new Response(loader.stderr).text(),
    loader.exited,
  ]);
  signal.removeEventListener("abort", stop);
  unlessStopped(signal, "while the pinned k6 was being fetched, before the first step");
  const [k6 = "", version = ""] = out.trim().split("\n");
  if (code !== 0 || k6 === "") {
    throw new Unmeasured(
      `fetching the pinned k6 failed, its loader exiting ${code}:\n${err.trim()}`,
    );
  }
  return { k6, version };
}

/** The script options that set steps of their own, which would make two owners of the ladder. */
const STEP_OPTIONS = ["vus", "duration", "iterations", "stages", "scenarios"];

/** The options a repo's script sets that only the ladder may set, by name, as `k6 inspect` reads them. */
async function stepOptionsIn(
  k6: string,
  script: string,
  named: string,
  cwd: string,
): Promise<string[]> {
  const inspect = Bun.spawn([k6, "inspect", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(inspect.stdout).text(),
    new Response(inspect.stderr).text(),
    inspect.exited,
  ]);
  if (code !== 0) throw new WrongArguments(`k6 cannot read --script ${named}:\n${err.trim()}`);
  const options = fieldsOf(JSON.parse(out));
  if (options === undefined) {
    throw new Error(`k6 inspect answered something other than an object of options: ${out}`);
  }
  return STEP_OPTIONS.filter((option) => (options.get(option) ?? null) !== null);
}

const SHIPPED_SCRIPT = join(import.meta.dir, "capacity-ramp.js");

/**
 * The module k6 runs for one step: the script, whichever it is, under a
 * scenario of the step's users, hold and grace, with a counter added at the
 * start of each iteration. The counter is how a step knows what k6 cut off,
 * since an iteration cut off is never counted among those that ended.
 */
function stepScript(script: string, users: number, holdMs: number): string {
  const scenario = {
    executor: "constant-vus",
    vus: users,
    duration: `${holdMs}ms`,
    gracefulStop: `${GRACE_MS}ms`,
  };
  return [
    'import { Counter } from "k6/metrics";',
    `import * as script from ${JSON.stringify(script)};`,
    `export * from ${JSON.stringify(script)};`,
    `const started = new Counter("${STARTED}");`,
    `export const options = { ...script.options, scenarios: { step: ${JSON.stringify(scenario)} } };`,
    "export default function (data) {",
    "  started.add(1);",
    "  return script.default(data);",
    "}",
    "",
  ].join("\n");
}

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
): Promise<StepMeasured> {
  const script = join(scratch, `${users}.js`);
  await writeFile(script, stepScript(plan.script ?? SHIPPED_SCRIPT, users, plan.holdMs));
  const output = join(scratch, `${users}.json.gz`);
  const k6 = Bun.spawn(
    [
      machine.k6,
      "run",
      "--quiet",
      "--no-usage-report",
      "--no-thresholds",
      "--summary-mode=disabled",
      "--system-tags=method,name,status,expected_response",
      `--out=json=${output}`,
      script,
    ],
    {
      cwd,
      env: {
        ...process.env,
        HEALTH_URL: plan.health,
        CAPACITY_PATH: plan.paths.join("\n"),
        CAPACITY_TIMEOUT: `${REQUEST_TIMEOUT_MS}ms`,
      },
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

  unlessStopped(machine.signal, `during the step of ${users} users, before it finished`);
  if (code !== 0) {
    throw new Unmeasured(
      `k6 exited ${code} during the step of ${users} users:\n${tail.join("\n")}`,
    );
  }
  const step = stepFrom(users, await talliedIn(output), plan.bounds);
  if (step === null) {
    throw new Unmeasured(
      `k6 recorded no request in the step of ${users} users: the script sent none`,
    );
  }
  return step;
}

/** Before the first request: what the run will hit, how hard and for how long at most. */
function announced(plan: Plan, root: string): string {
  // The shipped script's own join, so the address printed is the address hit.
  const origin = new URL(plan.health).origin;
  const what =
    plan.script === null
      ? [plan.health, ...plan.paths.map((path) => `${origin}${path}`)].join(", ")
      : `${relative(root, plan.script)}, with HEALTH_URL=${plan.health}${plan.paths.length === 0 ? "" : ` and CAPACITY_PATH=${plan.paths.join(" ")}`}`;
  const longest = (plan.steps.length * (plan.holdMs + GRACE_MS)) / 1000;
  return [
    `capacity-ramp: about to hit ${what}`,
    `  ${plan.steps.join(", ")} simultaneous users, each step held ${plan.holdMs / 1000}s and given up to ${GRACE_MS / 1000}s more for the requests still running: up to ${longest}s of load, stopping at the first step past ${percent(plan.bounds.failed)} failed requests or a p95 of ${plan.bounds.p95Ms} ms`,
  ].join("\n");
}

async function healthCheck(health: string, signal: AbortSignal): Promise<void> {
  const unanswered = await fetch(health, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
    .then(async (response) => {
      await response.arrayBuffer();
      return response.ok ? undefined : `answered ${response.status}`;
    })
    .catch(
      (error: unknown) =>
        `did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  unlessStopped(signal, "during the health check, before the first step");
  if (unanswered !== undefined) throw new Unmeasured(`${health} ${unanswered}`);
}

/** The directory every result is written into, at the repository's root. */
export const RESULTS = "capacity";

/**
 * A result file's held step where it is a result of this measurement, and
 * nothing where it is anything else: another tool's file, one that does not
 * parse, one cut short, or a result of another measurement or of an older
 * shape.
 */
function heldIn(text: string, measurement: Measurement): { held: number | null } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const fields = fieldsOf(parsed);
  const held = fields?.get("held");
  const ours =
    fields?.get("tool") === TOOL && Bun.deepEquals(fields.get("measurement"), measurement, true);
  const readable =
    held === null || (typeof held === "number" && Number.isInteger(held) && held > 0);
  return ours && readable ? { held } : undefined;
}

/** The latest earlier result of the same measurement, read before the run puts any load on the target. */
async function previousOf(root: string, measurement: Measurement): Promise<Previous | null> {
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
        return {
          file: relative(root, file),
          read: heldIn(await Bun.file(file).text(), measurement),
        };
      }),
  );
  const match = results.findLast(({ read }) => read !== undefined);
  return match?.read === undefined ? null : { file: match.file, held: match.read.held };
}

/** `2026-11-20T18:37:02.062Z` as `20261120T183702.062Z`, which sorts as it reads. */
function stampOf(iso: string): string {
  return iso.replaceAll(/[-:]/gu, "");
}

/**
 * The ramp, from the health check to the result. What it hits, the caller
 * named: nothing here reads a workflow or a config file. A run that ends
 * without a measurement throws `Unmeasured`, and a script that sets steps of
 * its own throws `WrongArguments`.
 */
export async function ramp(plan: Plan, machine: Machine, root: string): Promise<Result> {
  if (plan.script !== null) {
    const named = relative(root, plan.script);
    const owned = await stepOptionsIn(machine.k6, plan.script, named, root);
    unlessStopped(machine.signal, "while the script was read, before the first step");
    if (owned.length > 0) {
      throw new WrongArguments(
        `--script ${named} sets ${owned.join(", ")}, and the steps are this command's: remove ${owned.length === 1 ? "it" : "them"} from the script's options`,
      );
    }
  }
  const measurement = measurementOf(plan, machine.k6Version, root);
  const previous = await previousOf(root, measurement);
  machine.log(announced(plan, root));
  const startedAt = new Date().toISOString();
  await healthCheck(plan.health, machine.signal);

  const scratch = await mkdtemp(join(tmpdir(), "capacity-ramp-"));
  try {
    const measured = async (users: number, at: number): Promise<StepMeasured> => {
      unlessStopped(machine.signal, `before the step of ${users} users`);
      machine.log(
        `  step ${at} of ${plan.steps.length}: ${users} users for ${plan.holdMs / 1000}s`,
      );
      const step = await runStep(plan, users, machine, root, scratch);
      machine.log(`    ${verdictOf(step)}`);
      return step;
    };
    const [first, ...more] = plan.steps;
    let last = await measured(first, 1);
    let held: number | null = null;
    const steps: [StepMeasured, ...StepMeasured[]] = [last];
    for (const users of more) {
      if (last.broke.length > 0) break;
      held = last.users;
      last = await measured(users, steps.length + 1);
      steps.push(last);
    }
    return {
      tool: TOOL,
      startedAt,
      measurement,
      held: last.broke.length === 0 ? last.users : held,
      broke: last.broke.length === 0 ? null : { users: last.users, bounds: last.broke },
      steps,
      previous,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function failuresOf(step: StepMeasured): string {
  const listed = [
    ...Object.entries(step.failures)
      .toSorted(([, a], [, b]) => b - a)
      .map(([status, count]) => `${status === "0" ? "no answer" : status} ×${count}`),
    ...(step.cutOff === 0 ? [] : [`cut off ×${step.cutOff}`]),
  ];
  return listed.length === 0
    ? percent(step.failed)
    : `${percent(step.failed)} (${listed.join(", ")})`;
}

const BOUND_NAMES = { failed: "failed requests", p95: "p95" } satisfies Record<Bound, string>;

function boundsNamed(bounds: readonly Bound[]): string {
  return bounds.map((bound) => BOUND_NAMES[bound]).join(" and ");
}

function verdictOf(step: StepMeasured): string {
  const measured = `${step.requests} requests, ${failuresOf(step)} failed, p95 ${step.p95Ms.toFixed(1)} ms`;
  return step.broke.length === 0
    ? `held: ${measured}`
    : `broke on ${boundsNamed(step.broke)}: ${measured}`;
}

function usersOf(held: number | null): string {
  return held === null ? "no step" : `${held} users`;
}

/** The result as a person reads it: the same headings and tables for every run. */
export function markdownOf(result: Result): string {
  const { measurement } = result;
  const [first, ...rest] = result.steps;
  const deciding = rest.at(-1) ?? first;
  return [
    `# Capacity ramp, ${stampOf(result.startedAt)}`,
    "",
    `- Target: ${measurement.health}${measurement.paths.length === 0 ? "" : `, paths ${measurement.paths.join(", ")}`}`,
    `- Script: ${measurement.script ?? "the one capacity-ramp ships"}`,
    `- Steps: ${measurement.steps.join(", ")} simultaneous users, each held ${measurement.holdMs / 1000}s, k6 ${measurement.k6}`,
    `- Bounds: a step breaks past ${percent(measurement.bounds.failed)} failed requests or a p95 of ${measurement.bounds.p95Ms} ms`,
    "",
    "## Verdict",
    "",
    `- Held: ${usersOf(result.held)}`,
    `- Broke: ${result.broke === null ? "no step broke a bound" : `${result.broke.users} users, on ${boundsNamed(result.broke.bounds)}`}`,
    `- Previous run: ${result.previous === null ? "none of this measurement: the same k6, target, paths, script, steps, hold and bounds" : `${usersOf(result.previous.held)} held, in ${result.previous.file}`}`,
    "",
    "## Steps",
    "",
    "| Users | Requests | Failed | p95 | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...result.steps.map(
      (step) =>
        `| ${step.users} | ${step.requests} | ${failuresOf(step)} | ${step.p95Ms.toFixed(1)} ms | ${step.broke.length === 0 ? "held" : `broke: ${boundsNamed(step.broke)}`} |`,
    ),
    "",
    `## Slowest paths at ${deciding.users} users`,
    "",
    "| Path | Requests | Failed | p95 |",
    "| --- | --- | --- | --- |",
    ...deciding.paths.map(
      (path) =>
        `| ${path.method} ${path.name} | ${path.requests} | ${percent(path.failed)} | ${path.p95Ms.toFixed(1)} ms |`,
    ),
    "",
  ].join("\n");
}

/**
 * Writes both files, refusing to overwrite one, and answers their paths. The
 * JSON is written last, since it is the half the next run's `Previous run`
 * reads: a run that dies between the two leaves a page and no record.
 */
export async function recorded(
  root: string,
  result: Result,
): Promise<{ json: string; md: string }> {
  const directory = join(root, RESULTS);
  await mkdir(directory, { recursive: true });
  const base = join(directory, stampOf(result.startedAt));
  const json = `${base}.json`;
  const md = `${base}.md`;
  await writeFile(md, markdownOf(result), { flag: "wx" });
  await writeFile(json, `${JSON.stringify(result, undefined, 2)}\n`, { flag: "wx" });
  return { json, md };
}
