import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  baseRevision,
  type ConfigObject,
  type Event,
  git,
  isObject,
  kindOf,
  oneOf,
  type Problem,
  readConfig,
} from "../_lib/gate.ts";

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

const READS_THE_BASE_REF =
  "the lane mutates what this branch changed, and the base ref is what changed is measured against";

/** Every status the mutation-testing report schema defines, which is the whole of what a mutant can be. */
const STATUSES = [
  "Killed",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Timeout",
  "Ignored",
  "Pending",
] as const;

type Status = (typeof STATUSES)[number];

type Worth = "detected" | "undetected" | "outside";

/**
 * What every mutant is worth to the score, as a total function of the schema's
 * vocabulary rather than membership tests with everything else falling silently
 * between them: a status left out of this table is a compile error rather than
 * a mutant quietly outside the ratio.
 *
 * `undetected` is the finding — `Survived` means tests ran the line and all
 * passed, `NoCoverage` means none ran it, the same statement one step earlier.
 * `outside` is Stryker's own reading: a mutant that would not compile, that
 * errored, or that the config declined is neither caught nor missed, so it is
 * out of the ratio rather than a zero in it.
 */
const WORTH = {
  Killed: "detected",
  Timeout: "detected",
  Survived: "undetected",
  NoCoverage: "undetected",
  CompileError: "outside",
  RuntimeError: "outside",
  Ignored: "outside",
  Pending: "outside",
} as const satisfies Record<Status, Worth>;

/**
 * The one status whose worth depends on where it sits. `Ignored` is a
 * `Stryker disable` comment in the source, and out of the ratio it takes the
 * mutant from BOTH sides of the fraction — so a branch that writes an untested
 * line and disables it raises the score it should have lowered, and clears the
 * floor it should have breached. On a line the branch wrote, the directive is
 * the branch's own choice and counts as a mutant nothing caught. Elsewhere it
 * is somebody's earlier decision, and outside is the honest reading.
 *
 * That it also has to say WHY is not enforced here: `suppression-hygiene` holds
 * every disable in the tree to carrying its reason, whichever tool reads it.
 */
function worthOf(status: Status, own: boolean): Worth {
  return status === "Ignored" && own ? "undetected" : WORTH[status];
}

/**
 * What a repo declares its pure domain to be — the same element the layer rule
 * already reads, so that "pure domain" has one definition per repo rather than
 * a lint config and a gate input that can disagree. README's "Architecture
 * boundaries" is the shape.
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
  /** What the run wrote, for a failure whose reason is longer than an annotation. */
  readonly log: string | undefined;
  readonly problems: Problem[];
}

function nothing(note: string, problems: Problem[] = []): Lane {
  return { note, table: undefined, log: undefined, problems };
}

/**
 * The domain folders, or what to tell the repo instead — the two kept apart the
 * way `Base` in `_lib/gate.ts` keeps them, because "here are the folders" and
 * "there are none to give you" are not one value with a hole in it.
 */
type Domain = { readonly globs: string[] } | { readonly problems: readonly Problem[] };

/**
 * A `pattern` as eslint-plugin-boundaries reads it: one folder or several. The
 * array form is the linter's own (`isBaseDescriptorPattern` takes a string or
 * an array of them), so a gate that took only the string form would grade half
 * a monorepo and say nothing about the other half.
 */
function patternsIn(element: ConfigObject): string[] {
  const pattern = element["pattern"];
  const listed = Array.isArray(pattern) ? pattern : [pattern];
  return listed.filter((each): each is string => typeof each === "string");
}

/**
 * What `.oxlintrc.json` declares its pure domain to be. A config that is
 * missing or will not parse is `readConfig`'s answer verbatim — the repo contract
 * already grades that file, and this gate has nothing to add to it. The
 * diagnostics of this gate's own are for the file that reads fine: one that
 * names no domain, and one whose pattern names something that is not a folder.
 */
async function domainGlobs(root: string): Promise<Domain> {
  const { contents, problems } = await readConfig(root, OXLINTRC);
  if (contents === undefined) return { problems };

  const settings = contents["settings"];
  const elements = isObject(settings) ? settings["boundaries/elements"] : undefined;
  const globs = (Array.isArray(elements) ? elements : [])
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
  return { globs };
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

/** Where a hunk header says the lines it added start, and how many there are. */
const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

/**
 * The line that opens a file's section, and the one that names it. Read in that
 * order because only the first is safe on its own: every line of diff content
 * carries a `+`, `-` or space in column one, so nothing in a file's body can
 * begin `diff --git ` — while an added line reading `++ b/x` renders exactly as
 * a `+++ b/` header does.
 */
const OPENS = "diff --git ";
const NAMES = "+++ b/";

interface Changed {
  /** Every line this branch wrote, per domain file. */
  readonly changed: Map<string, Set<number>>;
  /** One per section whose file could not be named. */
  readonly problems: Problem[];
}

/**
 * Every line this branch wrote, per domain file — one diff, which is the whole
 * of what "changed" means here. The same map answers both questions the lane
 * asks: its keys are the files Stryker is pointed at, and its values are what a
 * surviving mutant is measured against, so the two cannot disagree about what
 * the change was.
 *
 * `--unified=0` is what makes the answer lines rather than neighbourhoods: with
 * context the hunk header covers untouched lines either side, and a mutant
 * sitting in one of them would be reported as something this branch introduced.
 * `--diff-filter=d` drops what the branch deleted, since Stryker is handed
 * paths to read. `--relative` makes both the pathspec and the reported paths
 * the working directory's rather than the repository root's, which is the same
 * statement the repo contract and the upgrade gate make with `<rev>:./path`: a
 * monorepo's project sits below the root, and a path measured from the root
 * would be handed to Stryker as one it cannot resolve from the project.
 * `:(glob)` gives git the pattern semantics the layer rule means, where a
 * single wildcard stops at a slash and a double one does not — a bare pathspec
 * crosses slashes on either, so a workspace's element would classify a project
 * nested deeper than any workspace declares.
 */
async function changeSet(root: string, rev: string, globs: readonly string[]): Promise<Changed> {
  const diff = await git(root, [
    // Off, so a path outside ASCII arrives as itself rather than inside quotes
    // with escapes in it — the name is matched against the mutation report's.
    "-c",
    "core.quotepath=false",
    "diff",
    "--relative",
    "--unified=0",
    "--diff-filter=d",
    rev,
    "--",
    ...globs.map((glob) => `:(glob)${glob}/**`),
  ]);
  if (!diff.ok) throw new Error(`git diff against ${rev} failed in ${root}`);

  const changed = new Map<string, Set<number>>();
  const problems: Problem[] = [];
  let unnamed: string | undefined;
  let lines: Set<number> | undefined;

  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith(OPENS)) {
      unnamed = line;
      lines = undefined;
      continue;
    }
    if (unnamed !== undefined && line.startsWith(NAMES)) {
      // git delimits the name with a tab when it holds a space.
      const named = line.slice(NAMES.length);
      const tab = named.indexOf("\t");
      const file = tab === -1 ? named : named.slice(0, tab);
      unnamed = undefined;
      if (isMutable(file)) {
        lines = new Set();
        changed.set(file, lines);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;
    if (unnamed !== undefined) {
      // Content changed under a name this parser could not read: git C-quotes a
      // path holding a quote, a backslash or a control character, and its
      // header then reads `+++ "b/…"`. Refused rather than skipped, because a
      // domain file the lane cannot see is a domain file the lane cannot grade
      // while reporting that it did.
      problems.push({ message: renameProblem(unnamed) });
      unnamed = undefined;
      continue;
    }
    if (lines === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let at = start; at < start + count; at += 1) lines.add(at);
  }
  return { changed, problems };
}

function renameProblem(header: string): string {
  return `rename the file this branch changed so git can name it plainly — \`${header}\` is quoted because the path holds a quote, a backslash or a control character, and the lane cannot tell whether it is domain code`;
}

interface Mutant {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly mutator: string;
  readonly replacement: string;
  readonly status: Status;
}

/**
 * Stryker's own report, flattened to the mutants it holds and parsed at the
 * boundary rather than asserted through. The mutation-testing report schema is
 * another tool's contract, so a document that is not the shape read here says
 * so as itself instead of surfacing later as a score computed over nothing.
 */
function parseReport(text: string): Mutant[] {
  const parsed: unknown = JSON.parse(text);
  const files = isObject(parsed) ? parsed["files"] : undefined;
  if (!isObject(files)) {
    throw new Error(`the mutation report has no files object — it holds ${kindOf(files)}`);
  }
  return Object.entries(files).flatMap(([file, value]) => {
    const listed = isObject(value) ? value["mutants"] : undefined;
    if (!Array.isArray(listed)) {
      throw new Error(`the mutation report's ${file} has no mutants array`);
    }
    return listed.filter(isObject).map((mutant) => asMutant(file, mutant));
  });
}

function asMutant(file: string, value: ConfigObject): Mutant {
  const location = isObject(value["location"]) ? value["location"] : {};
  const at = (end: string): number => {
    const point = location[end];
    const line = isObject(point) ? point["line"] : undefined;
    if (typeof line !== "number")
      throw new Error(`a mutant in ${file} has no location.${end}.line`);
    return line;
  };
  const text = (key: string): string => {
    const found = value[key];
    return typeof found === "string" ? found : "";
  };
  const status = oneOf(STATUSES, value["status"]);
  if (status === undefined) {
    throw new Error(
      `a mutant in ${file} carries ${kindOf(value["status"])} where the report schema names one of: ${STATUSES.join(", ")}`,
    );
  }
  return {
    file,
    from: at("start"),
    to: at("end"),
    mutator: text("mutatorName"),
    replacement: text("replacement"),
    status,
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
 * A value out of the repo's own source, as a code span it cannot end early. The
 * step summary is markdown, and a replacement carrying a backtick — every
 * template literal in the tree does — closes the span, leaving the rest of the
 * line to render as headings and table rows somebody wrote in a domain file.
 * The same statement `commanded` in `_lib/gate.ts` makes about annotations: the
 * text is not the gate author's to trust.
 *
 * CommonMark's own rule, rather than an escape: a span fenced by more backticks
 * than its longest run contains cannot be ended from inside, and a space either
 * side keeps a leading or trailing backtick from eating the fence.
 */
function span(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const runs = [...flat.matchAll(/`+/g)].map((run) => run[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

interface Tally {
  readonly detected: number;
  readonly undetected: number;
  /** What the suite caught over what it could have. */
  readonly score: number;
}

/** A mutant with where it sits and what that makes it worth, decided once. */
interface Graded {
  readonly mutant: Mutant;
  readonly own: boolean;
  readonly worth: Worth;
}

/**
 * The counts and the ratio in one pass, or nothing when the run graded no
 * mutant at all — a file of types, or one Stryker declined entirely. Absent
 * rather than a zero score, which is a different claim: zero says the suite
 * caught none of them.
 */
function tally(graded: readonly Graded[]): Tally | undefined {
  const detected = graded.filter((each) => each.worth === "detected").length;
  const undetected = graded.filter((each) => each.worth === "undetected").length;
  const counted = detected + undetected;
  return counted === 0 ? undefined : { detected, undetected, score: detected / counted };
}

/**
 * What the reader has to write, which is the only thing separating the
 * undetected statuses. The replacement is in the message rather than only in
 * the summary table because a line carries several mutants — an operator and
 * the block around it — and annotations that read identically are one finding
 * as far as anyone scrolling the step is concerned.
 */
function survivorProblem(mutant: Mutant): Problem {
  const at = `line ${mutant.from}`;
  const swap = `\`${mutant.replacement}\` (${mutant.mutator})`;
  const wrote = "this branch wrote that line";
  const message =
    mutant.status === "NoCoverage"
      ? `write the test that reaches ${at}: this branch wrote it and nothing runs it, so ${swap} in its place goes unnoticed`
      : mutant.status === "Ignored"
        ? `write the test for ${at} or drop the \`Stryker disable\` above it: ${wrote}, and a disabled ${swap} counts as one nothing caught rather than leaving the score`
        : `write the case that fails on ${swap} at ${at}: ${wrote} and the suite passes either way`;
  return { file: mutant.file, message };
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

/** How Stryker is asked to mutate exactly these files with the house runner. */
function strykerConfig(mutate: readonly string[], report: string, sandbox: string): string {
  return JSON.stringify({
    testRunner: "bun",
    coverageAnalysis: "perTest",
    plugins: [RUNNER],
    mutate,
    reporters: ["json"],
    jsonReporter: { fileName: report },
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
 *
 * A filename crosses three name-spaces on its way through here — git's diff
 * output, the filesystem under `root`, Stryker's glob resolver — and the one
 * failure this gate cannot afford is a file that goes missing between two of
 * them, because a file nobody mutated has no mutants and reads as a pass. So
 * both crossings are checked rather than assumed: `changeSet` refuses a name it
 * could not read out of the diff, and every `mutate` entry Stryker could not
 * resolve is refused by name below.
 */
export async function mutationLane({ root, event, floor }: Input): Promise<Lane> {
  const bound = floorFrom(floor);

  const domain = await domainGlobs(root);
  if (!("globs" in domain)) return nothing("the pure domain is not declared", [...domain.problems]);

  const base = await baseRevision(root, event, READS_THE_BASE_REF);
  if ("refused" in base) {
    return nothing("the base ref could not be read", [{ message: base.refused }]);
  }
  if (base.rev === undefined) {
    return nothing("there is no earlier commit to compare against — nothing to mutate");
  }
  const rev = base.rev;

  const { changed, problems } = await changeSet(root, rev, domain.globs);
  if (problems.length > 0) return nothing("a changed file could not be named", problems);
  if (changed.size === 0) {
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
    const requested = new Map([...changed.keys()].map((file) => [literal(file), file]));
    await Bun.write(config, strykerConfig([...requested.keys()], report, join(scratch, "sandbox")));

    const proc = Bun.spawn([stryker, "run", config], { cwd: root, stdout: "pipe", stderr: "pipe" });
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
        table: undefined,
        log: wrote,
        problems: missing,
      };

    if (status !== 0) {
      return {
        note: "the mutation run did not finish",
        table: undefined,
        log: wrote,
        problems: [
          {
            message: `fix what the run reported above: it exited ${status} without a report, so nothing was graded`,
          },
        ],
      };
    }

    return verdict(await Bun.file(report).text(), changed, bound);
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

/**
 * The lines the branch wrote in the file a mutant is in. Refused rather than
 * read as "no lines", because the report's files are the files Stryker was
 * pointed at: one it names that the change set does not is the two ends
 * disagreeing about what was mutated, and reading that as an empty set turns
 * the lane into a step that runs and can no longer fail.
 */
function linesOf(
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  file: string,
): ReadonlySet<number> {
  const lines = changed.get(file);
  if (lines === undefined) {
    throw new Error(
      `the mutation report names ${file}, which is not a file the lane asked it to mutate`,
    );
  }
  return lines;
}

/** What the report says, as the score to publish and the mutants to fail on. */
function verdict(
  text: string,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  bound: number | undefined,
): Lane {
  const graded = parseReport(text).map((mutant): Graded => {
    const own = inTheChange(mutant, linesOf(changed, mutant.file));
    return { mutant, own, worth: worthOf(mutant.status, own) };
  });
  const counted = tally(graded);
  const files = `${changed.size} changed domain file${changed.size === 1 ? "" : "s"}`;
  if (counted === undefined) return nothing(`${files} held no mutants`);

  const surviving = graded
    .filter((each) => each.own && each.worth === "undetected")
    .map((each) => each.mutant);

  const problems = surviving.map(survivorProblem);
  if (bound !== undefined && counted.score < bound) {
    problems.push({
      message: `kill the mutants listed in the run summary: ${percent(counted.score)} of the mutants in ${files} were caught, under the ${percent(bound)} floor this repo declares`,
    });
  }

  return {
    note: `mutation score ${percent(counted.score)} over ${files}`,
    table: table(counted, surviving, bound),
    log: undefined,
    problems,
  };
}

/** The measurement, in the shape the coverage floor's own README paragraph argues for. */
function table(counted: Tally, surviving: readonly Mutant[], bound: number | undefined): string {
  return [
    "### Mutation lane",
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    `| Mutation score (changed domain files) | ${percent(counted.score)} |`,
    `| Caught | ${counted.detected} |`,
    `| Undetected | ${counted.undetected} |`,
    `| Undetected on this branch's own lines | ${surviving.length} |`,
    `| Floor | ${bound === undefined ? "none — published, not enforced" : percent(bound)} |`,
    "",
    ...surviving.map(
      (mutant) =>
        `- ${span(`${mutant.file}:${mutant.from}`)} ${mutant.mutator} → ${span(mutant.replacement)} (${mutant.status})`,
    ),
    "",
    "A floor, not a target: it catches a change that shipped without the test that",
    "pins it. Raise it only once the score comfortably exceeds it.",
    "",
  ].join("\n");
}
