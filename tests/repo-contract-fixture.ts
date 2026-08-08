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

const MANIFEST = {
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

export const CLEAN: Tree = {
  "package.json": JSON.stringify(MANIFEST),
  "tsconfig.json": JSON.stringify({ extends: "@gokayo43/dev-config/tsconfig.base.json" }),
  ".oxlintrc.json": JSON.stringify({
    extends: ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
  }),
  "knip.ts":
    'import { base } from "@gokayo43/dev-config/knip.base.ts";\nexport default { ...base };\n',
  "bunfig.toml":
    "[install]\nminimumReleaseAge = 604800\nsaveExact = true\n\n[test]\ncoverage = true\ncoverageThreshold = { lines = 0.75, functions = 0.75 }\n",
  "lefthook.yml":
    "pre-commit:\n  commands:\n    secrets:\n      run: gitleaks git --staged --redact --no-banner .\n\npre-push:\n  commands:\n    typecheck:\n      run: bun run typecheck\n    test:\n      run: bun test\n",
  ".gitignore": "node_modules\n.env\n.env.*\n!.env.example\n!.env.enc\n",
  ".env": "BETTER_AUTH_SECRET=not-a-real-value\n",
  ".env.example": "BETTER_AUTH_SECRET=\n",
  "CONTEXT.md": "# Domain\n",
  "CLAUDE.md": "# Repo\n",
  "docs/adr/0000-template.md": "# 0. Template\n",
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n    with:\n      database: true\n`,
};

/** No pull request and no previous tip: what a workflow_dispatch or a first push tells the gate. */
const NO_EVENT: Event = { baseRef: "", before: "" };

export const DEFAULTS: Contract = { database: true, exemptions: [], event: NO_EVENT };

export async function contract(tree: Tree, overrides: Partial<Contract> = {}): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

export function manifestWith(change: (contents: Record<string, unknown>) => void): Tree {
  const contents = JSON.parse(CLEAN["package.json"] ?? "") as Record<string, unknown>;
  change(contents);
  return { ...CLEAN, "package.json": JSON.stringify(contents) };
}

export function withSpec(name: string, spec: string): Tree {
  return manifestWith((contents) => {
    (contents["devDependencies"] as Record<string, string>)[name] = spec;
  });
}
