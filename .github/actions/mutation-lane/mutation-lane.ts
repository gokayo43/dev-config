import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import manifest from "../../../package.json" with { type: "json" };

import { branchChange } from "../_lib/change-set.ts";
import {
  type ConfigObject,
  type Event,
  isList,
  isObject,
  plural,
  type Problem,
  readConfig,
  type Verdict,
} from "../_lib/gate.ts";
import { onPath, ran } from "./child.ts";
import { machineProblems } from "./machine.ts";
import { verdict } from "./report.ts";
import {
  BUNFIG,
  bunfigTest,
  changedNoun,
  namedFiles,
  TESTS_INPUT,
  type Tests,
  testFilesConfig,
  testsCause,
  testsFrom,
  testsNoted,
  retried,
  unmutatedRun,
} from "./tests.ts";
import { type Answer, span, strings } from "./values.ts";

/**
 * The two packages a repo declares to run this lane, named in the diagnostic
 * that asks for them. Stryker resolves a plugin by name from the working
 * directory, so both have to be in the repo's own install — which is also what
 * puts them under its lockfile, its exact pins and its release-age window,
 * rather than under a fetch this action performs at run time. `knip.base.ts`
 * carries the same two names, for the same reason from the other side.
 */
const CORE = "@stryker-mutator/core";
const RUNNER = "@hughescr/stryker-bun-runner";

/**
 * The pair as the diagnostic asks for it, versions included, read from this
 * repo's own devDependencies in the action's checkout: that install is the one
 * every case in `tests/mutation-lane.test.ts` runs the lane against, so it is
 * the one pair the lane is known to run on, and a bare `bun add` may resolve a
 * pair the runner's peer range does not hold.
 */
const DECLARE = `${CORE}@${manifest.devDependencies[CORE]} and ${RUNNER}@${manifest.devDependencies[RUNNER]}`;

const READS_THE_BASE_REF =
  "the lane mutates what this branch changed, and the base ref is what changed is measured against";

/**
 * What a repo declares its pure domain to be — the same element the layer rule
 * already reads, so that "pure domain" has one definition per repo rather than
 * a lint config and a gate input that can disagree. README's "Architecture
 * boundaries" is the shape.
 */
const OXLINTRC = ".oxlintrc.json";
const DOMAIN = "domain";

/**
 * The checkout the action runs from, which holds the lint base as shipped at
 * the ref the consumer pinned its action to. That is the base its
 * `.oxlintrc.json` extends only while its action pin and its package pin name
 * one release.
 */
const ACTION_CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const LINT_BASE = "oxlint.base.json";

/**
 * A rule the base turns on in its test override and nowhere else, which is how
 * that override is found: by what it decides, not by a glob it happens to hold.
 */
const TEST_OVERRIDE_RULE = "anti-slop/no-unfailable-assertions";

/**
 * The names of the files the lint base treats as test code — the suites and
 * the harnesses and fixtures beside them — read off its test override, so the
 * lane and the linter mean one set by "test code" and the set has one home.
 * Each glob is matched against a basename, the way the override's `**\/`
 * prefix reaches a file at any depth.
 */
export function testCodeNames(base: ConfigObject): Answer<readonly string[]> {
  const overrides = isList(base["overrides"]) ? base["overrides"] : [];
  const found = overrides
    .filter(isObject)
    .filter(
      (override) =>
        isObject(override["rules"]) && override["rules"][TEST_OVERRIDE_RULE] !== undefined,
    );
  const [override, ...rest] = found;
  if (override === undefined || rest.length > 0) {
    throw new Error(
      `the action's own ${LINT_BASE} has ${found.length} overrides naming ${TEST_OVERRIDE_RULE}, not one`,
    );
  }
  const names = strings(override["files"]).map((glob) => glob.replace(/^\*\*\//, ""));
  // A glob with a folder in it would be matched against a basename and match
  // nothing, so the lane would mutate that test code and say nothing.
  const folders = names.filter((name) => name.includes("/"));
  if (folders.length > 0) {
    return {
      problems: folders.map((name) => ({
        message: `the lint base's test override names \`${name}\`, which holds a folder where the lane reads a file-name pattern — write it in ${LINT_BASE} as \`**/\` and a file name, such as \`**/*.e2e.ts\`, so the lane can keep that test code out of what it mutates`,
      })),
    };
  }
  return { value: names };
}

/** The lint base as shipped in the action's own checkout, which the lane reads its test code from. */
async function shippedLintBase(): Promise<ConfigObject> {
  const base = await readConfig(ACTION_CHECKOUT, LINT_BASE);
  if (base.contents === undefined) {
    throw new Error(
      `the action's own ${LINT_BASE} did not read: ${base.problems.map((problem) => problem.message).join("; ")}`,
    );
  }
  return base.contents;
}

/**
 * Files Stryker is pointed at: source in the domain, never a declaration file,
 * never a test and never what the lint base treats as test code.
 */
function mutableBeside(testCode: readonly string[]): (path: string) => boolean {
  return (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!/\.(?:ts|tsx|mts|cts)$/.test(name)) return false;
    if (name.endsWith(".d.ts") || /\.(?:test|spec)\./.test(name)) return false;
    return !testCode.some((glob) => new Bun.Glob(glob).match(name));
  };
}

/**
 * A `pattern` as eslint-plugin-boundaries reads it: one folder or several. The
 * array form is the linter's own (`isBaseDescriptorPattern` takes a string or
 * an array of them), so a gate that took only the string form would grade half
 * a monorepo and say nothing about the other half.
 */
function patternsIn(element: ConfigObject): string[] {
  return strings(element["pattern"]);
}

/**
 * What `.oxlintrc.json` declares its pure domain to be. A config that is
 * missing or will not parse is `readConfig`'s answer verbatim — the repo contract
 * already grades that file, and this gate has nothing to add to it. The
 * diagnostics of this gate's own are for the file that reads fine: one that
 * names no domain, and one whose pattern names something that is not a folder.
 */
async function domainGlobs(root: string): Promise<Answer<string[]>> {
  const { contents, problems } = await readConfig(root, OXLINTRC);
  if (contents === undefined) return { problems };

  const settings = contents["settings"];
  const elements = isObject(settings) ? settings["boundaries/elements"] : undefined;
  const globs = (isList(elements) ? elements : [])
    .filter(isObject)
    .filter((element) => element["type"] === DOMAIN)
    .flatMap(patternsIn)
    // A pattern names a folder, and a folder is often written with the slash
    // that follows it. Left on, the pathspec below asks git for `<pattern>//**`
    // and matches nothing — which is the shape a gate takes when it silently
    // stops gating.
    .map((pattern) => pattern.replace(/\/+$/, ""));

  if (globs.length === 0) {
    return {
      problems: [
        {
          file: OXLINTRC,
          message: `declare the pure domain as a boundaries element in ${OXLINTRC} — \`{ "type": "${DOMAIN}", "pattern": "src/domain" }\` — the lane mutates exactly what the layer rule keeps pure`,
        },
      ],
    };
  }

  const reach = await Promise.all(globs.map(async (glob) => await reaches(root, glob)));
  const named = globs.filter((_, index) => reach[index] === "a file").map(fileProblem);
  if (named.length > 0) return { problems: named };
  if (!reach.includes("a folder")) return { problems: [noFolderProblem(globs)] };
  return { value: globs };
}

/**
 * What the pattern reaches. The layer rule classifies everything *under* a
 * folder, so a pattern naming a file asks git for `<it>/**`, matches nothing,
 * and leaves the lane grading a domain of no files while reporting a clean
 * pass. Reaching nothing at all is the weaker statement — a project scaffolded
 * ahead of its domain folder, a workspace glob whose second project has none
 * yet — and it is only a problem when it is true of every pattern the repo
 * declared.
 */
async function reaches(root: string, glob: string): Promise<"a folder" | "a file" | "nothing"> {
  let hit = false;
  for (const found of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: false })) {
    hit = true;
    try {
      if ((await stat(join(root, found))).isDirectory()) return "a folder";
    } catch {
      // Gone between the scan and the stat; it is not a folder to us.
    }
  }
  return hit ? "a file" : "nothing";
}

function fileProblem(glob: string): Problem {
  return {
    file: OXLINTRC,
    message: `point the ${DOMAIN} element at a folder: \`${glob}\` names a file, and the layer rule classifies what is under a folder — the lane would mutate nothing and pass`,
  };
}

function noFolderProblem(globs: readonly string[]): Problem {
  return {
    file: OXLINTRC,
    message: `create the folder the ${DOMAIN} element names, or point it at one that exists: nothing here is under ${globs.map((glob) => `\`${glob}\``).join(" or ")}, so the lane would mutate nothing and pass`,
  };
}

/**
 * What the runner logs, at its default level, when the run it was asked to grade
 * did not pass before anything was mutated and no test it could name accounts
 * for that, in the two forms 1.6.0's source writes. The warning, seen in runs
 * of 1.3.8 and 1.4.0, follows a run that went on; the error ends the run with a
 * non-zero exit and no report, and is what a spec file that fails to load
 * produces in 1.6.0. No fixture here makes 1.6.0 write the warning, which it
 * still does for a failure its completeness check lets through. Both are absent
 * from every clean run measured.
 *
 * The capture is the stderr the runner kept, whose 500-character bound is the
 * runner's own and is restated here rather than chosen. The error goes on past
 * it in the runner's own words, so its capture ends where they start.
 */
const DIRTY_BASELINE = [
  /but no failing test could be identified[\s\S]{0,200}?Last 500 chars of stderr:\n([\s\S]{0,500})/,
  /but none of them could be attributed to an individual test[\s\S]{0,200}?Last 500 chars of stderr:\n([\s\S]{0,500}?)(?:; the inspector WebSocket also closed|\. Completing this dry run)/,
];

function dirtyBaseline(wrote: string): string | undefined {
  for (const form of DIRTY_BASELINE) {
    const found = form.exec(wrote);
    if (found !== null) return found[1] ?? "";
  }
  return undefined;
}

/**
 * The cause is offered rather than stated: what the lane established is that the
 * suite failed unmutated, and the exit that fixes it most often is not something
 * the report can confirm.
 */
function baselineProblem(kept: string, tests: Tests): Problem {
  return {
    message: `make the suite this lane runs pass before reading anything into the mutants: the unmutated run already failed, and the runner could not attribute that failure to any test it ran — so no status in the report means what it says, a kill least of all. What the runner kept of that run's stderr: ${span(kept)}. ${testsCause(tests)}`,
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

const CASE_TIMEOUT_INPUT = "mutation-case-timeout";

/**
 * How long one test case may run in the lane before bun fails it, in
 * milliseconds, when the repo names no other. Stryker's deadline for a mutant
 * is built from it (`strykerConfig`), so it decides what a timeout means here:
 * a mutant that hangs. Measured on A1M4N3/wmstcs (dev-config#203): with bun's
 * own five seconds, a property test that takes 1.4 s alone crossed it beside
 * the lane's parallel runs and the repo's suite, which failed the unmutated
 * run on a busy runner and "killed" mutants a hand run shows surviving.
 */
const DEFAULT_CASE_TIMEOUT_MS = 60_000;

/**
 * How long the whole lane may run, in milliseconds: the named tests' unmutated
 * run and Stryker's both end at this deadline, counted from the lane's start.
 * Inside the ten minutes `check.yml` gives the step, so the lane rather than
 * GitHub ends a run that would not finish, and says how far it got. A run
 * reaches it with mutants that hang, each holding a worker for one case limit,
 * or with more mutants than the time holds when none of them is stuck.
 */
export const RUN_DEADLINE_MS = 9 * 60_000;

/**
 * The longest case limit the lane takes, in milliseconds: the run's deadline,
 * since a case allowed longer than the whole run is allowed nothing more. The
 * cap is also what keeps Stryker's deadline for a mutant, built from the limit,
 * inside the 2147483647 ms Node's timers take: past it a timer fires after
 * 1 ms, and every covered mutant came back caught by timing out.
 *
 * @alias the same value as `RUN_DEADLINE_MS` on purpose, under the name of what it bounds
 */
export const LONGEST_CASE_LIMIT_MS = RUN_DEADLINE_MS;

/**
 * The case limit in milliseconds: the default where the input is empty, and
 * refused where it is not decimal digits from 1 to `LONGEST_CASE_LIMIT_MS`.
 */
function caseLimitFrom(value: string): number {
  if (value === "") return DEFAULT_CASE_TIMEOUT_MS;
  const limit = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(limit >= 1 && limit <= LONGEST_CASE_LIMIT_MS)) {
    throw new Error(
      `${CASE_TIMEOUT_INPUT} is '${value}' — write it as a whole number of milliseconds from 1 to ${LONGEST_CASE_LIMIT_MS}, the lane's whole run, in decimal digits`,
    );
  }
  return limit;
}

/** The deadline as a refusal says it. */
function minutes(ms: number): string {
  return ms % 60_000 === 0 ? plural(ms / 60_000, "minute") : `${ms} ms`;
}

/**
 * A path as a pattern matching only itself. Stryker resolves every `mutate`
 * entry as a glob, so a file whose NAME holds a glob character — `[id].ts` is
 * the one every router in this house produces — resolves to nothing, and a file
 * that resolves to nothing has no mutants, which reads as a clean pass.
 *
 * A one-character class is the escape its resolver honours; a backslash is not
 * (probed against 9.6.1: `[[]id[]].ts` resolves, `\[id\].ts` does not). Three
 * characters have no working form at all — `{`, `}` and `!`, where a class is
 * either ignored or read as negation — so escaping is half the answer and the
 * unresolved-pattern check below is the other half: whatever the escape cannot
 * express is refused by name rather than passed over.
 */
function literal(path: string): string {
  return path.replace(/[*?[\]()+@|]/g, (mark) => `[${mark}]`);
}

/** What Stryker says, once per `mutate` entry it could not resolve to a file. */
const UNRESOLVED = /Glob pattern "([^"]*)" did not result in any files\./g;

/**
 * How Stryker is asked to mutate exactly these files with the house runner, and
 * with exactly the named tests when a repo names them. With none named the
 * config carries no `bun` block, and the runner walks the project.
 */
function strykerConfig(
  mutate: readonly string[],
  report: string,
  sandbox: string,
  tests: Tests,
  caseLimit: number,
  runDeadline: number,
): string {
  return JSON.stringify({
    testRunner: "bun",
    coverageAnalysis: "perTest",
    plugins: [RUNNER],
    mutate,
    // The progress line every ten seconds is what says how far a run got when
    // the lane's deadline ended it.
    reporters: ["json", "progress-append-only"],
    jsonReporter: { fileName: report },
    // Three clocks can end a mutant's run, and each is set so that one ends
    // it only when the mutant hangs, however busy the runner. Stryker's
    // deadline for a mutant is timeoutFactor times what its covering tests
    // took unmutated, plus timeoutMS, plus the run's overhead: with the default
    // five seconds, a mutant that runs at module load (`static`), and so
    // reloads every test file, timed out at 7.4 s beside the lane's other runs
    // and passed as caught (dev-config#203). One case's limit on top of what
    // the tests took is the slack a run may need before it is a hang.
    timeoutMS: caseLimit,
    // The runner's own clock on a `bun test` child (ten seconds by default)
    // and Stryker's limit on the dry run (five minutes) are set to the lane's
    // whole run, which ends every child first: neither can then grade a mutant
    // in place of Stryker's deadline, however long the covering tests take.
    dryRunTimeoutMinutes: runDeadline / 60_000,
    bun: {
      timeout: runDeadline,
      // bun's own limit on one case, five seconds unless the repo's bunfig
      // says otherwise; the flag outranks bunfig. A case that fails on it fails
      // as a test does, which Stryker reads as a kill.
      bunArgs: [`--timeout=${caseLimit}`],
      ...testFilesConfig(tests),
    },
    // A checkout on a developer's machine has a `.env` holding real
    // credentials, which Stryker's walk would otherwise copy into the sandbox
    // under the temp dir, where every `bun test` the run makes loads it
    // (dev-config#202).
    ignorePatterns: [".env*"],
    // The lane owns the floor, so Stryker owns none: a break threshold would
    // exit non-zero on a low score, and a non-zero exit is read here as a run
    // that did not finish. Written down rather than left to a default, because
    // that reading is only safe while the two cannot be confused.
    thresholds: { break: null },
    // Stryker copies the project into a sandbox to mutate it. The default puts
    // that copy in the checkout as `.stryker-tmp`, and cleans it only after a
    // run that finished — so every crash left a tree of the repo's own source
    // behind for the steps after this one to lint, scan and count. Outside the
    // checkout and always cleaned, the lane leaves nothing whatever happens.
    tempDirName: sandbox,
    cleanTempDir: "always",
    // Names no tsconfig, so Stryker's sandbox copy of the project keeps the
    // repo's own. The rewrite it would otherwise do — repointing `extends` and
    // `references` that fall outside the copy — is both unavailable and
    // unwanted: it goes through `ts.parseConfigFileTextToJson`, which the
    // native TypeScript 7 port does not export, so it throws before a mutant is
    // tested; and the runner here is `bun test`, which resolves the copied
    // tsconfig itself against a sandbox that mirrors the project. `""`
    // resolves to the working directory, which is a directory and so never a
    // file in the project — the only value the option's schema accepts that
    // reaches nothing.
    tsconfigFile: "",
  });
}

export interface Input {
  readonly root: string;
  readonly event: Event;
  /** The score the changed files must hold, as a fraction. Empty publishes the score and fails on nothing. */
  readonly floor: string;
  /**
   * The test files that grade the domain, as glob patterns one per line. Empty
   * leaves the runner's own walk of the project as the selection.
   */
  readonly tests: string;
  /** How long one test case may run, in milliseconds. Empty is the lane's default. */
  readonly caseTimeout: string;
  /** How long the whole lane may run, in milliseconds: `RUN_DEADLINE_MS`, or less in a suite. */
  readonly runDeadline: number;
}

/**
 * Mutates what this branch changed inside the repo's pure domain, publishes the
 * score, and fails on a mutant the branch's own lines left undetected — or on a
 * run nothing read off can mean anything: one whose suite was already failing
 * before a mutant was applied, and one that graded only part of what it mutated.
 *
 * Selective because the alternative is not affordable: a full campaign over a
 * domain layer is minutes to hours, and a gate that costs that runs nightly or
 * not at all. What a pull request can be held to is the code in it.
 *
 * A filename crosses three name-spaces on its way through here — git's diff
 * output, the filesystem under `root`, Stryker's glob resolver — and the one
 * failure this gate cannot afford is a file that goes missing between two of
 * them, because a file nobody mutated has no mutants and reads as a pass. So
 * both crossings are checked rather than assumed: `branchChange` refuses a name it
 * could not read out of the diff, and every `mutate` entry Stryker could not
 * resolve is refused by name below.
 */
export async function mutationLane({
  root,
  event,
  floor,
  tests,
  caseTimeout,
  runDeadline,
}: Input): Promise<Verdict> {
  const deadline = Date.now() + runDeadline;
  const bound = floorFrom(floor);
  const caseLimit = caseLimitFrom(caseTimeout);

  const bunfig = await bunfigTest(root);
  if ("problems" in bunfig) {
    return { note: `${BUNFIG} cannot be read`, problems: [...bunfig.problems] };
  }

  // Before the domain and the change, so a pattern that names nothing is
  // refused on every run rather than only on one that changed a domain file.
  const chosen = testsFrom(root, tests, bunfig.value);
  if ("problems" in chosen) {
    return {
      note: `${TESTS_INPUT} does not name the tests it was meant to`,
      problems: [...chosen.problems],
    };
  }
  const run = chosen.value;

  const retries = retried(bunfig.value);
  if (retries.length > 0) {
    return { note: "the repo's bunfig retries failing tests", problems: [...retries] };
  }

  const domain = await domainGlobs(root);
  if (!("value" in domain)) {
    return { note: "the pure domain is not declared", problems: [...domain.problems] };
  }

  // `:(glob)` gives git the pattern semantics the layer rule means, where a
  // single wildcard stops at a slash and a double one does not — a bare
  // pathspec crosses slashes on either, so a workspace's element would classify
  // a project nested deeper than any workspace declares.
  const testCode = testCodeNames(await shippedLintBase());
  if ("problems" in testCode) {
    return { note: "the lint base's test code cannot be read", problems: [...testCode.problems] };
  }

  // A named test file is part of the change too: a branch that breaks one and
  // touches no domain file would otherwise pass here, and the next branch that
  // changes a domain file would meet the red baseline instead (dev-config#201).
  const named = namedFiles(run);
  const mutable = mutableBeside(testCode.value);
  const change = await branchChange(root, event, {
    why: READS_THE_BASE_REF,
    pathspecs: [
      ...domain.value.map((glob) => `:(glob)${glob}/**`),
      ...[...named].map((file) => `:(literal)${file}`),
    ],
    keeps: (path) => named.has(path) || mutable(path),
    noun: changedNoun(run),
    nothing: `nothing to mutate${testsNoted(run)}`,
  });
  if (change.kind === "settled") return change.verdict;
  const changed = new Map([...change.changed].filter(([file]) => !named.has(file)));

  const scratch = await mkdtemp(join(tmpdir(), "mutation-lane-"));
  try {
    const budget = minutes(runDeadline);
    const unmutated = await unmutatedRun(root, run, {
      caseLimit,
      scratch,
      deadline,
      budget,
      mutates: changed.size > 0,
    });
    if (unmutated !== undefined) return unmutated;

    const stryker = join(root, "node_modules", ".bin", "stryker");
    if (!(await Bun.file(stryker).exists())) {
      return {
        note: "the mutation runner is not installed",
        problems: [
          {
            file: "package.json",
            message: `add ${DECLARE} to devDependencies — the lane runs the repo's own install, so those are the versions it runs`,
          },
        ],
      };
    }

    const config = join(scratch, "stryker.conf.json");
    const report = join(scratch, "mutation.json");
    const requested = new Map([...changed.keys()].map((file) => [literal(file), file]));
    await Bun.write(
      config,
      strykerConfig(
        [...requested.keys()],
        report,
        join(scratch, "sandbox"),
        run,
        caseLimit,
        runDeadline,
      ),
    );

    // The runner writes a bunfig and a preload per worker under the temp dir
    // and leaves them when its worker is killed; under the scratch directory
    // the `finally` below removes them whatever ended the run. It refuses a
    // temp dir that anyone but its owner can write to, which a umask of 002
    // would otherwise make this one.
    const temp = join(scratch, "tmp");
    await mkdir(temp, { mode: 0o700 });
    const stryked = await ran([stryker, "run", config], root, deadline, { TMPDIR: temp });
    const wrote = `${stryked.out}\n${stryked.err}`;

    if (stryked.ended) {
      return {
        note: "the mutation run did not finish before the lane's deadline",
        log: wrote,
        problems: [endedProblem(wrote, budget, caseLimit)],
      };
    }

    // Read on every exit, not only a failing one: Stryker resolves what it can
    // and finishes cleanly over the rest, so an unresolved pattern is a green
    // run with a file missing from it — the whole of the class this check
    // exists for.
    const missing = unresolvedIn(wrote, requested);
    if (missing.length > 0)
      return {
        note: "a changed file never reached the run",
        log: wrote,
        problems: missing,
      };

    // Read where the unresolved patterns are, and for the same reason: the run
    // this refuses exits 0 and writes a report, and every number in that report
    // is a statement about a suite that was already failing.
    const kept = dirtyBaseline(wrote);
    if (kept !== undefined) {
      return {
        note: "the suite this run mutated does not pass unmutated",
        log: wrote,
        problems: [baselineProblem(kept, run)],
      };
    }

    if (stryked.status !== 0) {
      return {
        note: UNFINISHED,
        log: wrote,
        problems: [
          {
            message: `fix what the run reported above: it exited ${stryked.status} without a report, so nothing was graded`,
          },
          ...(await machineProblems(root, [CORE, RUNNER], onPath("node"), temp)),
        ],
      };
    }

    return verdict(await Bun.file(report).text(), changed, bound, run, wrote);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What the lane says of a Stryker run that exited without a report, whose cause is only in its log. */
export const UNFINISHED = "the mutation run did not finish";

/** The counts in the last of the lines Stryker's progress reporter writes every ten seconds. */
const PROGRESS = /(\d+)\/(\d+) tested \((\d+) survived, (\d+) timed out\)/g;

/**
 * A run the lane's deadline ended, and how far it got by Stryker's own count.
 * Where mutants had timed out, they are what held it, each costing one case
 * limit of one worker; where none had, the run was simply long.
 */
export function endedProblem(wrote: string, budget: string, caseLimit: number): Problem {
  const last = [...wrote.matchAll(PROGRESS)].at(-1);
  const ended = `the lane ended the mutation run at its deadline of ${budget}`;
  const hang = `lower \`${CASE_TIMEOUT_INPUT}\` toward what the slowest named case needs, or end the loops that hang under a mutant`;
  const long = "change fewer domain files in one branch, or make the named tests faster";
  const holds = `every mutant that hangs holds a worker for one case limit, ${caseLimit} ms, before Stryker's deadline ends it`;
  if (last === undefined) {
    return {
      message: `${hang}; or, if none hung, ${long}: ${ended} before Stryker reported any progress, so whether mutants hung cannot be told, and ${holds}.`,
    };
  }
  const counts = `Stryker's last count: ${span(last[0])}.`;
  return {
    message:
      Number(last[4]) > 0
        ? `${hang}: ${ended}, and ${holds}. ${counts}`
        : `${long}: ${ended}, and no mutant had timed out, so the run was long rather than stuck. ${counts}`,
  };
}

/** Every file Stryker was pointed at and could not find, named as the repo wrote it. */
function unresolvedIn(wrote: string, requested: ReadonlyMap<string, string>): Problem[] {
  const patterns = new Set([...wrote.matchAll(UNRESOLVED)].map((match) => match[1] ?? ""));
  return [...patterns].flatMap((pattern) => {
    const file = requested.get(pattern);
    return file === undefined
      ? []
      : [
          {
            file,
            message: `rename ${file} so its name carries no glob character: the run resolved it as \`${pattern}\` and found no file, and an unmutated file reads as one with nothing wrong`,
          },
        ];
  });
}
