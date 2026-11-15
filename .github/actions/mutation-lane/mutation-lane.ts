import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { branchChange } from "../_lib/change-set.ts";
import {
  type ConfigObject,
  type Event,
  isList,
  isObject,
  plainly,
  plural,
  type Problem,
  readConfig,
  type Verdict,
} from "../_lib/gate.ts";
import { span, verdict } from "./report.ts";

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
 * The pair as the diagnostic asks for it, versions included: a bare `bun add`
 * resolves `@stryker-mutator/core@10`, which is outside the `^9.0.0` peer range
 * the runner declares — an unsupported pair to send a repo to, whatever it
 * happens to do on the day. These are the versions this repo's own
 * devDependencies pin, which is the install every case in
 * `tests/mutation-lane.test.ts` runs the lane against — the test reads them
 * back out of that manifest, so a bump that leaves this line behind fails there
 * rather than in a consuming repo.
 */
const DECLARE = `${CORE}@9.6.1 and ${RUNNER}@1.3.8`;

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
 * What a read gave, or what to tell the repo instead — the two kept apart the
 * way `Base` in `_lib/gate.ts` keeps them, because "here it is" and "there is
 * none to give you" are not one value with a hole in it.
 */
type Answer<T> = { readonly value: T } | { readonly problems: readonly Problem[] };

/** A setting written as one string or a list of them, as both configs read here allow. */
function strings(value: unknown): string[] {
  return (isList(value) ? value : [value]).filter(
    (each): each is string => typeof each === "string",
  );
}

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
 * did not pass before anything was mutated: bun exited non-zero, and no test it
 * could name accounts for that. Verified present in both 1.3.8 and 1.4.0, and
 * absent from every clean run measured.
 *
 * The capture is the stderr the runner kept, whose 500-character bound is the
 * runner's own and is restated here rather than chosen.
 */
const DIRTY_BASELINE =
  /but no failing test could be identified[\s\S]{0,200}?Last 500 chars of stderr:\n([\s\S]{0,500})/;

function dirtyBaseline(wrote: string): string | undefined {
  const found = DIRTY_BASELINE.exec(wrote);
  return found === null ? undefined : (found[1] ?? "");
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
 * milliseconds, when the repo names no other. Every deadline the run keeps is
 * derived from it (`strykerConfig`), so it decides what a timeout means here:
 * a mutant that hangs. Measured on A1M4N3/wmstcs (dev-config#203): with bun's
 * own five seconds, a property test that takes 1.4 s alone crossed it beside
 * the lane's parallel runs and the repo's suite, which failed the unmutated
 * run on a busy runner and "killed" mutants a hand run shows surviving.
 */
const DEFAULT_CASE_TIMEOUT_MS = 60_000;

/** The case limit in milliseconds: the default where the input is empty, refused where it is not a whole positive number. */
function caseLimitFrom(value: string): number {
  if (value.trim() === "") return DEFAULT_CASE_TIMEOUT_MS;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      `${CASE_TIMEOUT_INPUT} is '${value}' — write it as a whole number of milliseconds, the way bun test's --timeout takes it`,
    );
  }
  return limit;
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

const TESTS_INPUT = "mutation-tests";
const BUNFIG = "bunfig.toml";

/**
 * Which tests the run loads: every test file the runner finds by walking the
 * project, or exactly the files a repo names in `mutation-tests`. The one value
 * the config, the dirty-baseline cause and the note each read.
 */
type Tests =
  | { readonly kind: "walked" }
  | { readonly kind: "named"; readonly files: readonly string[] };

/** Which files the runner is told to load: none for a walk, so its own walk runs; the named files otherwise. */
function testFilesConfig(tests: Tests): { readonly testFiles?: readonly string[] } {
  return tests.kind === "walked" ? {} : { testFiles: tests.files };
}

/** The usual cause of a run that failed unmutated, which depends on how its tests were chosen. */
function testsCause(tests: Tests): string {
  return tests.kind === "walked"
    ? `The run loads the test and spec files it finds by walking the project rather than the ones the repo's own script selects, so the usual cause is a suite in the tree that was never meant for a plain \`bun test\`: name the files that grade the domain in \`${TESTS_INPUT}\`, or keep that suite out with \`[test] pathIgnorePatterns\` in \`bunfig.toml\`.`
    : `The run loads exactly the ${plural(tests.files.length, "test file")} \`${TESTS_INPUT}\` names, as one plain \`bun test\` without the repo's own script, so the usual cause is a named file that passes only under that script: take it out of the patterns, or make it pass on its own.`;
}

/** What a note says of the tests, wherever the run got far enough to say anything about them. */
function testsNoted(tests: Tests): string {
  return tests.kind === "walked"
    ? ""
    : `; ${TESTS_INPUT} names ${plural(tests.files.length, "test file")}`;
}

/**
 * The tests a repo names, each as the relative path beginning `./` the runner
 * hands `bun test`. Bun reads a bare relative path as a substring filter, so
 * `lib/a.test.ts` also runs `other/lib/a.test.ts`; the `./` is what makes it
 * one file. An absolute path would point the runner at the original files
 * rather than the sandbox copy it mutates. Every path is normalised before
 * anything is asked of it, because a pattern written `./lib/*.test.ts` scans
 * to `./lib/a.test.ts`, which no ignore pattern matches and which bun, handed
 * `././lib/a.test.ts`, skips.
 *
 * Every refusal here is one that would otherwise leave a named test out of the
 * run with nothing said: a pattern that names nothing, one that reaches outside
 * the project the sandbox copies, a blank line between patterns, and a file
 * `bun test` itself skips because `bunfig.toml` ignores its path.
 */
async function testsFrom(root: string, value: string): Promise<Answer<Tests>> {
  // The whole value is trimmed first, so the newline a YAML block scalar ends
  // with is not read as a blank line of the repo's.
  const written = value.trim();
  if (written === "") return { value: { kind: "walked" } };

  const problems: Problem[] = [];
  const files = new Set<string>();
  for (const [index, line] of written.split("\n").entries()) {
    const pattern = line.trim();
    if (pattern === "") {
      problems.push({
        message: `delete the blank line ${index + 1} of ${TESTS_INPUT}, or write the pattern it was for: every line there is a pattern, one test file or more`,
      });
      continue;
    }
    if (isAbsolute(pattern) || pattern.split("/").includes("..")) {
      problems.push({
        message: `write ${TESTS_INPUT}'s \`${pattern}\` relative to the working directory and inside it: the run copies only that directory, so a test outside it never runs`,
      });
      continue;
    }
    // `node_modules` is the one directory a `**` pattern would otherwise walk
    // into, and nothing under it is the repo's own test.
    const found = [...new Bun.Glob(pattern).scanSync({ cwd: root })]
      .map((file) => posix.normalize(file))
      .filter((file) => !file.split("/").includes("node_modules"));
    if (found.length === 0) {
      problems.push({
        message: `fix ${TESTS_INPUT}'s \`${pattern}\` so it names a test file: it matches none, and a pattern that names nothing grades the domain with fewer tests than the repo meant`,
      });
    }
    for (const file of found) files.add(file);
  }

  const ignored = await ignoredByBunfig(root);
  if ("problems" in ignored) return ignored;
  for (const file of files) {
    const by = ignored.value.find((each) => new Bun.Glob(each).match(file));
    if (by !== undefined) {
      problems.push({
        file: BUNFIG,
        message: `take ${file} out of ${TESTS_INPUT}, or \`${by}\` out of [test] pathIgnorePatterns: bun skips a file that pattern matches even when it is named, so the test would never run`,
      });
    }
  }

  if (problems.length > 0) return { problems };
  return { value: { kind: "named", files: [...files].toSorted().map((file) => `./${file}`) } };
}

/**
 * `bunfig.toml`'s `[test] pathIgnorePatterns`, which bun applies to a file named
 * on its command line as much as to one it found. No bunfig, or one without the
 * key, ignores nothing.
 */
async function ignoredByBunfig(root: string): Promise<Answer<readonly string[]>> {
  if (!(await Bun.file(join(root, BUNFIG)).exists())) return { value: [] };
  const bunfig = await readConfig(root, BUNFIG, "TOML");
  if (bunfig.contents === undefined) return { problems: bunfig.problems };
  const test = bunfig.contents["test"];
  return { value: isObject(test) ? strings(test["pathIgnorePatterns"]) : [] };
}

/** Stryker's own default limit on the unmutated run, written down because the runner's clock is set from it. */
const DRY_RUN_MINUTES = 5;

/** The named test files as paths from the working directory, the way a diff names them; none for a walk. */
function namedFiles(tests: Tests): ReadonlySet<string> {
  return new Set(tests.kind === "walked" ? [] : tests.files.map((file) => file.slice(2)));
}

/** The five entities XML escapes an attribute with, which is all a path in bun's report can carry. */
function unescaped(attribute: string): string {
  return attribute
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * The named files that failed, read off bun's JUnit report: a file whose cases
 * failed is a `testsuite` counting failures, and a file that threw before its
 * cases ran has no `testsuite` at all, so a named file missing from the report
 * is one that failed to load.
 */
function failedFiles(junit: string, files: readonly string[]): string[] {
  const reported = new Map<string, number>();
  for (const suite of junit.matchAll(/<testsuite\s[^>]*>/g)) {
    const file = /\sfile="([^"]*)"/.exec(suite[0])?.[1];
    const failures = /\sfailures="(\d+)"/.exec(suite[0])?.[1];
    if (file !== undefined && failures !== undefined) {
      reported.set(posix.normalize(unescaped(file)), Number(failures));
    }
  }
  return files.filter((file) => (reported.get(file) ?? 1) > 0);
}

/**
 * The named tests run unmutated, as one plain `bun test` under the lane's case
 * limit, or the verdict refusing the run when they fail. The runner's own dry
 * run says the same of the run it makes, but only as a line of stderr naming no
 * file; this run names the file, and it is made on a branch that changed a named
 * test and no domain file, where Stryker never starts.
 */
async function redBaseline(
  root: string,
  tests: Extract<Tests, { kind: "named" }>,
  caseLimit: number,
): Promise<Verdict | undefined> {
  const scratch = await mkdtemp(join(tmpdir(), "mutation-lane-baseline-"));
  try {
    const junit = join(scratch, "baseline.xml");
    const proc = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        "test",
        `--timeout=${caseLimit}`,
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
        ...tests.files,
      ],
      { cwd: root, env: plainly(process.env), stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) === 0) return undefined;

    const report = Bun.file(junit);
    const failed = failedFiles(
      (await report.exists()) ? await report.text() : "",
      tests.files.map((file) => file.slice(2)),
    );
    const problems: Problem[] =
      failed.length > 0
        ? failed.map((file) => ({
            file,
            message: `make ${file} pass as a plain \`bun test\` of the files \`${TESTS_INPUT}\` names, with every case allowed ${caseLimit} ms, or take it out of the patterns: run unmutated it failed, so no mutant can be graded against it`,
          }))
        : [
            {
              message: `make the named tests pass as a plain \`bun test\` with every case allowed ${caseLimit} ms: run unmutated it exited non-zero with no named file failing, so no mutant can be graded against it. The end of what it wrote: ${span(err.slice(-500))}`,
            },
          ];
    return {
      note: "the named tests do not pass unmutated",
      log: `${out}\n${err}`,
      problems,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
): string {
  return JSON.stringify({
    testRunner: "bun",
    coverageAnalysis: "perTest",
    plugins: [RUNNER],
    mutate,
    reporters: ["json"],
    jsonReporter: { fileName: report },
    // Three clocks can end a test run, and each is set so that a run ends on
    // one only when a mutant hangs, whatever else the runner is doing.
    // Stryker's own deadline for a mutant is timeoutFactor times the time its
    // covering tests took unmutated, plus timeoutMS, plus the run's overhead:
    // with the default five seconds, a mutant that runs at module load
    // (`static`) and so reloads every test file timed out at 7.4 s beside the
    // lane's other runs and passed as caught (dev-config#203). One case's limit on top of
    // what the tests took is the slack a run may need before it is a hang.
    timeoutMS: caseLimit,
    // The runner's own clock on each `bun test` child, ten seconds by default,
    // grades a mutant the runner's way rather than Stryker's. Set to the dry
    // run's limit, which Stryker's deadline for any one mutant stays far
    // inside, so that Stryker's is the clock that grades.
    dryRunTimeoutMinutes: DRY_RUN_MINUTES,
    bun: {
      timeout: DRY_RUN_MINUTES * 60_000,
      // bun's own limit on one case, five seconds unless the repo's bunfig
      // says otherwise; the flag outranks bunfig. A case that fails on it fails
      // as a test does, which Stryker reads as a kill.
      bunArgs: [`--timeout=${caseLimit}`],
      ...testFilesConfig(tests),
    },
    // A checkout on a developer's machine has a `.env` holding real
    // credentials, which Stryker's walk would otherwise copy into the sandbox
    // under the temp dir, where every `bun test` the run makes loads it
    // (dev-config#202). The named tests' own run starts bun with --no-env-file
    // for the same reason.
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
}: Input): Promise<Verdict> {
  const bound = floorFrom(floor);
  const caseLimit = caseLimitFrom(caseTimeout);

  // Before the domain and the change, so a pattern that names nothing is
  // refused on every run rather than only on one that changed a domain file.
  const chosen = await testsFrom(root, tests);
  if ("problems" in chosen) {
    return {
      note: `${TESTS_INPUT} does not name the tests it was meant to`,
      problems: [...chosen.problems],
    };
  }
  const run = chosen.value;

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
    noun: run.kind === "named" ? "domain file or named test file" : "domain file",
    nothing: `nothing to mutate${testsNoted(run)}`,
  });
  if (change.kind === "settled") return change.verdict;
  const changed = new Map([...change.changed].filter(([file]) => !named.has(file)));

  if (run.kind === "named") {
    const red = await redBaseline(root, run, caseLimit);
    if (red !== undefined) return red;
    if (changed.size === 0) {
      return {
        note: `no domain file changed — the named tests pass unmutated, and there is nothing to mutate${testsNoted(run)}`,
        problems: [],
      };
    }
  }

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

  const scratch = await mkdtemp(join(tmpdir(), "mutation-lane-"));
  try {
    const config = join(scratch, "stryker.conf.json");
    const report = join(scratch, "mutation.json");
    const requested = new Map([...changed.keys()].map((file) => [literal(file), file]));
    await Bun.write(
      config,
      strykerConfig([...requested.keys()], report, join(scratch, "sandbox"), run, caseLimit),
    );

    const proc = Bun.spawn([stryker, "run", config], {
      cwd: root,
      env: plainly(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const status = await proc.exited;
    const wrote = `${out}\n${err}`;

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

    if (status !== 0) {
      return {
        note: "the mutation run did not finish",
        log: wrote,
        problems: [
          {
            message: `fix what the run reported above: it exited ${status} without a report, so nothing was graded`,
          },
        ],
      };
    }

    return verdict(await Bun.file(report).text(), changed, bound, testsNoted(run), wrote);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
