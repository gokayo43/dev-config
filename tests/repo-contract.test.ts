import { describe, expect, test } from "bun:test";

import { type Contract, repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { materialise, type Tree, without } from "./tree.ts";
import { containing } from "./matchers.ts";

const PIN = "f1a8afef270d30bf25f2f30275ecf988123d9fb3";

const MANIFEST = {
  name: "clean",
  packageManager: "bun@1.3.11",
  scripts: { "db:migrate": "bun run src/server/migrate.ts", test: "bun test" },
  devDependencies: {
    "@gokayo43/dev-config": "github:gokayo43/dev-config#04d2938c7e1368d79169426d944107c9a0674fbc",
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

const DEFAULTS: Contract = { database: true, exemptions: [] };

async function contract(tree: Tree, overrides: Partial<Contract> = {}): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

function manifestWith(change: (contents: Record<string, unknown>) => void): Tree {
  const contents = JSON.parse(CLEAN["package.json"] ?? "") as Record<string, unknown>;
  change(contents);
  return { ...CLEAN, "package.json": JSON.stringify(contents) };
}

function withSpec(name: string, spec: string): Tree {
  return manifestWith((contents) => {
    (contents["devDependencies"] as Record<string, string>)[name] = spec;
  });
}

describe("repo contract", () => {
  test("a repo that declares everything passes", async () => {
    expect(await contract(CLEAN)).toEqual([]);
  });

  test("the package manager has to be bun, pinned", async () => {
    const missing = await contract(manifestWith((contents) => delete contents["packageManager"]));
    expect(missing).toEqual([containing("packageManager")]);
    const wrong = await contract(
      manifestWith((contents) => (contents["packageManager"] = "pnpm@10")),
    );
    expect(wrong).toEqual([containing("packageManager")]);
  });

  test("another package manager's lockfile is refused", async () => {
    expect(await contract({ ...CLEAN, "pnpm-lock.yaml": "lockfileVersion: 9\n" })).toEqual([
      containing("bun.lock is the only lockfile"),
    ]);
  });

  test.each([
    "^0.61.0",
    "~0.61.0",
    ">=0.61.0",
    "0.61.0 - 0.62.0",
    "0.61.0 || 0.62.0",
    "*",
    "x",
    "latest",
    "next",
    "18",
    "1.x",
    "1.2",
    "v1.2.3",
    "npm:bar",
    "npm:@scope/pkg",
    "npm:bar@^1.2.3",
  ])("a floating spec (%s) is refused", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([
      containing(`devDependencies.oxfmt is declared as '${spec}'`),
    ]);
  });

  test.each([
    "0.61.0",
    "1.0.0-rc.3",
    "1.0.0+build.7",
    "workspace:*",
    "file:../local",
    "link:../local",
    "catalog:default",
    "github:gokayo43/dev-config#04d2938c7e1368d79169426d944107c9a0674fbc",
    "git+ssh://git@github.com/o/r.git#04d2938c7e1368d79169426d944107c9a0674fbc",
    "npm:@scope/other@1.2.3",
  ])("a spec that resolves to one thing (%s) passes", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([]);
  });

  // A tag can be repointed at any commit, `#main` moves by design, and
  // `#semver:` is a range wearing a fragment. Only a commit names one tree.
  test.each([
    "github:gokayo43/dev-config",
    "github:gokayo43/dev-config#",
    "github:gokayo43/dev-config#main",
    "github:gokayo43/dev-config#v0.8.3",
    "github:gokayo43/dev-config#semver:^1.0.0",
    "git+ssh://git@github.com/o/r.git#3f9a1c2",
  ])("a git ref that is not a commit (%s) is refused", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([containing("devDependencies.oxfmt")]);
  });

  test("a peer range is the one place a range means something", async () => {
    expect(
      await contract(
        manifestWith((contents) => (contents["peerDependencies"] = { react: ">=19" })),
      ),
    ).toEqual([]);
  });

  test("typescript below 7 is refused", async () => {
    expect(await contract(withSpec("typescript", "5.9.3"))).toEqual([
      containing("typescript is pinned at 5.9.3"),
    ]);
  });

  test("extending the oxlint base without tsgolint is refused", async () => {
    expect(
      await contract(
        manifestWith((contents) => {
          delete (contents["devDependencies"] as Record<string, string>)["oxlint-tsgolint"];
        }),
      ),
    ).toEqual([containing("oxlint-tsgolint is missing")]);
  });

  test.each([
    ["tsconfig.json", "tsconfig.json is missing"],
    [".oxlintrc.json", ".oxlintrc.json is missing"],
    ["knip.ts", "knip.ts is missing"],
    ["bunfig.toml", "bunfig.toml is missing"],
    ["lefthook.yml", "lefthook.yml is missing"],
    ["CONTEXT.md", "domain glossary is missing"],
    ["CLAUDE.md", "CLAUDE.md is missing"],
    ["docs/adr/0000-template.md", "docs/adr/ is missing"],
    [".github/workflows/ci.yml", "no CI workflow"],
  ])("a repo with no %s is refused", async (path, message) => {
    expect(await contract(without(CLEAN, path))).toEqual([containing(message)]);
  });

  test("a JSON knip config cannot reach the shared base, so it is refused outright", async () => {
    expect(await contract({ ...CLEAN, "knip.json": '{"entry":["src/index.ts"]}' })).toEqual([
      containing("knip.json is resolved before knip.ts"),
    ]);
  });

  test("bunfig has to hold new releases, pin exactly, and floor coverage", async () => {
    expect(
      await contract({
        ...CLEAN,
        "bunfig.toml": "[install]\nminimumReleaseAge = 0\nsaveExact = false\n",
      }),
    ).toEqual([
      containing("minimumReleaseAge"),
      containing("saveExact"),
      containing("coverageThreshold"),
    ]);
  });

  // lefthook 2.x leads with `jobs:` — a list whose entries may be a `group:`
  // holding another list — and a gate that knew only `commands:` passed a
  // config declaring every hook it asks for while reading none of them.
  test("the jobs form is read, groups and all", async () => {
    const jobs = [
      "pre-commit:",
      "  jobs:",
      "    - name: secrets",
      "      run: gitleaks git --staged --redact --no-banner .",
      "",
      "pre-push:",
      "  jobs:",
      "    - name: whole project",
      "      group:",
      "        jobs:",
      "          - run: bun run typecheck",
      "          - run: bun test",
      "",
    ].join("\n");
    expect(await contract({ ...CLEAN, "lefthook.yml": jobs })).toEqual([]);
  });

  test("a jobs-form config that declares the hooks and runs nothing is still refused", async () => {
    const empty =
      "pre-commit:\n  jobs:\n    - run: echo hi\n\npre-push:\n  jobs:\n    - run: echo hi\n";
    expect(await contract({ ...CLEAN, "lefthook.yml": empty })).toEqual([
      containing("gitleaks git --staged"),
      containing("pre-push must typecheck"),
      containing("pre-push must run the test suite"),
    ]);
  });

  test("the hooks have to scan the index and gate the push", async () => {
    expect(
      await contract({
        ...CLEAN,
        "lefthook.yml": "pre-commit:\n  commands:\n    secrets:\n      run: gitleaks git .\n",
      }),
    ).toEqual([
      containing("gitleaks git --staged"),
      containing("pre-push must typecheck"),
      containing("pre-push must run the test suite"),
    ]);
  });

  test("a tracked .env is refused", async () => {
    const root = await materialise(CLEAN, [".env.example", ".env"]);
    expect((await repoContract(root, DEFAULTS)).map(({ message }) => message)).toEqual([
      containing(".env is tracked"),
    ]);
  });

  test("an untracked .env.example is refused", async () => {
    const root = await materialise(CLEAN, []);
    expect((await repoContract(root, DEFAULTS)).map(({ message }) => message)).toEqual([
      containing(".env.example must be tracked"),
    ]);
  });

  test("a blanket .env.* rule with no negations swallows the files that must ship", async () => {
    expect(await contract({ ...CLEAN, ".gitignore": "node_modules\n.env\n.env.*\n" })).toEqual([
      containing(".env.example is caught"),
      containing(".env.enc is caught"),
    ]);
  });

  test("db:migrate is only required of a repo that runs the database gate", async () => {
    const tree = manifestWith((contents) => {
      delete (contents["scripts"] as Record<string, string>)["db:migrate"];
    });
    expect(await contract(tree, { database: true })).toEqual([containing("db:migrate")]);
    expect(await contract(tree, { database: false })).toEqual([]);
  });

  test("a CI call pinned to a tag is refused", async () => {
    const floating = (CLEAN[".github/workflows/ci.yml"] ?? "").replace(`@${PIN}`, "@v0.6.0");
    expect(await contract({ ...CLEAN, ".github/workflows/ci.yml": floating })).toEqual([
      containing("40-character commit SHA"),
    ]);
  });

  test("a CI workflow that calls something else entirely is refused", async () => {
    expect(
      await contract({
        ...CLEAN,
        ".github/workflows/ci.yml":
          "name: CI\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo green\n",
      }),
    ).toEqual([containing("check.yml")]);
  });
});

describe("a manifest that will not parse", () => {
  // Absent and unreadable are different states, and only one of them is fixed
  // by writing a package.json.
  test("an unreadable root says so, rather than claiming the file is missing", async () => {
    const problems = await contract({ ...CLEAN, "package.json": "{ oops" });
    expect(problems).toEqual([containing("is not valid JSON")]);
    expect(problems[0]).not.toContain("has no package.json");
  });

  test("an absent root still says it is absent", async () => {
    expect(await contract(without(CLEAN, "package.json"))).toEqual([
      containing("the repo has no package.json"),
    ]);
  });

  // One bad workspace manifest used to reject the batch and take every finding
  // the good ones had already produced with it.
  test("an unreadable workspace manifest is named, and the rest are still read", async () => {
    const root = await materialise(
      {
        ...CLEAN,
        "apps/api/package.json": "{ oops",
        "apps/web/package.json": JSON.stringify({ dependencies: { oxfmt: "^0.61.0" } }),
      },
      [".env.example"],
    );
    const problems = (await repoContract(root, DEFAULTS)).map(
      ({ file, message }) => `${file ?? ""}: ${message}`,
    );
    expect(problems).toEqual([
      containing("apps/api/package.json: is not valid JSON"),
      containing("apps/web/package.json: dependencies.oxfmt is declared as '^0.61.0'"),
    ]);
  });
});

describe("contract exemptions", () => {
  test("docs-spine waives the glossary, the ADRs and CLAUDE.md", async () => {
    const stripped = without(
      without(without(CLEAN, "CONTEXT.md"), "CLAUDE.md"),
      "docs/adr/0000-template.md",
    );
    expect(await contract(stripped, { exemptions: ["docs-spine"] })).toEqual([]);
    expect(await contract(stripped)).toHaveLength(3);
  });

  test("config-lineage waives where the configs inherit from, not whether they exist", async () => {
    const own: Tree = {
      ...CLEAN,
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      ".oxlintrc.json": JSON.stringify({ extends: ["./oxlint.base.json"] }),
      "knip.ts": 'import { base } from "./knip.base.ts";\nexport default { ...base };\n',
    };
    expect(await contract(own)).toHaveLength(3);
    expect(await contract(own, { exemptions: ["config-lineage"] })).toEqual([]);
    expect(
      await contract(without(own, "tsconfig.json"), { exemptions: ["config-lineage"] }),
    ).toEqual([containing("tsconfig.json is missing")]);
  });

  test("ci-call waives the pinned call, and secrets the environment", async () => {
    const stripped = without(without(CLEAN, ".github/workflows/ci.yml"), ".env.example");
    const root = await materialise(stripped);
    expect(
      (await repoContract(root, { database: true, exemptions: ["ci-call", "secrets"] })).map(
        ({ message }) => message,
      ),
    ).toEqual([]);
    expect((await repoContract(root, DEFAULTS)).map(({ message }) => message)).toEqual([
      containing(".env.example must be tracked"),
      containing("no CI workflow"),
    ]);
  });

  test("an exemption nobody defined fails rather than waiving anything", async () => {
    expect(await contract(CLEAN, { exemptions: ["docs_spine"] })).toEqual([
      containing("'docs_spine' is not a contract fact"),
    ]);
  });
});
