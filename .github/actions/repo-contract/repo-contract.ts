import { stat } from "node:fs/promises";

import {
  DEPENDENCY_FIELDS,
  isIgnored,
  isTracked,
  type Manifest,
  manifests,
  type Problem,
  record,
  repoFiles,
} from "../_lib/gate.ts";

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
  "docs-spine": "the repo has a domain to glossary and decisions to record",
  secrets: "the repo has an environment to shape",
} as const;

type Exemption = keyof typeof EXEMPTIONS;

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // Nothing at that path, which is the answer the caller asked for.
    return false;
  }
}

function specOf(contents: Record<string, unknown>, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const spec = record(contents[field])[name];
    if (typeof spec === "string") return spec;
  }
  return undefined;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * `npm:` aliases another package, so the alias's own spec is the one that has
 * to be exact. The version is part of the match rather than something sliced
 * off afterwards: `npm:bar` names no version at all, and a slice-then-recurse
 * reading of it recurses on its own input forever.
 */
const NPM_ALIAS = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/;

/**
 * An allowlist, not a blocklist. `18`, `next` and `1.x` float exactly as much
 * as `^1.2.3` does, and the ways npm spells "whatever is newest" are
 * open-ended — so a spec has to prove it resolves to one thing rather than fail
 * to match a list of the spellings someone thought of.
 *
 * The protocols below are exact by construction: a workspace member is whatever
 * the workspace holds, a path names one tree, a git dependency names one when it
 * carries a ref, and `npm:` is an alias whose own spec is checked.
 */
function isExact(spec: string): boolean {
  if (EXACT_SEMVER.test(spec)) return true;
  if (/^(workspace|file|link|catalog|portal):/.test(spec)) return true;
  const alias = NPM_ALIAS.exec(spec);
  if (alias !== null) return EXACT_SEMVER.test(alias[1] ?? "");
  if (/^(github|gitlab|bitbucket|git|git\+[a-z]+):/.test(spec)) return spec.includes("#");
  return false;
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function checkPins(all: readonly Manifest[]): Problem[] {
  // peerDependencies are the one place a range is the point: they declare what
  // a consumer may bring, not what this repo installs.
  return all.flatMap(({ file, contents }) =>
    (["dependencies", "devDependencies", "optionalDependencies"] as const).flatMap((field) =>
      Object.entries(record(contents[field]))
        .filter(([, spec]) => typeof spec !== "string" || !isExact(spec))
        .map(([name, spec]) => ({
          file,
          message: `${field}.${name} is declared as '${String(spec)}' — a dependency names one exact version, or a protocol that resolves to one tree`,
        })),
    ),
  );
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
  contents: Record<string, unknown>,
  exempt: boolean,
): Promise<Problem[]> {
  const problems: Problem[] = [];

  const tsconfig = await readJson(`${root}/tsconfig.json`);
  if (tsconfig === undefined) {
    problems.push({ file: "tsconfig.json", message: "tsconfig.json is missing" });
  } else if (
    !exempt &&
    !extendsList(tsconfig["extends"]).includes(`${DEV_CONFIG}/tsconfig.base.json`)
  ) {
    problems.push({
      file: "tsconfig.json",
      message: `tsconfig.json must extend ${DEV_CONFIG}/tsconfig.base.json`,
    });
  }

  const oxlintrc = await readJson(`${root}/.oxlintrc.json`);
  if (oxlintrc === undefined) {
    problems.push({ file: ".oxlintrc.json", message: ".oxlintrc.json is missing" });
  } else {
    const inherits = extendsList(oxlintrc["extends"]).some((entry) =>
      entry.endsWith(`${DEV_CONFIG}/oxlint.base.json`),
    );
    if (!exempt && !inherits) {
      problems.push({
        file: ".oxlintrc.json",
        message: `.oxlintrc.json must extend ./node_modules/${DEV_CONFIG}/oxlint.base.json`,
      });
    }
    if (specOf(contents, "oxlint-tsgolint") === undefined) {
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
  const text = await readText(`${root}/bunfig.toml`);
  if (text === undefined) return [{ file: "bunfig.toml", message: "bunfig.toml is missing" }];

  const config = Bun.TOML.parse(text) as Record<string, unknown>;
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

async function checkLefthook(root: string): Promise<Problem[]> {
  const text = await readText(`${root}/lefthook.yml`);
  if (text === undefined) return [{ file: "lefthook.yml", message: "lefthook.yml is missing" }];

  const hooks = record(Bun.YAML.parse(text));
  const runs = (hook: string): string[] =>
    Object.values(record(record(hooks[hook])["commands"])).map((command) => {
      const run = record(command)["run"];
      return typeof run === "string" ? run : "";
    });

  const problems: Problem[] = [];
  if (!runs("pre-commit").some((run) => run.includes("gitleaks") && run.includes("--staged"))) {
    problems.push({
      file: "lefthook.yml",
      message:
        "pre-commit must scan the index with `gitleaks git --staged` — a key that reaches a commit is already burned",
    });
  }

  const prePush = runs("pre-push");
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
  if (!(await isDirectory(`${root}/docs/adr`))) {
    problems.push({
      file: "docs/adr",
      message: "docs/adr/ is missing — decisions are recorded in the repo they bind",
    });
  }
  if (!(await Bun.file(`${root}/CLAUDE.md`).exists())) {
    problems.push({ file: "CLAUDE.md", message: "CLAUDE.md is missing" });
  }
  return problems;
}

async function checkWorkflow(root: string): Promise<Problem[]> {
  const file = ".github/workflows/ci.yml";
  const text = await readText(`${root}/${file}`);
  if (text === undefined) return [{ file, message: "the repo has no CI workflow" }];

  const jobs = record(record(Bun.YAML.parse(text))["jobs"]);
  const calls = Object.values(jobs).map((job) => record(job)["uses"]);
  if (calls.some((uses) => typeof uses === "string" && CHECK_CALL.test(uses))) return [];
  return [
    {
      file,
      message:
        "no job calls gokayo43/dev-config/.github/workflows/check.yml pinned to a 40-character commit SHA — a tag is a name someone else can repoint",
    },
  ];
}

export interface Contract {
  /** The caller runs the database job, so the repo has to own a migration entry point. */
  readonly database: boolean;
  /** Facts this repo is structurally unable to satisfy, each named at the call site. */
  readonly exemptions: readonly string[];
}

function checkRoot(contents: Record<string, unknown>, contract: Contract): Problem[] {
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
  } else if (EXACT_SEMVER.test(typescript) && Number.parseInt(typescript, 10) < 7) {
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
      message: `'${name}' is not a contract fact — exemptions are one of: ${Object.keys(EXEMPTIONS).join(", ")}`,
    }));
  }
  const exempt = (name: Exemption): boolean => contract.exemptions.includes(name);

  const all = await manifests(root);
  const rootManifest = all.find(({ file }) => file === "package.json");
  if (rootManifest === undefined) {
    return [{ file: "package.json", message: "the repo has no package.json" }];
  }

  const none = Promise.resolve<Problem[]>([]);
  const checks = await Promise.all([
    checkLockfiles(root),
    checkLineage(root, rootManifest.contents, exempt("config-lineage")),
    checkBunfig(root),
    checkLefthook(root),
    exempt("secrets") ? none : checkSecrets(root),
    exempt("docs-spine") ? none : checkDocs(root),
    exempt("ci-call") ? none : checkWorkflow(root),
  ]);

  return [...checkRoot(rootManifest.contents, contract), ...checkPins(all), ...checks.flat()];
}
