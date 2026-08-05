import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { type Problem, isIgnored, isTracked, report, repoFiles } from "../_lib/gate.ts";

const DEV_CONFIG = "@gokayo43/dev-config";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** knip resolves these before any TypeScript config, and none of them can import the shared base. */
const KNIP_JSON_CONFIGS = ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc"];

const KNIP_CONFIGS = ["knip.ts", "knip.config.ts", "knip.js", "knip.config.js", "knip.mjs"];

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@[0-9a-f]{40}$/;

export interface Contract {
  /** The caller runs the database job, so the repo has to own a migration entry point. */
  readonly database: boolean;
  /** A marketing site has no domain to glossary and no decisions to record. */
  readonly staticSite: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

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

function specOf(manifest: Record<string, unknown>, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const spec = record(manifest[field])[name];
    if (typeof spec === "string") return spec;
  }
  return undefined;
}

/** Everything but an exact version. `workspace:*` and `github:owner/repo#tag` resolve to one thing by construction. */
function isRange(spec: string): boolean {
  return (
    /^[\^~><=]/.test(spec) || /^(\*|x|latest)$/.test(spec) || spec.includes("||") || spec.includes(" - ")
  );
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

async function checkManifests(root: string, problems: Problem[]): Promise<void> {
  for (const file of await repoFiles(root, ["package.json", "*/package.json"])) {
    if (basename(file) !== "package.json") continue;
    const manifest = (await Bun.file(`${root}/${file}`).json()) as Record<string, unknown>;

    // peerDependencies are the one place a range is the point: it declares what
    // a consumer may bring, not what this repo installs.
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, spec] of Object.entries(record(manifest[field]))) {
        if (typeof spec === "string" && isRange(spec)) {
          problems.push({
            file,
            message: `${field}.${name} is pinned as '${spec}' — versions are exact here, so a lockfile refresh cannot change what is installed`,
          });
        }
      }
    }
  }

  for (const lockfile of await repoFiles(
    root,
    LOCKFILES.flatMap((name) => [name, `*/${name}`]),
  )) {
    problems.push({
      file: lockfile,
      message: "bun.lock is the only lockfile — another package manager's lockfile drifts silently",
    });
  }
}

async function checkLineage(
  root: string,
  manifest: Record<string, unknown>,
  problems: Problem[],
): Promise<void> {
  const tsconfig = await readJson(`${root}/tsconfig.json`);
  if (tsconfig === undefined || !extendsList(tsconfig["extends"]).includes(`${DEV_CONFIG}/tsconfig.base.json`)) {
    problems.push({
      file: "tsconfig.json",
      message: `tsconfig.json must extend ${DEV_CONFIG}/tsconfig.base.json`,
    });
  }

  const oxlintrc = await readJson(`${root}/.oxlintrc.json`);
  const extendsOxlintBase = extendsList(oxlintrc?.["extends"]).some((entry) =>
    entry.endsWith(`${DEV_CONFIG}/oxlint.base.json`),
  );
  if (!extendsOxlintBase) {
    problems.push({
      file: ".oxlintrc.json",
      message: `.oxlintrc.json must extend ./node_modules/${DEV_CONFIG}/oxlint.base.json`,
    });
  } else if (specOf(manifest, "oxlint-tsgolint") === undefined) {
    problems.push({
      file: "package.json",
      message:
        "oxlint-tsgolint is missing — the base turns on type-aware rules, and without that package oxlint runs them over nothing and reports clean",
    });
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
  } else if (!knip[1]?.includes(`${DEV_CONFIG}/knip.base.ts`)) {
    problems.push({ file: knip[0], message: `${knip[0]} must import base from ${DEV_CONFIG}/knip.base.ts` });
  }
}

async function checkBunfig(root: string, problems: Problem[]): Promise<void> {
  const text = await readText(`${root}/bunfig.toml`);
  if (text === undefined) {
    problems.push({ file: "bunfig.toml", message: "bunfig.toml is missing" });
    return;
  }
  const config = Bun.TOML.parse(text) as Record<string, unknown>;
  const install = record(config["install"]);
  const test = record(config["test"]);

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
      message: "[test] coverageThreshold must declare the coverage floor — it is what makes bun test a gate",
    });
  }
}

async function checkLefthook(root: string, problems: Problem[]): Promise<void> {
  const text = await readText(`${root}/lefthook.yml`);
  if (text === undefined) {
    problems.push({ file: "lefthook.yml", message: "lefthook.yml is missing" });
    return;
  }
  const hooks = record(Bun.YAML.parse(text));
  const runs = (hook: string): string[] =>
    Object.values(record(record(hooks[hook])["commands"])).map((command) => {
      const run = record(command)["run"];
      return typeof run === "string" ? run : "";
    });

  const preCommit = runs("pre-commit");
  if (!preCommit.some((run) => run.includes("gitleaks") && run.includes("--staged"))) {
    problems.push({
      file: "lefthook.yml",
      message:
        "pre-commit must scan the index with `gitleaks git --staged` — a key that reaches a commit is already burned",
    });
  }

  const prePush = runs("pre-push");
  if (!prePush.some((run) => run.includes("typecheck"))) {
    problems.push({ file: "lefthook.yml", message: "pre-push must typecheck, so a green push is a green CI run" });
  }
  if (!prePush.some((run) => /\btest\b/.test(run))) {
    problems.push({ file: "lefthook.yml", message: "pre-push must run the test suite" });
  }
}

async function checkSecrets(root: string, problems: Problem[]): Promise<void> {
  if (await isTracked(root, ".env")) {
    problems.push({ file: ".env", message: ".env is tracked — the plaintext environment never leaves the box" });
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
}

async function checkDocs(root: string, problems: Problem[]): Promise<void> {
  const hasGlossary =
    (await Bun.file(`${root}/CONTEXT.md`).exists()) || (await Bun.file(`${root}/CONTEXT-MAP.md`).exists());
  if (!hasGlossary) {
    problems.push({ file: "CONTEXT.md", message: "the domain glossary is missing (CONTEXT.md or CONTEXT-MAP.md)" });
  }
  if (!(await isDirectory(`${root}/docs/adr`))) {
    problems.push({ file: "docs/adr", message: "docs/adr/ is missing — decisions are recorded in the repo they bind" });
  }
  if (!(await Bun.file(`${root}/CLAUDE.md`).exists())) {
    problems.push({ file: "CLAUDE.md", message: "CLAUDE.md is missing" });
  }
}

async function checkWorkflow(root: string, problems: Problem[]): Promise<void> {
  const file = ".github/workflows/ci.yml";
  const text = await readText(`${root}/${file}`);
  if (text === undefined) {
    problems.push({ file, message: "the repo has no CI workflow" });
    return;
  }
  const jobs = record(record(Bun.YAML.parse(text))["jobs"]);
  const calls = Object.values(jobs).map((job) => record(job)["uses"]);
  if (!calls.some((uses) => typeof uses === "string" && CHECK_CALL.test(uses))) {
    problems.push({
      file,
      message:
        "no job calls gokayo43/dev-config/.github/workflows/check.yml pinned to a 40-character commit SHA — a tag is a name someone else can repoint",
    });
  }
}

export async function repoContract(root: string, contract: Contract): Promise<Problem[]> {
  const problems: Problem[] = [];
  const manifest = await readJson(`${root}/package.json`);
  if (manifest === undefined) return [{ file: "package.json", message: "the repo has no package.json" }];

  const packageManager = manifest["packageManager"];
  if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) {
    problems.push({
      file: "package.json",
      message:
        "packageManager must read bun@<version> — setup-bun takes the runner's Bun from it, so CI and the dev machine cannot drift",
    });
  }

  const typescript = specOf(manifest, "typescript");
  if (typescript === undefined) {
    problems.push({ file: "package.json", message: "typescript is not declared" });
  } else if (!(Number.parseInt(typescript, 10) >= 7)) {
    problems.push({
      file: "package.json",
      message: `typescript is pinned at ${typescript} — the shared tsconfig is written against TypeScript 7`,
    });
  }

  if (contract.database && record(manifest["scripts"])["db:migrate"] === undefined) {
    problems.push({
      file: "package.json",
      message: "the database gate replays migrations through `bun run db:migrate`, and the script is missing",
    });
  }

  await checkManifests(root, problems);
  await checkLineage(root, manifest, problems);
  await checkBunfig(root, problems);
  await checkLefthook(root, problems);
  await checkSecrets(root, problems);
  if (!contract.staticSite) await checkDocs(root, problems);
  await checkWorkflow(root, problems);

  return problems;
}

if (import.meta.main) {
  report(
    await repoContract(process.cwd(), {
      database: Bun.env["INPUT_DATABASE"] === "true",
      staticSite: Bun.env["INPUT_STATIC_SITE"] === "true",
    }),
  );
}
