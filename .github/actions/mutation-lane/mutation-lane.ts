import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  baseRevision,
  type ConfigObject,
  type Event,
  git,
  isObject,
  jsonObjects,
  kindOf,
  type Problem,
} from "../_lib/gate.ts";

/**
 * The two packages a repo declares to run this lane, named in the diagnostic
 * that asks for them. Stryker resolves a plugin by name from the working
 * directory, so both have to be in the repo's own install — which is also what
 * puts them under its lockfile, its exact pins and its release-age window,
 * rather than under a fetch this action performs at run time.
 */
const CORE = "@stryker-mutator/core";
const RUNNER = "@hughescr/stryker-bun-runner";

const READS_THE_BASE_REF =
  "the lane mutates what this branch changed, and the base ref is what changed is measured against";

/**
 * A mutant nothing distinguished from the code it replaced, which is the whole
 * finding. `NoCoverage` is the same statement one step earlier — no test ran
 * the line at all — so both are undetected and both are worth the same
 * diagnostic, differing only in what the reader has to write.
 */
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/** A mutant the suite caught, either by failing or by hanging until Stryker gave up. */
const DETECTED = new Set(["Killed", "Timeout"]);

/**
 * What a repo declares its pure domain to be — the same element the layer rule
 * already reads, so that "pure domain" has one definition per repo rather than
 * a lint config and a gate input that can disagree. README's "Architecture
 * boundaries" is the shape; a `pattern` there names a folder, so everything
 * under it is domain.
 */
const OXLINTRC = ".oxlintrc.json";
const DOMAIN = "domain";

/** Files Stryker is pointed at: source in the domain, never a declaration file and never a test. */
function isMutable(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!/\.(?:ts|tsx|mts|cts)$/.test(name)) return false;
  return !name.endsWith(".d.ts") && !/\.(?:test|spec)\./.test(name);
}

export interface Lane {
  /** One line for the log saying what the lane did, whichever way it went. */
  readonly note: string;
  /** The measurement, for the step summary. Absent when nothing was mutated. */
  readonly table: string | undefined;
  readonly problems: Problem[];
}

function nothing(note: string, problems: Problem[] = []): Lane {
  return { note, table: undefined, problems };
}

/** The domain folders `.oxlintrc.json` declares, or the diagnostic for a repo that declares none. */
async function domainGlobs(root: string): Promise<string[] | Problem> {
  const declare = `declare the pure domain as a boundaries element in ${OXLINTRC} — \`{ "type": "${DOMAIN}", "pattern": "src/domain" }\` — the lane mutates exactly what the layer rule keeps pure`;
  if (!(await Bun.file(join(root, OXLINTRC)).exists())) {
    return { file: OXLINTRC, message: declare };
  }

  // In oxlint's own dialect, not strict JSON: its schema declares
  // `allowComments`, and README asks a repo to write the reason for an override
  // beside it — so the file the linter reads happily is one `JSON.parse` refuses.
  const { read, problems } = await jsonObjects(root, [OXLINTRC], "JSON with comments");
  const refused = problems[0];
  if (refused !== undefined) return refused;
  const config = read[0]?.value ?? {};

  const settings = config["settings"];
  const elements = isObject(settings) ? settings["boundaries/elements"] : undefined;
  const patterns = (Array.isArray(elements) ? elements : [])
    .filter(isObject)
    .filter((element) => element["type"] === DOMAIN)
    .map((element) => element["pattern"])
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map((pattern) => `${pattern.replace(/\/+$/, "")}/**`);

  return patterns.length > 0 ? patterns : { file: OXLINTRC, message: declare };
}

/**
 * The lines this branch wrote, per file. `--unified=0` is what makes the answer
 * lines rather than neighbourhoods: with context the hunk header covers
 * untouched lines either side, and a mutant sitting in one of them would be
 * reported as something this branch introduced.
 */
async function changedLines(root: string, rev: string, file: string): Promise<Set<number>> {
  const diff = await git(root, ["diff", "--unified=0", rev, "--", file]);
  const lines = new Set<number>();
  for (const [, from = "", span] of diff.stdout.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(from);
    const count = span === undefined ? 1 : Number(span);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}

interface Mutant {
  readonly from: number;
  readonly to: number;
  readonly mutator: string;
  readonly replacement: string;
  readonly status: string;
}

interface Mutated {
  readonly file: string;
  readonly mutants: Mutant[];
}

/**
 * Stryker's own report, parsed at the boundary rather than asserted through.
 * The mutation-testing report schema is another tool's contract, so a document
 * that is not the shape read here says so as itself instead of surfacing later
 * as a score computed over nothing.
 */
function parseReport(text: string): Mutated[] {
  const parsed: unknown = JSON.parse(text);
  const files = isObject(parsed) ? parsed["files"] : undefined;
  if (!isObject(files)) {
    throw new Error(`the mutation report has no files object — it holds ${kindOf(files)}`);
  }
  return Object.entries(files).map(([file, value]) => {
    const listed = isObject(value) ? value["mutants"] : undefined;
    if (!Array.isArray(listed)) {
      throw new Error(`the mutation report's ${file} has no mutants array`);
    }
    return { file, mutants: listed.filter(isObject).map(asMutant) };
  });
}

function asMutant(value: ConfigObject): Mutant {
  const location = isObject(value["location"]) ? value["location"] : {};
  const at = (end: string): number => {
    const point = location[end];
    const line = isObject(point) ? point["line"] : undefined;
    if (typeof line !== "number") throw new Error(`a mutant has no location.${end}.line`);
    return line;
  };
  const text = (key: string): string => {
    const found = value[key];
    return typeof found === "string" ? found : "";
  };
  return {
    from: at("start"),
    to: at("end"),
    mutator: text("mutatorName"),
    replacement: text("replacement"),
    status: text("status"),
  };
}

/**
 * Whether every line the mutant spans is one this branch wrote. Containment
 * rather than overlap, and that is the whole of what "selective" means here: a
 * mutant of the enclosing block spans a function whose body a one-line edit
 * barely touched, and failing on it would fail the branch for code it did not
 * write. The floor below is what covers what containment lets past.
 */
function inTheChange(mutant: Mutant, lines: ReadonlySet<number>): boolean {
  for (let line = mutant.from; line <= mutant.to; line += 1) {
    if (!lines.has(line)) return false;
  }
  return true;
}

function percent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

/**
 * The mutation score: what the suite caught, over what it could have. Stryker's
 * own definition — a mutant that would not compile or that the config ignored
 * is neither caught nor missed, so it is outside the ratio rather than a zero
 * in it.
 */
function scoreOf(mutants: readonly Mutant[]): number | undefined {
  const detected = mutants.filter(({ status }) => DETECTED.has(status)).length;
  const undetected = mutants.filter(({ status }) => UNDETECTED.has(status)).length;
  return detected + undetected === 0 ? undefined : detected / (detected + undetected);
}

/**
 * What the reader has to write, which is the only thing separating the two
 * undetected statuses. The replacement is in the message rather than only in
 * the summary table because a line carries several mutants — an operator and
 * the block around it — and annotations that read identically are one finding
 * as far as anyone scrolling the step is concerned.
 */
function survivorProblem(file: string, mutant: Mutant): Problem {
  const at = `line ${mutant.from}`;
  const swap = `\`${mutant.replacement}\` (${mutant.mutator})`;
  return {
    file,
    message:
      mutant.status === "NoCoverage"
        ? `write the test that reaches ${at}: this branch wrote it and nothing runs it, so ${swap} in its place goes unnoticed`
        : `write the case that fails on ${swap} at ${at}: this branch wrote that line and the suite passes either way`,
  };
}

/** The floor as a fraction, refused rather than defaulted — a default publishes a promise nobody made. */
function floorFrom(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const floor = Number(value);
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error(
      `mutation-floor is '${value}' — write it as a fraction between 0 and 1, the way bunfig.toml's coverageThreshold is written`,
    );
  }
  return floor;
}

/** How Stryker is asked to mutate exactly these files with the house runner. */
function strykerConfig(mutate: readonly string[], report: string): string {
  return JSON.stringify({
    testRunner: "bun",
    coverageAnalysis: "perTest",
    plugins: [RUNNER],
    mutate,
    reporters: ["json"],
    jsonReporter: { fileName: report },
  });
}

export interface Input {
  readonly root: string;
  readonly event: Event;
  /** The score the changed files must hold, as a fraction. Empty publishes the score and fails on nothing. */
  readonly floor: string;
}

/**
 * Mutates what this branch changed inside the repo's pure domain, publishes the
 * score, and fails on a mutant the branch's own lines left undetected.
 *
 * Selective because the alternative is not affordable: a full campaign over a
 * domain layer is minutes to hours, and a gate that costs that runs nightly or
 * not at all. What a pull request can be held to is the code in it.
 */
export async function mutationLane({ root, event, floor }: Input): Promise<Lane> {
  const bound = floorFrom(floor);

  const globs = await domainGlobs(root);
  if (!Array.isArray(globs)) return nothing("the pure domain is not declared", [globs]);

  const base = await baseRevision(root, event, READS_THE_BASE_REF);
  if ("refused" in base)
    return nothing("the base ref could not be read", [{ message: base.refused }]);
  if (base.rev === undefined) {
    return nothing("there is no earlier commit to compare against — nothing to mutate");
  }
  const rev = base.rev;

  // `--diff-filter=d` drops what this branch deleted: Stryker is handed paths
  // to read, and a file that is gone is not a gap in the lane's coverage.
  const listed = await git(root, ["diff", "--name-only", "--diff-filter=d", rev, "--"]);
  if (!listed.ok) throw new Error(`git diff against ${rev} failed in ${root}`);
  const matchers = globs.map((glob) => new Bun.Glob(glob));
  const mutate = listed.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "" && isMutable(path))
    .filter((path) => matchers.some((glob) => glob.match(path)));

  if (mutate.length === 0) {
    return nothing(`no domain file changed against ${rev.slice(0, 12)} — nothing to mutate`);
  }

  const stryker = join(root, "node_modules", ".bin", "stryker");
  if (!(await Bun.file(stryker).exists())) {
    return nothing("the mutation runner is not installed", [
      {
        file: "package.json",
        message: `add ${CORE} and ${RUNNER} to devDependencies — the lane runs the repo's own install, so the versions are the ones its lockfile pins`,
      },
    ]);
  }

  const scratch = await mkdtemp(join(tmpdir(), "mutation-lane-"));
  try {
    const config = join(scratch, "stryker.conf.json");
    const report = join(scratch, "mutation.json");
    await Bun.write(config, strykerConfig(mutate, report));

    const proc = Bun.spawn([stryker, "run", config], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const status = await proc.exited;
    if (status !== 0) {
      return nothing("the mutation run did not finish", [
        {
          message: `run \`bunx stryker run\` over ${mutate.join(", ")} to see it: the run exited ${status} — ${lastLines(`${out}\n${err}`)}`,
        },
      ]);
    }

    return await verdict(await Bun.file(report).text(), { root, rev, bound });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The tail of a failed run's output, which is where the reason for it is. */
function lastLines(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(-5)
      .join(" / ") || "it wrote nothing"
  );
}

interface Verdict {
  readonly root: string;
  readonly rev: string;
  readonly bound: number | undefined;
}

/** What the report says, as the score to publish and the mutants to fail on. */
async function verdict(text: string, { root, rev, bound }: Verdict): Promise<Lane> {
  const mutated = parseReport(text);
  const mutants = mutated.flatMap(({ mutants: each }) => each);
  const score = scoreOf(mutants);

  const introduced = await Promise.all(
    mutated.map(async ({ file, mutants: each }) => {
      const lines = await changedLines(root, rev, file);
      return each
        .filter(({ status }) => UNDETECTED.has(status))
        .filter((mutant) => inTheChange(mutant, lines))
        .map((mutant) => ({ file, mutant }));
    }),
  );
  const surviving = introduced.flat();

  const files = `${mutated.length} changed domain file${mutated.length === 1 ? "" : "s"}`;
  if (score === undefined) {
    return { note: `${files} held no mutants`, table: undefined, problems: [] };
  }

  const problems = surviving.map(({ file, mutant }) => survivorProblem(file, mutant));
  if (bound !== undefined && score < bound) {
    problems.push({
      message: `kill the mutants listed in the run summary: ${percent(score)} of the mutants in ${files} were caught, under the ${percent(bound)} floor this repo declares`,
    });
  }

  return {
    note: `mutation score ${percent(score)} over ${files}`,
    table: table(score, mutants, surviving, bound),
    problems,
  };
}

interface Surviving {
  readonly file: string;
  readonly mutant: Mutant;
}

/** The measurement, in the shape the coverage floor's own README paragraph argues for. */
function table(
  score: number,
  mutants: readonly Mutant[],
  surviving: readonly Surviving[],
  bound: number | undefined,
): string {
  return [
    "### Mutation lane",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    `| Mutation score (changed domain files) | ${percent(score)} |`,
    `| Caught | ${mutants.filter(({ status }) => DETECTED.has(status)).length} |`,
    `| Undetected | ${mutants.filter(({ status }) => UNDETECTED.has(status)).length} |`,
    `| Undetected on this branch's own lines | ${surviving.length} |`,
    `| Floor | ${bound === undefined ? "none — published, not enforced" : percent(bound)} |`,
    "",
    ...surviving.map(
      ({ file, mutant }) =>
        `- \`${file}:${mutant.from}\` ${mutant.mutator} → \`${mutant.replacement}\` (${mutant.status})`,
    ),
    "",
    "A floor, not a target: it catches a change that shipped without the test that",
    "pins it. Raise it only once the score comfortably exceeds it.",
    "",
  ].join("\n");
}
