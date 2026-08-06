import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

import {
  DEPENDENCY_FIELDS,
  isIgnored,
  isTracked,
  jsonObjects,
  type Manifest,
  manifests,
  oneOf,
  type Problem,
  record,
  repoFiles,
} from "../_lib/gate.ts";

/**
 * Whether the repo is deployed and carrying people, said by the repo about
 * itself rather than inferred from anything. Nothing derives it — a repo with a
 * hostname, a compose file and a backup script is indistinguishable from one
 * three days away from its first deploy — so it is declared, and moving it to
 * `live` is the owner's own commit. Everything below it reconfigures off that
 * one word.
 */
const LIFECYCLES = ["dev", "live"] as const;

type Lifecycle = (typeof LIFECYCLES)[number];

/** The field as one of those, or nothing — which is its own problem and never a default. */
function lifecycleOf(contents: Record<string, unknown>): Lifecycle | undefined {
  return oneOf(LIFECYCLES, contents["lifecycle"]);
}

/**
 * Whether the repo owns a database, asked of the repo rather than of the
 * caller. `db:migrate` is the entry point every database gate here drives, so
 * a workspace that declares one owns migrations.
 *
 * Every manifest, not just the root — a monorepo keeps its migrations in the
 * workspace that owns the schema, and the root's script is a passthrough to it.
 * Asking only the root would put two edits between a live repo and no database
 * rules at all: drop the `database` input, then delete a passthrough that now
 * looks like dead weight.
 *
 * It matters that none of this is the `database` input. That input says which
 * CI job runs, and it lives in the very file the live rules are about — so
 * keying off it would let a live repo shed its backup script, its rehearsed
 * restore and its upgrade gate by deleting one line from its own workflow,
 * which is the opposite of what a contract is for.
 */
function ownsDatabase(all: readonly Manifest[]): boolean {
  return all.some(({ value }) => record(value["scripts"])["db:migrate"] !== undefined);
}

const DEV_CONFIG = "@gokayo43/dev-config";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** knip resolves these before any TypeScript config, and none of them can import the shared base. */
const KNIP_JSON_CONFIGS = ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc"];

const KNIP_CONFIGS = ["knip.ts", "knip.config.ts", "knip.js", "knip.config.js", "knip.mjs"];

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@[0-9a-f]{40}$/;

/**
 * The two scripts a live repo's *data* rests on, and what is on the other end
 * of each. Owed by a live repo that owns a database — a live marketing site
 * owes crash reporting and nothing here, and asking it for a backup script is
 * asking it to perform a ritual over a database it does not have.
 */
const LIVE_DATA_SCRIPTS = [
  ["scripts/backup.sh", "a systemd timer runs it, and an undumped database is one nobody has"],
  ["scripts/restore-drill.sh", "a backup nobody has restored is a backup nobody has"],
] as const;

/**
 * Sentry's SDKs are one per runtime — `@sentry/bun`, `@sentry/astro`,
 * `@sentry/tanstackstart-react`, `@sentry/react-native` — and the fact being
 * asserted is that something in this repo reports its crashes, not which of
 * them a given program reached for. So the scope is the prefix: a list of the
 * ones we happen to use today would fail the first repo on a runtime nobody had
 * thought of, which is a gate teaching a lesson about itself.
 */
const SENTRY = "@sentry/";

const EXECUTABLE = 0o111;

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

interface Config {
  /** Undefined whenever there is nothing to grade — `problems` says which of the two reasons. */
  readonly contents: Record<string, unknown> | undefined;
  readonly problems: readonly Problem[];
}

/**
 * A JSON config this contract grades, or the problem standing in for it.
 * Missing and unreadable are different states — only the first is fixed by
 * writing the file — and neither leaves a caller fields to read.
 */
async function readJson(root: string, file: string): Promise<Config> {
  if (!(await Bun.file(`${root}/${file}`).exists())) {
    return { contents: undefined, problems: [{ file, message: `${file} is missing` }] };
  }
  const batch = await jsonObjects(root, [file]);
  return { contents: batch.read[0]?.value, problems: batch.problems };
}

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

/**
 * What is at that path, or nothing when there is nothing. Absent is an answer
 * rather than a failure to every caller here — a directory that is not there, a
 * script that is not there — and absent is a different state from present and
 * wrong, which is what the callers go on to ask about.
 */
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function specOf(contents: Record<string, unknown>, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const spec = record(contents[field])[name];
    if (typeof spec === "string") return spec;
  }
  return undefined;
}

/**
 * The fields a package is actually shipped from. `devDependencies` declares
 * what builds and tests the repo and reaches no deployment, and
 * `peerDependencies` states what a consumer may bring — the same reasoning the
 * pin check applies in reverse. A Sentry SDK in either is a repo that does not
 * report its crashes.
 */
const SHIPPED_FIELDS = ["dependencies", "optionalDependencies"] as const;

/** Any of Sentry's per-runtime SDKs, among what a manifest actually ships. */
function hasSentry(contents: Record<string, unknown>): boolean {
  return SHIPPED_FIELDS.some((field) =>
    Object.keys(record(contents[field])).some((name) => name.startsWith(SENTRY)),
  );
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * `npm:` aliases another package, so the alias's own spec is the one that has
 * to be exact. The version is part of the match rather than something sliced
 * off afterwards: `npm:bar` names no version at all, and a slice-then-recurse
 * reading of it recurses on its own input forever.
 */
const NPM_ALIAS = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/;

/** A git dependency resolves to one tree only when its ref is a commit. */
const GIT_PROTOCOL = /^(github|gitlab|bitbucket|git|git\+[a-z]+):/;
const COMMIT = /^[0-9a-f]{40}$/;

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
  // `#main` moves, a tag can be repointed, and `#semver:^1.0.0` is a range
  // wearing a fragment. Only a commit names one tree for good.
  if (GIT_PROTOCOL.test(spec)) return COMMIT.test(spec.slice(spec.indexOf("#") + 1));
  return false;
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function checkPins(all: readonly Manifest[]): Problem[] {
  // peerDependencies are the one place a range is the point: they declare what
  // a consumer may bring, not what this repo installs.
  return all.flatMap(({ file, value }) =>
    (["dependencies", "devDependencies", "optionalDependencies"] as const).flatMap((field) =>
      Object.entries(record(value[field]))
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

  const tsconfig = await readJson(root, "tsconfig.json");
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

  const oxlintrc = await readJson(root, ".oxlintrc.json");
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
    ...(Array.isArray(nested) ? nested.flatMap(runsOf) : []),
  ];
}

function hookRuns(hooks: Record<string, unknown>, hook: string): string[] {
  const node = record(hooks[hook]);
  const jobs = node["jobs"];
  return [
    ...Object.values(record(node["commands"])).flatMap(runsOf),
    ...(Array.isArray(jobs) ? jobs.flatMap(runsOf) : []),
  ];
}

async function checkLefthook(root: string): Promise<Problem[]> {
  const text = await readText(`${root}/lefthook.yml`);
  if (text === undefined) return [{ file: "lefthook.yml", message: "lefthook.yml is missing" }];

  const hooks = record(Bun.YAML.parse(text));
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
  if ((await statOf(`${root}/docs/adr`))?.isDirectory() !== true) {
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

/** The repo's call into the shared gate, and what is wrong with the workflow that should hold it. */
interface Call {
  /** The `with:` block of the job that calls check.yml, or nothing when no job does. */
  readonly asked: Record<string, unknown> | undefined;
  readonly problems: Problem[];
}

const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * Read once and handed to everyone who has a question about it. Two rules turn
 * on this file — that the call exists and is pinned, and that a live repo's
 * copy of it asks for the upgrade gate — and they belong to different subjects:
 * one is about the workflow, the other about the lifecycle. Threading a
 * `live` boolean into the first would put the second inside a check that is not
 * about it, and hide the fact that `ci-call` waives both.
 */
async function checkCall(root: string): Promise<Call> {
  const text = await readText(`${root}/${CI_WORKFLOW}`);
  if (text === undefined) {
    return {
      asked: undefined,
      problems: [{ file: CI_WORKFLOW, message: "the repo has no CI workflow" }],
    };
  }

  const jobs = record(record(Bun.YAML.parse(text))["jobs"]);
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

/**
 * What `lifecycle: "live"` asserts the repo already has. Each is something the
 * day it is needed is far too late to acquire: a dump nobody took, a restore
 * nobody rehearsed, a crash nobody was told about, a migration nobody proved
 * upgrades. They are derived from the one field rather than asked for per repo,
 * so going live is one commit and not a checklist somebody works half of.
 *
 * Scoped to what the repo actually is. Crash reporting is owed by anything with
 * users; everything else here is about a database, and is owed exactly when the
 * repo owns one. A live marketing site has no database to dump, no lineage to
 * upgrade and no drill to rehearse — demanding them would teach people to write
 * a script that does nothing in order to get past a gate.
 */
interface Database {
  /** The repo declares a migration entry point, so it owns a schema. */
  readonly owned: boolean;
  /** The caller runs the database job, so something replays that schema. */
  readonly gated: boolean;
}

async function checkLive(
  root: string,
  all: readonly Manifest[],
  database: Database,
  call: Call,
): Promise<Problem[]> {
  const problems: Problem[] = [];

  // Everything about a database is owed exactly when the repo owns one — read
  // from its own migration entry point, never from the workflow input, which
  // would let a live repo shed all three of these by deleting one line of the
  // file they are about.
  //
  // A repo that owns a schema and runs no job over it is that same hole from
  // the other side: the rules would apply and every one of them would be
  // unenforceable, since the gate proving an upgrade never runs.
  if (database.owned && !database.gated) {
    problems.push({
      file: CI_WORKFLOW,
      message:
        "a live repo that owns migrations must pass `database: true` to check.yml — nothing replays this schema otherwise, and the upgrade gate below has no job to run in",
    });
  }

  // The upgrade gate is here rather than beside the other workflow rules for a
  // harder reason than symmetry: check.yml *refuses* `upgrade-gate: true`
  // without `database: true`, so asking a live site with no database for it
  // would be this contract demanding the one config the shared workflow
  // rejects.
  if (database.owned) {
    // Read off the call rather than out of the file's text, for the reason the
    // pin is: the fact is "this job asks check.yml for the upgrade gate", and a
    // repo can spell those words in a comment, in a second job, or in a
    // workflow that calls something else entirely. Both YAML spellings count —
    // GitHub casts a quoted `"true"` to the boolean the input declares, so a
    // repo that wrote it that way is asking for the gate and getting it.
    // `asked` is undefined only when the call itself is already a problem.
    const gate = call.asked?.["upgrade-gate"];
    if (call.asked !== undefined && gate !== true && gate !== "true") {
      problems.push({
        file: CI_WORKFLOW,
        message:
          "a live repo's check.yml call must pass `upgrade-gate: true` — from the first deploy the migration lineage is a one-way record, and that is the gate proving an upgrade reaches the schema a rebuild does",
      });
    }

    const found = await Promise.all(
      LIVE_DATA_SCRIPTS.map(async ([path, why]) => ({
        path,
        why,
        mode: (await statOf(`${root}/${path}`))?.mode,
      })),
    );
    for (const { path, why, mode } of found) {
      if (mode === undefined) {
        problems.push({ file: path, message: `a live repo owns ${path} — ${why}` });
      } else if ((mode & EXECUTABLE) === 0) {
        problems.push({
          file: path,
          message: `${path} is not executable — chmod +x it, since it is run as a program rather than handed to an interpreter`,
        });
      }
    }
  }

  if (!all.some(({ value }) => hasSentry(value))) {
    problems.push({
      file: "package.json",
      message: `a live repo reports its crashes — declare the ${SENTRY} SDK for whatever it runs on, since a failure only the user sees is one nobody fixes`,
    });
  }

  return problems;
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

  if (lifecycleOf(contents) === undefined) {
    const declared = contents["lifecycle"];
    const found = declared === undefined ? "is absent" : `reads ${JSON.stringify(declared)}`;
    problems.push({
      file: "package.json",
      message: `lifecycle ${found} — it says "dev" or "live", and moving it to "live" is the commit that declares this repo carries real users: from then on it owes backups, a rehearsed restore, crash reporting and the upgrade gate`,
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
  const rootManifest = all.read.find(({ file }) => file === "package.json");
  if (rootManifest === undefined) {
    // Absent and unreadable are different states, and only one of them is
    // fixed by writing a package.json. When the file is there and will not
    // parse, the problems already say so and naming the file is the point.
    return all.problems.length > 0
      ? all.problems
      : [{ file: "package.json", message: "the repo has no package.json" }];
  }

  // A repo that has not said which it is gets the one diagnostic about the
  // field and is graded against neither set of rules: choosing for it is the
  // choice the field exists to take away from us.
  const lifecycle = lifecycleOf(rootManifest.value);

  // One read of the workflow, two subjects asking about it — and `ci-call`
  // waives both, which is a thing to be able to see rather than to discover.
  // A repo whose CI is not a call into check.yml has no call to pass
  // `upgrade-gate: true` to.
  const call = exempt("ci-call") ? { asked: undefined, problems: [] } : await checkCall(root);

  const none = Promise.resolve<Problem[]>([]);
  const [lockfiles, lineage, bunfig, lefthook, secrets, docs, live] = await Promise.all([
    checkLockfiles(root),
    checkLineage(root, rootManifest.value, exempt("config-lineage")),
    checkBunfig(root),
    checkLefthook(root),
    exempt("secrets") ? none : checkSecrets(root),
    exempt("docs-spine") ? none : checkDocs(root),
    lifecycle === "live"
      ? checkLive(root, all.read, { owned: ownsDatabase(all.read), gated: contract.database }, call)
      : none,
  ]);

  // Spelled out rather than flattened from the batch, because the order is the
  // thing being decided here — it is what a reader of a failing run sees, and
  // what the fixtures assert. `call.problems` was read before the batch and
  // takes its place in that order like anything else.
  return [
    ...checkRoot(rootManifest.value, contract),
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
