import {
  type ConfigObject,
  DEPENDENCY_FIELDS,
  type Event,
  isIgnored,
  isList,
  isTracked,
  manifests,
  type Problem,
  readConfig,
  record,
  repoFiles,
} from "../_lib/gate.ts";
import { checkPins, isExactVersion } from "../_lib/dependency-specs.ts";
import { CI_WORKFLOW } from "./ci-workflow.ts";
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

async function checkLineage(
  root: string,
  contents: ConfigObject,
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

  const oxlintrc = await readConfig(root, ".oxlintrc.json");
  problems.push(...oxlintrc.problems);
  if (oxlintrc.contents !== undefined) {
    const inherits = extendsList(oxlintrc.contents["extends"]).some((entry) =>
      entry.endsWith(`${DEV_CONFIG}/oxlint.base.json`),
    );
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
  if (install["saveExact"] !== true) {
    problems.push({ file: "bunfig.toml", message: "[install] saveExact must be true" });
  }
  if (test["coverageThreshold"] === undefined) {
    problems.push({
      file: "bunfig.toml",
      message:
        "[test] coverageThreshold must declare the coverage floor — it is what makes bun test a gate",
    });
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
  /** The caller runs the database job, so the repo has to own a migration entry point. */
  readonly database: boolean;
  /** Facts this repo is structurally unable to satisfy, each named at the call site. */
  readonly exemptions: readonly string[];
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

  if (contract.database && record(contents["scripts"])["db:migrate"] === undefined) {
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

  const none = Promise.resolve<Problem[]>([]);
  const [base, lockfiles, lineage, bunfig, lefthook, secrets, docs, live] = await Promise.all([
    // Nothing else in this batch reads the base ref, and it is the one entry
    // that spawns a process per question — so it runs beside them rather than
    // ahead of them.
    lifecycleAtBase(root, contract.event),
    checkLockfiles(root),
    checkLineage(root, rootManifest.value, exempt("config-lineage")),
    checkBunfig(root),
    checkLefthook(root),
    exempt("secrets") ? none : checkSecrets(root),
    exempt("docs-spine") ? none : checkDocs(root),
    declared.is === "live"
      ? checkLive(root, all.read, { database: contract.database, call: call.asked })
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
    ...bunfig,
    ...lefthook,
    ...secrets,
    ...docs,
    ...call.problems,
    ...live,
  ];
}
