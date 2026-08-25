import {
  type ConfigFile,
  type ConfigObject,
  DEPENDENCY_FIELDS,
  type Event,
  isIgnored,
  isList,
  isObject,
  isTracked,
  manifests,
  type Problem,
  readConfig,
  record,
  repoFiles,
  withoutComments,
} from "../_lib/gate.ts";
import { checkPins, isExactVersion } from "../_lib/dependency-specs.ts";
import { CI_WORKFLOW, type DatabaseGates } from "./ci-workflow.ts";
import { checkLifecycle, checkLive, declaredIn, lifecycleAtBase } from "./live.ts";

const DEV_CONFIG = "@gokayo43/dev-config";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** knip resolves these before any TypeScript config, and none of them can import the shared base. */
const KNIP_JSON_CONFIGS = ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc"];

const KNIP_CONFIGS = ["knip.ts", "knip.config.ts", "knip.js", "knip.config.js", "knip.mjs"];

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@[0-9a-f]{40}$/;

/**
 * Facts a repo can be structurally unable to satisfy, as opposed to merely not
 * having got round to. Naming one puts the gap in the caller's workflow, where
 * it is reviewable, instead of inside the gate as a silent special case.
 */
const EXEMPTIONS = {
  "config-lineage": "the configs inherit from this repo by package name",
  "ci-call": "CI is a call into the shared check.yml",
  "docs-spine": "the repo has a domain worth a glossary and agents worth briefing",
  "lifecycle-retire": "the repo still carries the people its lifecycle says it does",
  secrets: "the repo has an environment to shape",
} as const;

type Exemption = keyof typeof EXEMPTIONS;

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

function specOf(contents: ConfigObject, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const spec = record(contents[field])[name];
    if (typeof spec === "string") return spec;
  }
  return undefined;
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return isList(value) ? value.filter((entry) => typeof entry === "string") : [];
}

async function checkLockfiles(root: string): Promise<Problem[]> {
  const found = await repoFiles(
    root,
    LOCKFILES.flatMap((name) => [name, `*/${name}`]),
  );
  return found.map((file) => ({
    file,
    message: "bun.lock is the only lockfile — another package manager's lockfile drifts silently",
  }));
}

/**
 * Where a switch-off is written: the name it switches off, and the line it is
 * on (counted from zero).
 */
interface OffSite {
  readonly name: string;
  readonly line: number;
}

/**
 * A block whose members can silence a rule, and what silencing looks like in
 * it. The path has array indices dropped, so one entry covers every override.
 *
 * `rules` and `categories` are switched off by oxlint's `AllowWarnDeny`, whose
 * schema documents `"allow"` as the synonym of `"off"` and `0` as the number
 * that means it — each also legal as the head of an array carrying the rule's
 * options. `options` is a different vocabulary with the same effect:
 * `typeAware: false` takes every type-aware rule in the base with it, which is
 * twelve rules at `error`, and `bun run lint` passes no flag that would put
 * them back. `overrides` carries no `categories` and no `options` of its own
 * (oxlint's `OxlintOverride`).
 *
 * `globals` and a rule's own options object are why this is a path rather than
 * a key: both hold members whose value is legitimately `"off"` or `false`, and
 * neither silences anything.
 */
const SWITCHES = new Map([
  ["rules", silencesRule],
  ["overrides.rules", silencesRule],
  ["categories", silencesRule],
  ["options", silencesOption],
]);

/** The JSON string starting at `at`, decoded, and the index just past its closing quote. */
function stringAt(text: string, at: number): { readonly value: string; readonly end: number } {
  let index = at + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      const end = index + 1;
      // Decoded rather than sliced, so the file has one spelling of each name
      // and each setting: `"off"` is a string oxlint reads as `off`,
      // and a gate comparing raw bytes reads it as something else entirely.
      const decoded = JSON.parse(text.slice(at, end)) as unknown;
      return { value: typeof decoded === "string" ? decoded : "", end };
    }
    index += 1;
  }
  return { value: "", end: text.length };
}

function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && (text[index] ?? "").trim() === "") index += 1;
  return index;
}

/** Whether the setting written at `at` switches its rule or category off. */
function silencesRule(text: string, at: number): boolean {
  const start = text[at] === "[" ? skipSpace(text, at + 1) : at;
  if (text[start] === '"') {
    const { value } = stringAt(text, start);
    return value === "off" || value === "allow";
  }
  if (text[start] !== "0") return false;
  const after = text[skipSpace(text, start + 1)] ?? "";
  return after === "," || after === "}" || after === "]";
}

/** Whether the option written at `at` switches a body of rules off. */
function silencesOption(text: string, at: number): boolean {
  return text.startsWith("false", at);
}

/** The line `at` falls on, counted from zero. */
function lineOf(text: string, at: number): number {
  let line = 0;
  for (let index = 0; index < at; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

/** What one walk of a config's text found: where it silences something, and how crowded each line is. */
interface Walk {
  readonly sites: OffSite[];
  /**
   * How many entries of a silencing block each line carries. Only those are
   * counted: an options object hanging off a rule that is staying on is not
   * something a reason could be about, so it cannot make one ambiguous.
   */
  readonly entries: Map<number, number>;
}

/**
 * Every switch-off in the config, found in one walk of its comment-blanked
 * text. One walk because off-ness has to be decided once: a pass that collected
 * names from the parse and then searched the text for them decides it twice, in
 * two dialects, and the two answers drift the first time a spelling is added.
 * The walk carries the path it is inside, which is what tells a `rules` block
 * from `globals` without asking the parse anything.
 */
function walkConfig(blanked: string): Walk {
  const sites: OffSite[] = [];
  const entries = new Map<number, number>();
  const path: string[] = [];
  let key: string | undefined;
  let index = 0;
  while (index < blanked.length) {
    const char = blanked[index];
    if (char === '"') {
      const { value, end } = stringAt(blanked, index);
      const colon = skipSpace(blanked, end);
      if (blanked[colon] !== ":") {
        index = end;
        continue;
      }
      const line = lineOf(blanked, index);
      const setting = skipSpace(blanked, colon + 1);
      const silences = SWITCHES.get(path.filter((step) => step !== "").join("."));
      if (silences !== undefined) {
        entries.set(line, (entries.get(line) ?? 0) + 1);
        if (silences(blanked, setting)) sites.push({ name: value, line });
      }
      key = value;
      index = setting;
      continue;
    }
    if (char === "{" || char === "[") {
      path.push(key ?? "");
      key = undefined;
    } else if (char === "}" || char === "]") {
      path.pop();
      key = undefined;
    }
    index += 1;
  }
  return { sites, entries };
}

/**
 * The comment lines above `line`, as the prose in them. Comment syntax is
 * stripped rather than trusted, because `//` and `/**\/` are a comment that says
 * nothing — the same empty waiver `allowlistFrom` already refuses, in the other
 * dialect a repo writes reasons in.
 *
 * A reason covers the contiguous **group of switch-offs** under it, not only the
 * first of them. One argument routinely retires several rules at once — the
 * paragraph explaining why `pedantic`, `style`, `restriction` and `nursery` are
 * not adopted is one reason about four of them, and writing it out four times
 * is what a rule demanding a comment per line actually asks for. So the walk
 * steps over the switch-offs above on its way up, and stops at everything else.
 *
 * A switch-off, rather than an entry, is what continues the group, and that is
 * the whole tightness of it: a rule left ON is a different subject, so the
 * comment above THAT is about the rule staying on and cannot be spent down here.
 * `oxlint.base.json` is the case — `"react/exhaustive-deps": "warn"` sits
 * between the JSX runtime's reason and `oxc/no-map-spread`, and a walk that
 * counted entries would hand the first's argument to the second. A blank line
 * closes the group as well, and so does any line carrying nothing at all: the
 * `"rules": {` a block opens with, or a multi-line entry's continuation.
 */
function reasonAbove(
  written: readonly string[],
  stripped: readonly string[],
  switchedOff: ReadonlySet<number>,
  line: number,
): string {
  let above = line - 1;
  while (above >= 0 && switchedOff.has(above)) above -= 1;
  const prose: string[] = [];
  for (; above >= 0; above -= 1) {
    const text = written[above] ?? "";
    if (text.trim() === "" || (stripped[above] ?? "").trim() !== "") break;
    prose.push(
      text
        .trim()
        .replace(/^\/\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\/\//, "")
        .replace(/^\*+/, "")
        .trim(),
    );
  }
  return prose.join(" ").trim();
}

/**
 * The reason beside every rule, category and option the config switches off.
 * Tightening a rule or reconfiguring it argues for itself in what it now
 * demands; switching one off argues nothing, and a switch-off with no reason
 * beside it is indistinguishable a year later from one added to get a run
 * green.
 *
 * The reason is owed per switch-off, not per line, so a switch-off sharing its
 * line with any other entry is refused outright: a comment above two entries on
 * one line says nothing about which of them it excuses, and a reader cannot
 * recover the difference. A comment above a run of switch-offs written one per
 * line is the opposite case and is read as covering that run — `reasonAbove`
 * has the argument. Read out of the text rather than the parse, because the parse is
 * precisely what drops the comment.
 */
function checkOffReasons(oxlintrc: ConfigFile): Problem[] {
  if (oxlintrc.text === undefined) return [];
  const blanked = withoutComments(oxlintrc.text);
  const written = oxlintrc.text.split("\n");
  const stripped = blanked.split("\n");
  const { sites, entries } = walkConfig(blanked);
  const switchedOff = new Set(sites.map(({ line }) => line));
  return sites.flatMap(({ name, line }) => {
    const crowded = (entries.get(line) ?? 0) > 1;
    if (!crowded && reasonAbove(written, stripped, switchedOff, line) !== "") return [];
    const why = crowded
      ? "shares its line with another entry — one switch-off per line, its reason above"
      : "is turned off with no reason — add the reason above the entry";
    return [{ file: ".oxlintrc.json", line: line + 1, message: `${name} ${why}` }];
  });
}

/**
 * oxlint reads the nearest config to the file it is linting, so a config in a
 * subdirectory REPLACES the root's rules for that whole subtree rather than
 * adding to them — an empty one turns the base off wherever it sits. There is
 * no diagnostic a reader of the root config could get from it, so the file is
 * refused instead of followed.
 */
async function checkNestedConfigs(root: string): Promise<Problem[]> {
  const found = await repoFiles(root, ["*/.oxlintrc.*", "*/oxlint.config.*"]);
  return found.map((file) => ({
    file,
    message:
      "a config below the root replaces the root's rules for its subtree, not adds to them — state the difference in the root's `overrides` instead",
  }));
}

async function checkLineage(
  root: string,
  contents: ConfigObject,
  reading: Promise<ConfigFile>,
  exempt: boolean,
): Promise<Problem[]> {
  const problems: Problem[] = [];

  const tsconfig = await readConfig(root, "tsconfig.json");
  problems.push(...tsconfig.problems);
  if (
    tsconfig.contents !== undefined &&
    !exempt &&
    !extendsList(tsconfig.contents["extends"]).includes(`${DEV_CONFIG}/tsconfig.base.json`)
  ) {
    problems.push({
      file: "tsconfig.json",
      message: `tsconfig.json must extend ${DEV_CONFIG}/tsconfig.base.json`,
    });
  }

  const oxlintrc = await reading;
  problems.push(...oxlintrc.problems);
  if (oxlintrc.contents !== undefined) {
    const targets = extendsList(oxlintrc.contents["extends"]);
    const inherits = targets.some((entry) => entry.endsWith(`${DEV_CONFIG}/oxlint.base.json`));
    // A second target is read after the base and wins over it, so anything it
    // switches off is switched off in a file this gate never opens. Refused
    // rather than followed: one file to read is the property that makes every
    // rule below checkable, and `overrides` is where a per-directory difference
    // already belongs. Graded even under `config-lineage`, which waives WHERE a
    // config inherits from and never how many places it inherits from.
    if (targets.length > 1) {
      problems.push({
        file: ".oxlintrc.json",
        message:
          "extends must name the shared base and nothing else — the gate reads .oxlintrc.json; put the override there",
      });
    }
    if (!inherits && !exempt) {
      problems.push({
        file: ".oxlintrc.json",
        message: `.oxlintrc.json must extend ./node_modules/${DEV_CONFIG}/oxlint.base.json`,
      });
    }
    // Only the base turns the type-aware rules on, so only a repo that
    // inherits it needs the package that runs them.
    if (inherits && specOf(contents, "oxlint-tsgolint") === undefined) {
      problems.push({
        file: "package.json",
        message:
          "oxlint-tsgolint is missing — the base turns on type-aware rules, and without that package oxlint runs them over nothing and reports clean",
      });
    }
  }

  for (const name of KNIP_JSON_CONFIGS) {
    if (await Bun.file(`${root}/${name}`).exists()) {
      problems.push({
        file: name,
        message: `${name} is resolved before knip.ts and cannot import ${DEV_CONFIG}/knip.base.ts — move the config to knip.ts`,
      });
    }
  }

  const configs = await Promise.all(
    KNIP_CONFIGS.map(async (name) => [name, await readText(`${root}/${name}`)] as const),
  );
  const knip = configs.find(([, text]) => text !== undefined);
  if (knip === undefined) {
    problems.push({ file: "knip.ts", message: "knip.ts is missing" });
  } else if (!exempt && !knip[1]?.includes(`${DEV_CONFIG}/knip.base.ts`)) {
    problems.push({
      file: knip[0],
      message: `${knip[0]} must import base from ${DEV_CONFIG}/knip.base.ts`,
    });
  }

  return problems;
}

/** The three floors bun reads out of the table form; it ignores every other key in silence. */
const COVERAGE_FLOORS = ["lines", "functions", "statements"];

const NEEDS_COVERAGE_FLOOR = `[test] coverageThreshold must be a floor a run can fail — a number above 0, or a table of ${COVERAGE_FLOORS.join(
  ", ",
)} floors above 0`;

/**
 * Whether the declared threshold can fail a run. Bun takes a number or a table
 * of the floors above and enforces none of the other ways of writing one: a
 * floor at or below zero, an empty table, and a key outside those three are all
 * ignored in silence (bun 1.4.0). So `coverageThreshold = 0` and
 * `{ line = 0.9 }` are both a declared threshold no run can breach — which is
 * the coverage gate absent, wearing the field that says it is there.
 */
function floorsCoverage(threshold: unknown): boolean {
  if (typeof threshold === "number") return threshold > 0;
  if (!isObject(threshold)) return false;
  const floors = Object.entries(threshold);
  return (
    floors.length > 0 &&
    floors.every(
      ([name, floor]) => COVERAGE_FLOORS.includes(name) && typeof floor === "number" && floor > 0,
    )
  );
}

async function checkBunfig(root: string): Promise<Problem[]> {
  // The same read every other config here gets, in the dialect this one is
  // written in. `Bun.TOML.parse` throws on a malformed file, and a bare throw
  // leaves the step with a parse error naming no file and takes every finding
  // the other checks had already produced with it.
  const bunfig = await readConfig(root, "bunfig.toml", "TOML");
  if (bunfig.contents === undefined) return [...bunfig.problems];

  const config = bunfig.contents;
  const install = record(config["install"]);
  const test = record(config["test"]);
  const problems: Problem[] = [];

  const minimumReleaseAge = install["minimumReleaseAge"];
  if (typeof minimumReleaseAge !== "number" || minimumReleaseAge <= 0) {
    problems.push({
      file: "bunfig.toml",
      message:
        "[install] minimumReleaseAge must hold new releases — a package published minutes ago must not be installable",
    });
  }
  // `exact`, and not `saveExact`, because `saveExact` is a key bun does not
  // read. Probed as a matched pair on both ends of the range this fleet runs —
  // `bun add lodash` under each key alone, HOME neutralised so no user bunfig
  // decides it: `exact = true` writes `4.18.1` on bun 1.3.11 and 1.4.0, and
  // `saveExact = true` writes `^4.18.1` on both, exactly as declaring neither
  // does. A gate asking for the second was asking for a line that pins nothing,
  // which is worse than asking for nothing: the repo carries the field, passes
  // the contract, and its next `bun add` writes a range anyway.
  if (install["exact"] !== true) {
    problems.push({
      file: "bunfig.toml",
      message:
        "[install] exact must be true — `saveExact` is not the key bun reads (probed, bun 1.3.11 and 1.4.0: under it `bun add` writes a caret range), and a floating spec is what the release-age window above exists to keep out of the lockfile",
    });
  }
  if (test["coverage"] !== undefined) {
    problems.push({
      file: "bunfig.toml",
      message:
        "[test] coverage decides where the floor is applied and belongs to CI, not to the repo — delete the key: `true` collects on every run its author makes, so a scoped `bun test <file>` exits 1 with nothing failing, and `false` wins over CI's --coverage, leaving the threshold below applied to nothing",
    });
  }
  if (!floorsCoverage(test["coverageThreshold"])) {
    problems.push({ file: "bunfig.toml", message: NEEDS_COVERAGE_FLOOR });
  }
  return problems;
}

/**
 * Both config shapes. lefthook 2.x leads with `jobs:` — a list, whose entries
 * may be a `group:` holding another list — and still accepts the older
 * `commands:` map. A gate that knew only one of them passes a config that
 * declares every hook it asks for and reads none of them.
 */
function runsOf(entry: unknown): string[] {
  const node = record(entry);
  const run = node["run"];
  const nested = record(node["group"])["jobs"];
  return [
    ...(typeof run === "string" ? [run] : []),
    ...(isList(nested) ? nested.flatMap(runsOf) : []),
  ];
}

function hookRuns(hooks: ConfigObject, hook: string): string[] {
  const node = record(hooks[hook]);
  const jobs = node["jobs"];
  return [
    ...Object.values(record(node["commands"])).flatMap(runsOf),
    ...(isList(jobs) ? jobs.flatMap(runsOf) : []),
  ];
}

async function checkLefthook(root: string): Promise<Problem[]> {
  const lefthook = await readConfig(root, "lefthook.yml", "YAML");
  if (lefthook.contents === undefined) return [...lefthook.problems];

  const hooks = lefthook.contents;
  const problems: Problem[] = [];

  if (
    !hookRuns(hooks, "pre-commit").some(
      (run) => run.includes("gitleaks") && run.includes("--staged"),
    )
  ) {
    problems.push({
      file: "lefthook.yml",
      message:
        "pre-commit must scan the index with `gitleaks git --staged` — a key that reaches a commit is already burned",
    });
  }

  const prePush = hookRuns(hooks, "pre-push");
  if (!prePush.some((run) => run.includes("typecheck"))) {
    problems.push({
      file: "lefthook.yml",
      message: "pre-push must typecheck, so a green push is a green CI run",
    });
  }
  if (!prePush.some((run) => /\btest\b/.test(run))) {
    problems.push({ file: "lefthook.yml", message: "pre-push must run the test suite" });
  }
  return problems;
}

async function checkSecrets(root: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  if (await isTracked(root, ".env")) {
    problems.push({
      file: ".env",
      message: ".env is tracked — the plaintext environment never leaves the box",
    });
  }
  if (!(await isIgnored(root, ".env"))) {
    problems.push({ file: ".gitignore", message: ".env must be gitignored" });
  }
  if (!(await isTracked(root, ".env.example"))) {
    problems.push({
      file: ".env.example",
      message: ".env.example must be tracked — it is the only record of the environment's shape",
    });
  }
  for (const path of [".env.example", ".env.enc"]) {
    if (await isIgnored(root, path)) {
      problems.push({
        file: ".gitignore",
        message: `${path} is caught by a .gitignore pattern — a blanket .env.* rule needs its negations`,
      });
    }
  }
  return problems;
}

/**
 * The glossary and the agent brief. A decision log is not part of the spine:
 * a why lives at the tightest anchor that can hold it — the comment at the
 * choke point, a CLAUDE.md line, or the issue that carries its trigger — and a
 * file that collects them is history the tree keeps re-reading.
 *
 * A tree that still carries `docs/adr/` passes here rather than being refused
 * (2026-08-08): the fleet's own folds land per repo under #26, and refusing the
 * directory before they do would fail every repo's gate on a file this repo has
 * asked for until today. Once #26 closes, this is the anchor for the tightening
 * it earns — refusing `docs/adr/` outright, and asking for `CONTEXT.md` by name
 * rather than accepting the `CONTEXT-MAP.md` the canon no longer recognises.
 */
async function checkDocs(root: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const hasGlossary =
    (await Bun.file(`${root}/CONTEXT.md`).exists()) ||
    (await Bun.file(`${root}/CONTEXT-MAP.md`).exists());
  if (!hasGlossary) {
    problems.push({
      file: "CONTEXT.md",
      message: "the domain glossary is missing (CONTEXT.md or CONTEXT-MAP.md)",
    });
  }
  if (!(await Bun.file(`${root}/CLAUDE.md`).exists())) {
    problems.push({ file: "CLAUDE.md", message: "CLAUDE.md is missing" });
  }
  return problems;
}

/** The repo's call into the shared gate, and what is wrong with the workflow that should hold it. */
interface Call {
  /** The `with:` block of the job that calls check.yml, or nothing when no job does. */
  readonly asked: ConfigObject | undefined;
  readonly problems: Problem[];
}

/**
 * Read once and handed to everyone who has a question about it. Two rules turn
 * on this file — that the call exists and is pinned, and that a live repo's
 * copy of it asks for the upgrade gate — and they belong to different subjects:
 * one is about the workflow, the other about the lifecycle. Threading a
 * `live` boolean into the first would put the second inside a check that is not
 * about it, and hide the fact that `ci-call` waives both.
 */
async function checkCall(root: string): Promise<Call> {
  if (!(await Bun.file(`${root}/${CI_WORKFLOW}`).exists())) {
    return {
      asked: undefined,
      problems: [{ file: CI_WORKFLOW, message: "the repo has no CI workflow" }],
    };
  }

  const workflow = await readConfig(root, CI_WORKFLOW, "YAML");
  if (workflow.contents === undefined)
    return { asked: undefined, problems: [...workflow.problems] };

  const jobs = record(workflow.contents["jobs"]);
  const call = Object.values(jobs)
    .map((job) => record(job))
    .find(({ uses }) => typeof uses === "string" && CHECK_CALL.test(uses));
  if (call === undefined) {
    return {
      asked: undefined,
      problems: [
        {
          file: CI_WORKFLOW,
          message:
            "no job calls gokayo43/dev-config/.github/workflows/check.yml pinned to a 40-character commit SHA — a tag is a name someone else can repoint",
        },
      ],
    };
  }
  return { asked: record(call["with"]), problems: [] };
}

export interface Contract {
  /**
   * Which database gates the caller runs. Anything but `none` replays this
   * repo's schema — check.yml's own Postgres job, or a wrapper workflow's —
   * so the repo has to own a migration entry point.
   */
  readonly database: DatabaseGates;
  /** Facts this repo is structurally unable to satisfy, each named at the call site. */
  readonly exemptions: readonly string[];
  /**
   * Where a live repo's backup and restore drill actually run, when they are not
   * this repo's own scripts. Empty is every repo that owns them; `live.ts` has
   * the argument for why the reason is the waiver rather than a word beside one.
   */
  readonly dataJobsExternal: string;
  /** Where the run came from, so the lifecycle can be read at the base ref as well as here. */
  readonly event: Event;
}

function checkRoot(contents: ConfigObject, contract: Contract): Problem[] {
  const problems: Problem[] = [];

  const packageManager = contents["packageManager"];
  if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) {
    problems.push({
      file: "package.json",
      message:
        "packageManager must read bun@<version> — setup-bun takes the runner's Bun from it, so CI and the dev machine cannot drift",
    });
  }

  // Only a spec checkPins has already accepted is read for a major: anything
  // else is reported there, and parsing `next` for a version number yields NaN
  // and a second diagnostic about the same line.
  const typescript = specOf(contents, "typescript");
  if (typescript === undefined) {
    problems.push({ file: "package.json", message: "typescript is not declared" });
  } else if (isExactVersion(typescript) && Number.parseInt(typescript, 10) < 7) {
    problems.push({
      file: "package.json",
      message: `typescript is pinned at ${typescript} — the shared tsconfig is written against TypeScript 7`,
    });
  }

  if (contract.database !== "none" && record(contents["scripts"])["db:migrate"] === undefined) {
    problems.push({
      file: "package.json",
      message:
        "the database gate replays migrations through `bun run db:migrate`, and the script is missing",
    });
  }

  return problems;
}

export async function repoContract(root: string, contract: Contract): Promise<Problem[]> {
  const unknown = contract.exemptions.filter((name) => !(name in EXEMPTIONS));
  if (unknown.length > 0) {
    return unknown.map((name) => ({
      message: `'${name}' is not a contract fact — the facts a repo can be excused are: ${Object.entries(
        EXEMPTIONS,
      )
        .map(([fact, waived]) => `${fact} (${waived})`)
        .join(", ")}`,
    }));
  }
  const exempt = (name: Exemption): boolean => contract.exemptions.includes(name);

  const all = await manifests(root);
  const rootManifest = all.read.find(({ file }) => file === "package.json");
  if (rootManifest === undefined) {
    // Absent and unreadable are different states, and only one of them is
    // fixed by writing a package.json. When the file is there and will not
    // parse, the problems already say so and naming the file is the point.
    return all.problems.length > 0
      ? all.problems
      : [{ file: "package.json", message: "the repo has no package.json" }];
  }

  const declared = declaredIn(rootManifest.value);

  // One read of the workflow, two subjects asking about it — and `ci-call`
  // waives both, which is a thing to be able to see rather than to discover.
  // A repo whose CI is not a call into check.yml has no call to pass
  // `upgrade-gate: true` to.
  const call = exempt("ci-call") ? { asked: undefined, problems: [] } : await checkCall(root);

  // One read of .oxlintrc.json, two subjects asking about it — where it
  // inherits from, and whether every switch-off in it carries a reason. Awaited
  // in the batch rather than before it, so the second subject is a member of
  // the batch like any other.
  const reading = readConfig(root, ".oxlintrc.json");

  const none = Promise.resolve<Problem[]>([]);
  const [base, lockfiles, lineage, nested, offReasons, bunfig, lefthook, secrets, docs, live] =
    await Promise.all([
      // Nothing else in this batch reads the base ref, and it is the one entry
      // that spawns a process per question — so it runs beside them rather than
      // ahead of them.
      lifecycleAtBase(root, contract.event),
      checkLockfiles(root),
      checkLineage(root, rootManifest.value, reading, exempt("config-lineage")),
      checkNestedConfigs(root),
      reading.then(checkOffReasons),
      checkBunfig(root),
      checkLefthook(root),
      exempt("secrets") ? none : checkSecrets(root),
      exempt("docs-spine") ? none : checkDocs(root),
      declared.is === "live"
        ? checkLive(root, all.read, {
            database: contract.database,
            call: call.asked,
            dataJobsExternal: contract.dataJobsExternal,
          })
        : none,
    ]);

  // Spelled out rather than flattened from the batch, because the order is the
  // thing being decided here — it is what a reader of a failing run sees, and
  // what the fixtures assert. `call.problems` was read before the batch and
  // takes its place in that order like anything else.
  return [
    ...checkRoot(rootManifest.value, contract),
    ...checkLifecycle(declared, base, exempt("lifecycle-retire")),
    ...all.problems,
    ...checkPins(all.read),
    ...lockfiles,
    ...lineage,
    ...nested,
    ...offReasons,
    ...bunfig,
    ...lefthook,
    ...secrets,
    ...docs,
    ...call.problems,
    ...live,
  ];
}
