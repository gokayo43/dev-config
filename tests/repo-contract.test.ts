import { afterEach, describe, expect, test } from "bun:test";

import { type Contract, repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { discard, materialise, type Tree, without } from "./tree.ts";

const PIN = "f1a8afef270d30bf25f2f30275ecf988123d9fb3";

const MANIFEST = {
  name: "clean",
  packageManager: "bun@1.3.11",
  scripts: { "db:migrate": "bun run src/server/migrate.ts", test: "bun test" },
  devDependencies: {
    "@gokayo43/dev-config": "github:gokayo43/dev-config#v0.6.0",
    typescript: "7.0.2",
    "oxlint-tsgolint": "7.1.0",
  },
};

const CLEAN: Tree = {
  "package.json": JSON.stringify(MANIFEST),
  "tsconfig.json": JSON.stringify({ extends: "@gokayo43/dev-config/tsconfig.base.json" }),
  ".oxlintrc.json": JSON.stringify({
    extends: ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
  }),
  "knip.ts": 'import { base } from "@gokayo43/dev-config/knip.base.ts";\nexport default { ...base };\n',
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

const DEFAULTS: Contract = { database: true, staticSite: false };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(discard));
});

async function contract(tree: Tree, overrides: Partial<Contract> = {}): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  roots.push(root);
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

function manifestWith(change: (manifest: Record<string, unknown>) => void): Tree {
  const manifest = JSON.parse(CLEAN["package.json"] ?? "") as Record<string, unknown>;
  change(manifest);
  return { ...CLEAN, "package.json": JSON.stringify(manifest) };
}

describe("repo contract", () => {
  test("a repo that declares everything passes", async () => {
    expect(await contract(CLEAN)).toEqual([]);
  });

  test("the package manager has to be bun, pinned", async () => {
    const missing = await contract(manifestWith((manifest) => delete manifest["packageManager"]));
    expect(missing).toEqual([expect.stringContaining("packageManager")]);
    const wrong = await contract(manifestWith((manifest) => (manifest["packageManager"] = "pnpm@10")));
    expect(wrong).toEqual([expect.stringContaining("packageManager")]);
  });

  test("another package manager's lockfile is refused", async () => {
    expect(await contract({ ...CLEAN, "pnpm-lock.yaml": "lockfileVersion: 9\n" })).toEqual([
      expect.stringContaining("bun.lock is the only lockfile"),
    ]);
  });

  test("a range outside peerDependencies is refused", async () => {
    const problems = await contract(
      manifestWith((manifest) => {
        (manifest["devDependencies"] as Record<string, string>)["oxfmt"] = "^0.61.0";
      }),
    );
    expect(problems).toEqual([expect.stringContaining("devDependencies.oxfmt is pinned as '^0.61.0'")]);
  });

  test("a peer range is the one place a range means something", async () => {
    expect(
      await contract(manifestWith((manifest) => (manifest["peerDependencies"] = { react: ">=19" }))),
    ).toEqual([]);
  });

  test("a workspace protocol and a git tag are exact by construction", async () => {
    expect(
      await contract(
        manifestWith((manifest) => {
          (manifest["dependencies"] as unknown) = { "clean-api": "workspace:*" };
        }),
      ),
    ).toEqual([]);
  });

  test("typescript below 7 is refused", async () => {
    expect(
      await contract(
        manifestWith((manifest) => {
          (manifest["devDependencies"] as Record<string, string>)["typescript"] = "5.9.3";
        }),
      ),
    ).toEqual([expect.stringContaining("typescript is pinned at 5.9.3")]);
  });

  test("extending the oxlint base without tsgolint is refused", async () => {
    expect(
      await contract(
        manifestWith((manifest) => {
          delete (manifest["devDependencies"] as Record<string, string>)["oxlint-tsgolint"];
        }),
      ),
    ).toEqual([expect.stringContaining("oxlint-tsgolint is missing")]);
  });

  test.each([
    ["tsconfig.json", "tsconfig.json must extend"],
    [".oxlintrc.json", ".oxlintrc.json must extend"],
    ["knip.ts", "knip.ts is missing"],
    ["bunfig.toml", "bunfig.toml is missing"],
    ["lefthook.yml", "lefthook.yml is missing"],
    ["CONTEXT.md", "domain glossary is missing"],
    ["CLAUDE.md", "CLAUDE.md is missing"],
    ["docs/adr/0000-template.md", "docs/adr/ is missing"],
    [".github/workflows/ci.yml", "no CI workflow"],
  ])("a repo with no %s is refused", async (path, message) => {
    expect(await contract(without(CLEAN, path))).toEqual([expect.stringContaining(message)]);
  });

  test("a JSON knip config cannot reach the shared base, so it is refused outright", async () => {
    expect(await contract({ ...CLEAN, "knip.json": '{"entry":["src/index.ts"]}' })).toEqual([
      expect.stringContaining("knip.json is resolved before knip.ts"),
    ]);
  });

  test("bunfig has to hold new releases, pin exactly, and floor coverage", async () => {
    expect(
      await contract({ ...CLEAN, "bunfig.toml": "[install]\nminimumReleaseAge = 0\nsaveExact = false\n" }),
    ).toEqual([
      expect.stringContaining("minimumReleaseAge"),
      expect.stringContaining("saveExact"),
      expect.stringContaining("coverageThreshold"),
    ]);
  });

  test("the hooks have to scan the index and gate the push", async () => {
    expect(
      await contract({
        ...CLEAN,
        "lefthook.yml": "pre-commit:\n  commands:\n    secrets:\n      run: gitleaks git .\n",
      }),
    ).toEqual([
      expect.stringContaining("gitleaks git --staged"),
      expect.stringContaining("pre-push must typecheck"),
      expect.stringContaining("pre-push must run the test suite"),
    ]);
  });

  test("a tracked .env is refused", async () => {
    const root = await materialise(CLEAN, [".env.example", ".env"]);
    roots.push(root);
    expect((await repoContract(root, DEFAULTS)).map(({ message }) => message)).toEqual([
      expect.stringContaining(".env is tracked"),
    ]);
  });

  test("an untracked .env.example is refused", async () => {
    const root = await materialise(CLEAN, []);
    roots.push(root);
    expect((await repoContract(root, DEFAULTS)).map(({ message }) => message)).toEqual([
      expect.stringContaining(".env.example must be tracked"),
    ]);
  });

  test("a blanket .env.* rule with no negations swallows the files that must ship", async () => {
    expect(await contract({ ...CLEAN, ".gitignore": "node_modules\n.env\n.env.*\n" })).toEqual([
      expect.stringContaining(".env.example is caught"),
      expect.stringContaining(".env.enc is caught"),
    ]);
  });

  test("a docs spine is not asked of a static site", async () => {
    const stripped = without(without(without(CLEAN, "CONTEXT.md"), "CLAUDE.md"), "docs/adr/0000-template.md");
    expect(await contract(stripped, { staticSite: true })).toEqual([]);
    expect(await contract(stripped, { staticSite: false })).toHaveLength(3);
  });

  test("db:migrate is only required of a repo that runs the database gate", async () => {
    const tree = manifestWith((manifest) => {
      delete (manifest["scripts"] as Record<string, string>)["db:migrate"];
    });
    expect(await contract(tree, { database: true })).toEqual([expect.stringContaining("db:migrate")]);
    expect(await contract(tree, { database: false })).toEqual([]);
  });

  test("a CI call pinned to a tag is refused", async () => {
    const floating = (CLEAN[".github/workflows/ci.yml"] ?? "").replace(`@${PIN}`, "@v0.6.0");
    expect(await contract({ ...CLEAN, ".github/workflows/ci.yml": floating })).toEqual([
      expect.stringContaining("40-character commit SHA"),
    ]);
  });

  test("a CI workflow that calls something else entirely is refused", async () => {
    expect(
      await contract({
        ...CLEAN,
        ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo green\n",
      }),
    ).toEqual([expect.stringContaining("check.yml")]);
  });
});
