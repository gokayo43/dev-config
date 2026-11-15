/**
 * Which tests a run loads, and whether the named ones pass before anything is
 * mutated: every test file the runner finds by walking the project, or exactly
 * the files a repo names in `mutation-tests`, run once unmutated by the lane
 * itself. A subject of its own, beside the report and the run that the
 * orchestrator puts together.
 */
import { join, isAbsolute, posix } from "node:path";

import {
  type ConfigObject,
  isObject,
  plural,
  type Problem,
  readConfig,
  type Verdict,
} from "../_lib/gate.ts";
import { ran } from "./child.ts";
import { type Answer, span, strings } from "./values.ts";

export const TESTS_INPUT = "mutation-tests";
export const BUNFIG = "bunfig.toml";

/**
 * Which tests the run loads: every test file the runner finds by walking the
 * project, or exactly the files a repo names in `mutation-tests`, each as its
 * path from the working directory.
 */
export type Tests =
  | { readonly kind: "walked" }
  | { readonly kind: "named"; readonly files: readonly string[] };

/**
 * A named file as `bun test` is handed it. Bun reads a bare relative path as a
 * substring filter, so `lib/a.test.ts` also runs `other/lib/a.test.ts`; the
 * `./` is what makes it one file. An absolute path would point the runner at
 * the original files rather than the sandbox copy it mutates.
 */
function forBun(file: string): string {
  return `./${file}`;
}

/** Which files the runner is told to load: none for a walk, so its own walk runs; the named files otherwise. */
export function testFilesConfig(tests: Tests): { readonly testFiles?: readonly string[] } {
  return tests.kind === "walked" ? {} : { testFiles: tests.files.map(forBun) };
}

/** The named test files as paths from the working directory, the way a diff names them; none for a walk. */
export function namedFiles(tests: Tests): ReadonlySet<string> {
  return new Set(tests.kind === "walked" ? [] : tests.files);
}

/** What the lane calls a file whose change makes it run. */
export function changedNoun(tests: Tests): string {
  return tests.kind === "walked" ? "domain file" : "domain file or named test file";
}

/**
 * The usual cause of a run that failed unmutated in the runner, which depends
 * on how its tests were chosen. Named tests have already passed the lane's own
 * unmutated run in the checkout, so what remains is what differs in Stryker's
 * copy of the project.
 */
export function testsCause(tests: Tests): string {
  return tests.kind === "walked"
    ? `The run loads the test and spec files it finds by walking the project rather than the ones the repo's own script selects, so the usual cause is a suite in the tree that was never meant for a plain \`bun test\`: name the files that grade the domain in \`${TESTS_INPUT}\`, or keep that suite out with \`[test] pathIgnorePatterns\` in \`bunfig.toml\`.`
    : `The ${plural(tests.files.length, "test file")} \`${TESTS_INPUT}\` names passed when the lane ran them unmutated in the checkout, so what failed is what differs in Stryker's copy: the sandbox holds no \`.env*\` file and nothing outside the working directory, and the runner forwards only some of \`bunfig.toml\`'s \`[test]\` keys (\`preload\`, \`root\`, \`pathIgnorePatterns\`, \`timeout\`, \`smol\`, \`rerunEach\`, \`randomize\`, \`seed\`): make the named files pass there too.`;
}

/** What a note says of the tests, wherever the run got far enough to say anything about them. */
export function testsNoted(tests: Tests): string {
  return tests.kind === "walked"
    ? ""
    : `; ${TESTS_INPUT} names ${plural(tests.files.length, "test file")}`;
}

/**
 * The tests a repo names, each as its normalised path from the working
 * directory. Normalised before anything is asked of it, because a pattern
 * written `./lib/*.test.ts` scans to `./lib/a.test.ts`, which no ignore pattern
 * matches and which bun, handed `././lib/a.test.ts`, skips.
 *
 * Every refusal here is one that would otherwise leave a named test out of the
 * run with nothing said: a pattern that names nothing, one that reaches outside
 * the project the sandbox copies, a blank line between patterns, and a file
 * `bun test` itself skips because `bunfig.toml` ignores its path.
 */
export function testsFrom(root: string, value: string, bunfig: ConfigObject): Answer<Tests> {
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

  // bun applies `[test] pathIgnorePatterns` to a file named on its command
  // line as much as to one it found.
  const ignored = strings(bunfig["pathIgnorePatterns"]);
  for (const file of files) {
    const by = ignored.find((each) => new Bun.Glob(each).match(file));
    if (by !== undefined) {
      problems.push({
        file: BUNFIG,
        message: `take ${file} out of ${TESTS_INPUT}, or \`${by}\` out of [test] pathIgnorePatterns: bun skips a file that pattern matches even when it is named, so the test would never run`,
      });
    }
  }

  if (problems.length > 0) return { problems };
  return { value: { kind: "named", files: [...files].toSorted() } };
}

/**
 * `bunfig.toml`'s `[test]` table, read once for every rule the lane takes from
 * it: empty where there is no bunfig or no table.
 */
export async function bunfigTest(root: string): Promise<Answer<ConfigObject>> {
  if (!(await Bun.file(join(root, BUNFIG)).exists())) return { value: {} };
  const bunfig = await readConfig(root, BUNFIG, "TOML");
  if (bunfig.contents === undefined) return { problems: bunfig.problems };
  const test = bunfig.contents["test"];
  return { value: isObject(test) ? test : {} };
}

/**
 * The refusal of a `bunfig.toml` that retries a failing test, which the lane
 * cannot switch off: the runner forwards `[test] retry` to every mutant's run,
 * the named tests' unmutated run reads it from the checkout, and bun's
 * `--retry=0` does not outrank it (probed on bun 1.4.4: a case that passes only
 * on its second try passed under `retry = 3` with `--retry=0` given). A retried
 * test is a mutant graded on whichever attempt passed, and the lane never
 * retries a test for an answer.
 */
export function retried(bunfig: ConfigObject): readonly Problem[] {
  const retry = bunfig["retry"];
  return typeof retry === "number" && retry > 0
    ? [
        {
          file: BUNFIG,
          message: `take \`retry = ${retry}\` out of [test] in ${BUNFIG}, or run the retried suite outside the lane: bun retries a failing test that many times and passes it on any attempt, so a mutant would be graded on whichever run passed, and neither the runner nor bun's --retry=0 switches it off`,
        },
      ]
    : [];
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
 * The named files that failed, read off bun's JUnit report. A file is a
 * `testsuite` counting its failures, and every `describe` in it is a suite of
 * its own nested inside, carrying the same `file` and only its own count, so a
 * file is the first suite the report gives for it. A file that threw before its
 * cases ran has no suite at all, so a named file missing from the report is one
 * that failed to load.
 */
function failedFiles(junit: string, files: readonly string[]): string[] {
  const reported = new Map<string, number>();
  for (const suite of junit.matchAll(/<testsuite\s[^>]*>/g)) {
    const file = /\sfile="([^"]*)"/.exec(suite[0])?.[1];
    const failures = /\sfailures="(\d+)"/.exec(suite[0])?.[1];
    if (file === undefined || failures === undefined) continue;
    const path = posix.normalize(unescaped(file));
    if (!reported.has(path)) reported.set(path, Number(failures));
  }
  return files.filter((file) => {
    const failures = reported.get(file);
    return failures === undefined || failures > 0;
  });
}

/** The end of what a run wrote, as a diagnostic quotes it. */
function tail(wrote: string): string {
  return span(wrote.slice(-500));
}

interface Unmutated {
  readonly caseLimit: number;
  /** Where the run writes its report: the lane's scratch directory. */
  readonly scratch: string;
  /** The run's deadline, an epoch in milliseconds. */
  readonly deadline: number;
  /** How long the whole run has, as its refusal says it. */
  readonly budget: string;
  /** Whether the branch changed a domain file, so that Stryker runs after this. */
  readonly mutates: boolean;
}

/**
 * The named tests run unmutated, as one plain `bun test` under the lane's case
 * limit and with no `.env` file read, or the verdict that settles the run
 * instead: a refusal when they fail or do not finish, and the pass that says so
 * when they pass and the branch changed no domain file. The runner's own dry
 * run says the same of the run it makes, but only as a line of stderr naming no
 * file; this run names the file, and it is made on a branch that changed a named
 * test and no domain file, where Stryker never starts. A walk runs nothing here.
 */
export async function unmutatedRun(
  root: string,
  tests: Tests,
  { caseLimit, scratch, deadline, budget, mutates }: Unmutated,
): Promise<Verdict | undefined> {
  if (tests.kind === "walked") return undefined;

  const junit = join(scratch, "unmutated.xml");
  const run = await ran(
    [
      "bun",
      // A checkout on a developer's machine has a `.env` holding real
      // credentials, and bun loads it into every test it runs from there
      // (dev-config#202).
      "--no-env-file",
      "test",
      `--timeout=${caseLimit}`,
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
      ...tests.files.map(forBun),
    ],
    root,
    deadline,
  );
  const wrote = `${run.out}\n${run.err}`;

  if (run.ended) {
    return {
      note: "the named tests did not finish unmutated",
      log: wrote,
      problems: [
        {
          message: `make the named tests finish as a plain \`bun test\` inside the lane's ${budget}: run unmutated they were still running when the lane ended them, and bun's case limit cannot end a case that never yields, such as a synchronous loop. The end of what it wrote: ${tail(wrote)}`,
        },
      ],
    };
  }

  if (run.status === 0) {
    return mutates
      ? undefined
      : {
          note: `no domain file changed — the named tests pass unmutated, and there is nothing to mutate${testsNoted(tests)}`,
          problems: [],
        };
  }

  // No report at all is bun stopping before it wrote one: a flag it refused, a
  // case that called process.exit, a crash. Nothing in that names a file.
  const report = Bun.file(junit);
  const failed = (await report.exists()) ? failedFiles(await report.text(), tests.files) : [];
  const problems: Problem[] =
    failed.length > 0
      ? failed.map((file) => ({
          file,
          message: `make ${file} pass as a plain \`bun test\` of the files \`${TESTS_INPUT}\` names, with every case allowed ${caseLimit} ms and no \`.env\` file read, or take it out of the patterns: run unmutated it failed, so no mutant can be graded against it`,
        }))
      : [
          {
            message: `make the named tests pass as a plain \`bun test\` with every case allowed ${caseLimit} ms and no \`.env\` file read: run unmutated it exited ${run.status} without a report naming a file that failed, so no mutant can be graded against it. The end of what it wrote: ${tail(run.err)}`,
          },
        ];
  return { note: "the named tests do not pass unmutated", log: wrote, problems };
}
