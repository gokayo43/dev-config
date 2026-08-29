/**
 * The clean tree every repo-contract case is a mutation of, and the three ways
 * of mutating it. Shared because the suite is split by what it grades — how a
 * dependency spec is read is its own file — and a fixture each would be two
 * definitions of "a repo that passes", drifting apart on the first new fact.
 */
import type { Event } from "../.github/actions/_lib/gate.ts";
import type { Contract } from "../.github/actions/repo-contract/repo-contract.ts";
import { repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { materialise, type Tree } from "./tree.ts";

/** The commit a fixture's CI call is pinned to; any 40 hex characters would do. */
export const PIN = "f1a8afef270d30bf25f2f30275ecf988123d9fb3";

/**
 * The fields a case mutates, named rather than read off a parse. The fixture
 * writes this file three lines below, so a case that goes through `JSON.parse`
 * to change one key is asserting a shape it wrote itself — and the assertion,
 * not the type, is what would still be there the day a field is renamed.
 */
export interface PackageJson {
  name: string;
  /** Optional because a manifest that has not declared one is a case the gate grades. */
  packageManager?: string;
  /** `unknown`, not `string`: what the gate says about a lifecycle that is not one is a case too. */
  lifecycle?: unknown;
  /** Optional because a repo that runs no scripts is a repo this grades too. */
  scripts?: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const MANIFEST: PackageJson = {
  name: "clean",
  packageManager: "bun@1.3.11",
  lifecycle: "dev",
  scripts: { "db:migrate": "bun run src/server/migrate.ts", test: "bun test" },
  devDependencies: {
    "@gokayo43/dev-config": "github:gokayo43/dev-config#04d2938c7e1368d79169426d944107c9a0674fbc",
    typescript: "7.0.2",
    "oxlint-tsgolint": "7.1.0",
  },
};

const THRESHOLD = "{ lines = 0.75, functions = 0.75 }";

const BUNFIG = `[install]\nminimumReleaseAge = 604800\nexact = true\n\n[test]\ncoverageThreshold = ${THRESHOLD}\n`;

export const CLEAN: Tree = {
  "package.json": JSON.stringify(MANIFEST),
  "tsconfig.json": JSON.stringify({ extends: "@gokayo43/dev-config/tsconfig.base.json" }),
  ".oxlintrc.json": JSON.stringify({
    extends: ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
  }),
  "knip.ts":
    'import { base } from "@gokayo43/dev-config/knip.base.ts";\nexport default { ...base };\n',
  "bunfig.toml": BUNFIG,
  "lefthook.yml":
    "pre-commit:\n  commands:\n    secrets:\n      run: gitleaks git --staged --redact --no-banner .\n\npre-push:\n  commands:\n    typecheck:\n      run: bun run typecheck\n    test:\n      run: bun test\n",
  ".gitignore": "node_modules\n.env\n.env.*\n!.env.example\n!.env.enc\n",
  ".env": "BETTER_AUTH_SECRET=not-a-real-value\n",
  ".env.example": "BETTER_AUTH_SECRET=\n",
  "CONTEXT.md": "# Domain\n",
  "CLAUDE.md": "# Repo\n",
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n    with:\n      database: postgres\n`,
};

/** No pull request and no previous tip: what a workflow_dispatch or a first push tells the gate. */
const NO_EVENT: Event = { baseRef: "", before: "" };

export const DEFAULTS: Contract = {
  database: "postgres",
  exemptions: [],
  dataJobsExternal: "",
  event: NO_EVENT,
};

export async function contract(tree: Tree, overrides: Partial<Contract> = {}): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

/**
 * A manifest with one thing about it changed, written back as the file. Takes
 * the manifest it starts from, because the two suites that grade a package.json
 * declare different repos and only the shape is shared.
 */
export function manifestJson(
  manifest: PackageJson,
  change: (contents: PackageJson) => void,
): string {
  const contents = structuredClone(manifest);
  change(contents);
  return JSON.stringify(contents);
}

export function manifestWith(change: (contents: PackageJson) => void): Tree {
  return { ...CLEAN, "package.json": manifestJson(MANIFEST, change) };
}

export function withSpec(name: string, spec: string): Tree {
  return manifestWith((contents) => {
    contents.devDependencies[name] = spec;
  });
}

/**
 * A config with the reason above one of its switch-offs taken out, which is the
 * only way to ask the off-reason walker whether it would find one missing —
 * asserting that a config draws no findings is a test a walker returning nothing
 * at all passes.
 *
 * Shared because the suites that ask it grade different subjects — a rule the
 * base switches off at the top level, and one it switches off inside an
 * `overrides` block — over one definition of what the walker reads as the
 * reason. Two splicers are two answers to that, drifting apart the first time
 * the walker learns a new comment shape.
 *
 * `under` is the `files` glob of the block holding the switch-off, for a rule
 * the base turns off more than once: picking one by its position in the file is
 * a case that silently starts grading a different block the day one is added.
 * @param text The config as shipped.
 * @param rule The rule whose reason to remove.
 * @param under The `files` glob of the block that owns it, when more than one does.
 */
export function withoutReasonFor(text: string, rule: string, under = ""): string {
  const lines = text.split("\n");
  const block = under === "" ? -1 : lines.findIndex((line) => line.includes(under));
  const at = lines.findIndex((line, index) => index > block && line.trim().startsWith(`"${rule}"`));
  if (at === -1) throw new Error(`${rule} is not switched off under ${under || "the top level"}`);
  let first = at;
  while (first > 0 && (lines[first - 1] ?? "").trim().startsWith("//")) first -= 1;
  lines.splice(first, at - first);
  return lines.join("\n");
}

/** The clean tree with a different coverage floor written into its bunfig. */
export function withThreshold(threshold: string): Tree {
  return { ...CLEAN, "bunfig.toml": BUNFIG.replace(THRESHOLD, threshold) };
}
