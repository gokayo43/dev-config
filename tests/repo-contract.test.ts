import { describe, expect, test } from "bun:test";

import { repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import { CLEAN, contract, DEFAULTS, manifestWith, PIN, withSpec } from "./repo-contract-fixture.ts";
import { materialise, type Tree, without } from "./tree.ts";

describe("repo contract", () => {
  test("a repo that declares everything passes", async () => {
    expect(await contract(CLEAN)).toEqual([]);
  });

  test("the package manager has to be bun, pinned", async () => {
    const missing = await contract(manifestWith((contents) => delete contents.packageManager));
    expect(missing).toEqual([containing("packageManager")]);
    const wrong = await contract(manifestWith((contents) => (contents.packageManager = "pnpm@10")));
    expect(wrong).toEqual([containing("packageManager")]);
  });

  test("another package manager's lockfile is refused", async () => {
    expect(await contract({ ...CLEAN, "pnpm-lock.yaml": "lockfileVersion: 9\n" })).toEqual([
      containing("bun.lock is the only lockfile"),
    ]);
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
          delete contents.devDependencies["oxlint-tsgolint"];
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
    [".github/workflows/ci.yml", "no CI workflow"],
  ])("a repo with no %s is refused", async (path, message) => {
    expect(await contract(without(CLEAN, path))).toEqual([containing(message)]);
  });

  // CLEAN carries no docs/adr, so the first case above already says a tree
  // without one passes. This is the other half: the directory is no longer part
  // of the spine, and it is not a violation either while the fleet still holds
  // ADRs the per-repo folds under #26 have yet to take out.
  test("a decision-log directory is neither required nor refused", async () => {
    expect(await contract({ ...CLEAN, "docs/adr/0001-something.md": "# 1. Something\n" })).toEqual(
      [],
    );
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

  // `Bun.TOML.parse` throws, so a bunfig nobody can read used to leave the step
  // with a parse error naming no file, and took the findings every other check
  // had already produced with it. The wrong implementation is the one that
  // parses this file outside the rescue the other configs are read through.
  test("a bunfig nothing can parse is named, not thrown past", async () => {
    const problems = await contract({ ...CLEAN, "bunfig.toml": "not toml at all\n" });
    expect(problems).toEqual([containing("is not valid TOML")]);
  });

  // The same as the bunfig above, for the two YAML files this gate reads. A
  // parse that throws leaves the step with an error naming no file and takes
  // every finding the other checks had already produced with it.
  test.each([
    ["lefthook.yml", "lefthook.yml"],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
  ])("a %s nothing can parse is named, not thrown past", async (_name, file) => {
    const problems = await contract({ ...CLEAN, [file]: "key: [unclosed\n" });
    expect(problems).toEqual([containing("is not valid YAML")]);
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
      delete contents.scripts?.["db:migrate"];
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

  // JSON.parse answers null, a number or an array as readily as an object, and
  // every check here goes straight to a field of one.
  test.each(["null", "42", "[]", '"a string"'])(
    "a root manifest that is JSON but not an object (%s) is refused, not crashed on",
    async (text) => {
      expect(await contract({ ...CLEAN, "package.json": text })).toEqual([
        containing("is not an object — the top level of this JSON file is"),
      ]);
    },
  );

  // A config read by name, which this gate takes in the dialect that invites a
  // comment beside an entry — so the diagnostic names that dialect, not JSON.
  test("a config that is JSON but not an object says so, rather than failing to extend", async () => {
    expect(await contract({ ...CLEAN, "tsconfig.json": "null" })).toEqual([
      containing("the top level of this JSON with comments file is null"),
    ]);
  });

  // The file is there, so "missing" is the wrong diagnostic and the crash it
  // used to be was no diagnostic at all.
  test("a config that will not parse is named", async () => {
    const problems = await contract({ ...CLEAN, ".oxlintrc.json": "{ oops" });
    expect(problems).toEqual([containing("is not valid JSON")]);
  });

  // Both configs read here are JSON with comments by their own specification —
  // oxlint's schema sets `allowComments`, TypeScript has always allowed them —
  // and the README tells a repo to write the reason for an override beside it.
  // A gate that refused the reason it asked for is the shape this pins.
  test("a reason written beside a config entry is not a parse failure", async () => {
    const commented = `{
  // The base, and the one rule this repo has a reason to differ on.
  "extends": ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
  "rules": {
    /* Reads a URL out of a fixture, so a bare "//" is data here. */
    "no-console": "off",
  },
}`;
    expect(await contract({ ...CLEAN, ".oxlintrc.json": commented })).toEqual([]);
    expect(
      await contract({
        ...CLEAN,
        "tsconfig.json":
          '{\n  // inherited\n  "extends": "@gokayo43/dev-config/tsconfig.base.json"\n}',
      }),
    ).toEqual([]);
  });

  // The `$schema` line of every config here holds `https://` — a stripper that
  // reads `//` inside a string as a comment eats the rest of that line and the
  // file stops parsing, which is a worse failure than the one being fixed.
  test("a comment marker inside a string is data", async () => {
    const withUrl = `{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "extends": ["./node_modules/@gokayo43/dev-config/oxlint.base.json"]
}`;
    expect(await contract({ ...CLEAN, ".oxlintrc.json": withUrl })).toEqual([]);
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
  test("docs-spine waives the glossary and CLAUDE.md", async () => {
    const stripped = without(without(CLEAN, "CONTEXT.md"), "CLAUDE.md");
    expect(await contract(stripped, { exemptions: ["docs-spine"] })).toEqual([]);
    expect(await contract(stripped)).toHaveLength(2);
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
      (await repoContract(root, { ...DEFAULTS, exemptions: ["ci-call", "secrets"] })).map(
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
