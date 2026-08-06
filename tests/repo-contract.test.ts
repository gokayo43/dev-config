import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { type Contract, repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { materialise, type Tree, without } from "./tree.ts";
import { containing } from "./matchers.ts";

const PIN = "f1a8afef270d30bf25f2f30275ecf988123d9fb3";

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

  // JSON.parse answers null, a number or an array as readily as an object, and
  // every check here goes straight to a field of one.
  test.each(["null", "42", "[]", '"a string"'])(
    "a root manifest that is JSON but not an object (%s) is refused, not crashed on",
    async (text) => {
      expect(await contract({ ...CLEAN, "package.json": text })).toEqual([
        containing("is not a JSON object"),
      ]);
    },
  );

  test("a config that is JSON but not an object says so, rather than failing to extend", async () => {
    expect(await contract({ ...CLEAN, "tsconfig.json": "null" })).toEqual([
      containing("is not a JSON object"),
    ]);
  });

  // The file is there, so "missing" is the wrong diagnostic and the crash it
  // used to be was no diagnostic at all.
  test("a config that will not parse is named", async () => {
    const problems = await contract({ ...CLEAN, ".oxlintrc.json": "{ oops" });
    expect(problems).toEqual([containing("is not valid JSON")]);
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

const BACKUP = "scripts/backup.sh";
const RESTORE_DRILL = "scripts/restore-drill.sh";

/** Everything `lifecycle: "live"` derives, all of it satisfied. */
const LIVE: Tree = {
  ...manifestWith((contents) => {
    contents["lifecycle"] = "live";
    contents["dependencies"] = { "@sentry/bun": "10.24.0" };
  }),
  [BACKUP]: "#!/usr/bin/env bash\n",
  [RESTORE_DRILL]: "#!/usr/bin/env bash\n",
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n    with:\n      database: true\n      upgrade-gate: true\n`,
};

/**
 * The same materialisation, with the two scripts marked executable — the state
 * git records and a systemd unit needs. Bun.write leaves a new file at the
 * umask's 0644, which is exactly the tree the not-executable case wants.
 */
async function live(
  tree: Tree,
  { executable = [BACKUP, RESTORE_DRILL], ...overrides }: LiveOptions = {},
): Promise<string[]> {
  const root = await materialise(tree, [".env.example"]);
  await Promise.all(
    executable.filter((path) => path in tree).map((path) => chmod(join(root, path), 0o755)),
  );
  return (await repoContract(root, { ...DEFAULTS, ...overrides })).map(({ message }) => message);
}

interface LiveOptions extends Partial<Contract> {
  readonly executable?: readonly string[];
}

/** A live repo with no database of its own: a marketing site, and half the fleet. */
const LIVE_STATIC: Tree = {
  ...without(
    without(
      manifestWith((contents) => {
        contents["lifecycle"] = "live";
        contents["dependencies"] = { "@sentry/astro": "10.24.0" };
        delete (contents["scripts"] as Record<string, string>)["db:migrate"];
      }),
      BACKUP,
    ),
    RESTORE_DRILL,
  ),
  ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n`,
};

// The field is the switch, so a repo that has not thrown it is graded against
// neither set of rules — the gate says only that nobody has said which repo
// this is.
describe("the lifecycle field", () => {
  test("a repo that does not declare one is refused", async () => {
    expect(await contract(manifestWith((contents) => delete contents["lifecycle"]))).toEqual([
      containing("lifecycle is absent"),
    ]);
  });

  test.each(["prod", "", "production", "Live", "true"])(
    "a lifecycle nobody defined (%s) is refused rather than read as either",
    async (value) => {
      expect(await contract(manifestWith((contents) => (contents["lifecycle"] = value)))).toEqual([
        containing(`lifecycle reads ${JSON.stringify(value)}`),
      ]);
    },
  );

  // Each row is the argument list, so the array case is a row of one array —
  // written flat it would be spread into the string "live" and test the opposite.
  test.each([[true], [1], [null], [["live"]]])(
    "a lifecycle that is not even a string (%p) is refused, not crashed on",
    async (value: unknown) => {
      expect(await contract(manifestWith((contents) => (contents["lifecycle"] = value)))).toEqual([
        containing('it says "dev" or "live"'),
      ]);
    },
  );

  test("a dev repo owes none of what going live requires", async () => {
    // The clean tree has no backup script, no restore drill, no Sentry and no
    // upgrade gate, and that is a complete repo until the day it is deployed.
    expect(await contract(CLEAN)).toEqual([]);
  });

  test("a live repo that has all of it passes", async () => {
    expect(await live(LIVE)).toEqual([]);
  });
});

describe("what going live requires", () => {
  test("CI has to ask check.yml for the upgrade gate", async () => {
    expect(
      await live({ ...LIVE, ".github/workflows/ci.yml": CLEAN[".github/workflows/ci.yml"] ?? "" }),
    ).toEqual([containing("must pass `upgrade-gate: true`")]);
  });

  // GitHub casts it to the boolean the input declares, so the repo asking this
  // way is a repo running the gate.
  test("the quoted spelling asks for it too", async () => {
    const quoted = (LIVE[".github/workflows/ci.yml"] ?? "").replace(
      "upgrade-gate: true",
      'upgrade-gate: "true"',
    );
    expect(await live({ ...LIVE, ".github/workflows/ci.yml": quoted })).toEqual([]);
  });

  test("an upgrade-gate on a job that calls something else is not the call's", async () => {
    const elsewhere = `${LIVE[".github/workflows/ci.yml"] ?? ""}  other:\n    uses: someone/else/.github/workflows/check.yml@${PIN}\n    with:\n      upgrade-gate: true\n`;
    const off = elsewhere.replace(
      "      database: true\n      upgrade-gate: true\n",
      "      database: true\n",
    );
    expect(await live({ ...LIVE, ".github/workflows/ci.yml": off })).toEqual([
      containing("must pass `upgrade-gate: true`"),
    ]);
  });

  test.each([
    [BACKUP, "a live repo owns scripts/backup.sh"],
    [RESTORE_DRILL, "a live repo owns scripts/restore-drill.sh"],
  ])("%s has to exist", async (path, message) => {
    expect(await live(without(LIVE, path))).toEqual([containing(message)]);
  });

  // A script systemd execs directly, committed without its bit, fails at 3am
  // and not before.
  test.each([BACKUP, RESTORE_DRILL])("%s has to be executable", async (path) => {
    const executable = [BACKUP, RESTORE_DRILL].filter((each) => each !== path);
    expect(await live(LIVE, { executable })).toEqual([containing(`${path} is not executable`)]);
  });

  test("something in the repo has to report its crashes", async () => {
    const blind = manifestWith((contents) => {
      contents["lifecycle"] = "live";
    });
    expect(await live({ ...LIVE, "package.json": blind["package.json"] ?? "" })).toEqual([
      containing("a live repo reports its crashes"),
    ]);
  });

  // Sentry ships one SDK per runtime and the fact asserted is that something
  // reports its crashes — so a list of the ones we use today would fail the
  // first repo on a runtime nobody had thought of.
  test.each([
    "@sentry/bun",
    "@sentry/tanstackstart-react",
    "@sentry/react-native",
    "@sentry/astro",
  ])("%s satisfies it, from anywhere in the workspace", async (name) => {
    const blind = manifestWith((contents) => {
      contents["lifecycle"] = "live";
    });
    expect(
      await live({
        ...LIVE,
        "package.json": blind["package.json"] ?? "",
        "apps/api/package.json": JSON.stringify({ dependencies: { [name]: "10.24.0" } }),
      }),
    ).toEqual([]);
  });

  // Declaring is not shipping. A devDependency builds and tests the repo and
  // reaches no deployment, and a peer range states what a consumer may bring —
  // so an SDK in either is a repo whose crashes nobody hears.
  test.each(["devDependencies", "peerDependencies"])(
    "a Sentry SDK in %s alone is not crash reporting",
    async (field) => {
      const declared = manifestWith((contents) => {
        contents["lifecycle"] = "live";
        const existing = contents[field];
        contents[field] = {
          ...(typeof existing === "object" && existing !== null ? existing : {}),
          "@sentry/bun": "10.24.0",
        };
      });
      expect(await live({ ...LIVE, "package.json": declared["package.json"] ?? "" })).toEqual([
        containing("a live repo reports its crashes"),
      ]);
    },
  );
});

// The rules are scoped to what the repo is. Half this fleet is a static site
// with a hostname and no database, and a gate that demanded a backup script of
// one would be teaching people to write a script that does nothing.
describe("a live repo with no database of its own", () => {
  test("owes crash reporting, and no database rituals", async () => {
    expect(await live(LIVE_STATIC, { database: false })).toEqual([]);
  });

  test("still owes the crash reporting", async () => {
    const blind = manifestWith((contents) => {
      contents["lifecycle"] = "live";
      delete (contents["scripts"] as Record<string, string>)["db:migrate"];
    });
    expect(
      await live(
        { ...LIVE_STATIC, "package.json": blind["package.json"] ?? "" },
        { database: false },
      ),
    ).toEqual([containing("a live repo reports its crashes")]);
  });

  // Owning a schema is read from the repo, so turning the CI job on does not
  // conjure one: the caller is told its input has no migration entry point
  // behind it, and the database rules stay off because there is still no
  // database.
  test("running the database job over a repo with no migrations is the caller's problem", async () => {
    expect(await live(LIVE_STATIC, { database: true })).toEqual([containing("db:migrate")]);
  });
});

// A monorepo keeps its migrations in the workspace that owns the schema, and
// the root's `db:migrate` is a passthrough to it. Asking only the root means
// two edits shed every database rule — drop the input, then delete a
// passthrough that now looks like dead weight — and the second one reads as a
// tidy-up.
describe("a live monorepo owns its database wherever the migrations live", () => {
  const inTheWorkspace: Tree = {
    ...without(
      without(
        manifestWith((contents) => {
          contents["lifecycle"] = "live";
          contents["dependencies"] = { "@sentry/bun": "10.24.0" };
          delete (contents["scripts"] as Record<string, string>)["db:migrate"];
        }),
        BACKUP,
      ),
      RESTORE_DRILL,
    ),
    "apps/api/package.json": JSON.stringify({
      name: "shop-api",
      scripts: { "db:migrate": "bun run src/db/migrate.ts" },
    }),
    ".github/workflows/ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  check:\n    uses: gokayo43/dev-config/.github/workflows/check.yml@${PIN} # v0.6.0\n`,
  };

  test("so every rule holds, with the root carrying no script at all", async () => {
    expect(await live(inTheWorkspace, { database: false })).toEqual([
      containing("must pass `database: true`"),
      containing("must pass `upgrade-gate: true`"),
      containing("a live repo owns scripts/backup.sh"),
      containing("a live repo owns scripts/restore-drill.sh"),
    ]);
  });
});

// The `database` input says which CI job runs, and it lives in the very file
// these rules are about. Keying off it would let a live repo drop its backup
// script, its rehearsed restore and its upgrade gate by deleting one line of
// its own workflow — so the contract asks the repo instead.
describe("a live repo cannot shed the database rules by editing its workflow", () => {
  test("owning migrations and running no database job is its own problem", async () => {
    expect(await live(LIVE, { database: false })).toEqual([
      containing("must pass `database: true`"),
    ]);
  });

  test("and every rule it would have shed still holds", async () => {
    expect(await live(without(LIVE, BACKUP), { database: false })).toEqual([
      containing("must pass `database: true`"),
      containing("a live repo owns scripts/backup.sh"),
    ]);
  });
});

// The exemption says CI is not a call into check.yml. There is then no call to
// pass `upgrade-gate: true` to, and the docs say so — this is that sentence,
// executed.
describe("ci-call waives the upgrade-gate rule with the call it is about", () => {
  test("a live repo whose CI is its own is not asked about a call it does not make", async () => {
    const own = {
      ...LIVE,
      ".github/workflows/ci.yml":
        "name: CI\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo green\n",
    };
    expect(await live(own, { exemptions: ["ci-call"] })).toEqual([]);
    expect(await live(own)).toEqual([containing("check.yml")]);
  });
});
