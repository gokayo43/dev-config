import { describe, expect, test } from "bun:test";

import { databaseGatesOf, notDatabaseGates } from "../.github/actions/repo-contract/ci-workflow.ts";
import { repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import {
  CLEAN,
  contract,
  DEFAULTS,
  manifestWith,
  PIN,
  withSpec,
  withThreshold,
} from "./repo-contract-fixture.ts";
import { materialise, type Tree, without } from "./tree.ts";

// The word the caller's workflow writes, before any rule reads it. The action
// is called directly as well as through check.yml — this repo's own ci.yml does
// — so the vocabulary is graded here rather than only at the workflow's guard.
describe("the database gates a call asks for", () => {
  test.each(["postgres", "external", "none"])("%s is one of them", (value) => {
    expect(databaseGatesOf(value)).toBe(value);
  });

  // `none` is what switches every database rule off, so a value nobody defined
  // must not fall through to it: the wrong implementation is any "is it
  // postgres?" test, which reads every typo as "this repo has no database" and
  // sheds the backup script, the rehearsed restore and the upgrade gate in
  // silence. The refusal names the value back, because a typo is only findable
  // if the diagnostic quotes it.
  test.each(["true", "false", "Postgres", "mariadb", "", " none"])(
    "a value nobody defined (%j) is refused rather than read as none",
    (value) => {
      expect(databaseGatesOf(value)).toBeUndefined();
      expect(notDatabaseGates(value)).toContain(JSON.stringify(value));
    },
  );
});

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
        "bunfig.toml": "[install]\nminimumReleaseAge = 0\nexact = false\n",
      }),
    ).toEqual([
      containing("minimumReleaseAge"),
      containing("[install] exact must be true"),
      containing("coverageThreshold"),
    ]);
  });

  // The key bun reads is `exact`; `saveExact` is a name it ignores. Probed as a
  // matched pair on both ends of the range this fleet runs, HOME neutralised so
  // no user bunfig decides it: `bun add lodash` writes `4.18.1` under
  // `exact = true` on 1.3.11 and 1.4.0, and `^4.18.1` under `saveExact = true`
  // on both — which is what declaring neither does. So the wrong implementation
  // is the one this replaces: it passed the second tree, whose next `bun add`
  // writes a range straight past the release-age window above it.
  test.each([
    ["exact = true", "exact = true\n", []],
    ["saveExact = true", "saveExact = true\n", [containing("[install] exact must be true")]],
    [
      "both, with exact false",
      "saveExact = true\nexact = false\n",
      [containing("[install] exact must be true")],
    ],
    ["neither", "", [containing("[install] exact must be true")]],
  ])("a bunfig that pins with %s", async (_what, pinning, expected) => {
    expect(
      await contract({
        ...CLEAN,
        "bunfig.toml": `[install]\nminimumReleaseAge = 604800\n${pinning}\n[test]\ncoverageThreshold = { lines = 0.75, functions = 0.75 }\n`,
      }),
    ).toEqual([...expected]);
  });

  // A floor was checked for being declared, and `0` is declared. Bun enforces
  // nothing for a floor at or below zero, an empty table, or a key outside the
  // three it reads — it ignores each in silence (bun 1.4.0) — so the wrong
  // implementation here is the one that reads the field's presence instead of
  // what bun does with its value, and every case below passes it.
  test.each([
    ["0", "0"],
    ["a table of zeroes", "{ lines = 0, functions = 0 }"],
    ["an empty table", "{  }"],
    ["a floor bun does not read", "{ line = 0.9 }"],
  ])("a coverage floor that is %s is refused", async (_what, threshold) => {
    expect(await contract(withThreshold(threshold))).toEqual([
      containing("coverageThreshold must be a floor a run can fail"),
    ]);
  });

  test.each([
    ["a number above 0", "0.75"],
    ["a table of floors above 0", "{ lines = 0.75, statements = 0.9 }"],
  ])("a coverage floor that is %s passes", async (_what, threshold) => {
    expect(await contract(withThreshold(threshold))).toEqual([]);
  });

  // Collection belongs to the run CI makes — docs/gates/test-suite.md. Three
  // wrong implementations are graded here, one per row. Asking for the bunfig
  // line refuses row 1. Grading only `true` passes row 2, which is the worse
  // tree of the two: bun takes `coverage = false` over CI's --coverage
  // (probed, 1.4.0 and 1.3.11), so that repo declares a floor, satisfies this
  // gate, and is graded by nothing. Not grading the key at all passes row 3,
  // whose author's every scoped run is red instead.
  test.each([
    ["says nothing about collection", "", []],
    [
      "vetoes the collection CI asks for",
      "coverage = false\n",
      [containing("[test] coverage decides where the floor is applied")],
    ],
    [
      "collects, flooring every run its author makes",
      "coverage = true\n",
      [containing("[test] coverage decides where the floor is applied")],
    ],
  ])("a floored bunfig that %s", async (_what, line, expected) => {
    const bunfig = `[install]\nminimumReleaseAge = 604800\nexact = true\n\n[test]\n${line}coverageThreshold = { lines = 0.75, functions = 0.75 }\n`;
    expect(await contract({ ...CLEAN, "bunfig.toml": bunfig })).toEqual(expected);
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

  // Every value but `none` replays this repo's schema through that script —
  // check.yml's own job, or the wrapper workflow that took it over — so the
  // wrong implementation is the one that asks for the script only where the
  // Postgres job runs, and lets a wrapper's consumer drop the entry point the
  // wrapper replays through.
  test.each([
    ["postgres", [containing("db:migrate")]],
    ["external", [containing("db:migrate")]],
    ["none", []],
  ] as const)(
    "db:migrate is required of a repo whose caller runs database gates (%s)",
    async (database, expected) => {
      const tree = manifestWith((contents) => {
        delete contents.scripts?.["db:migrate"];
      });
      expect(await contract(tree, { database })).toEqual([...expected]);
    },
  );

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

// An `off` is the one override that argues nothing for itself: it says a rule
// the repo inherits does not apply here, and leaves the next reader no way to
// tell that from a rule switched off to get a run green. Tightening one or
// reconfiguring it argues in what it now demands, and is not gated.
describe("a base rule the repo turns off", () => {
  /** The clean tree with an oxlint config written out in full, comments and all. */
  function withConfig(body: string): Tree {
    return {
      ...CLEAN,
      ".oxlintrc.json": `{
  "extends": ["./node_modules/@gokayo43/dev-config/oxlint.base.json"],
${body}
}`,
    };
  }

  const NO_REASON = containing("no-console is turned off with no reason");

  const REASON = "// The gates read files nobody typechecks, and a console line is the report.";

  test("with nothing above it, it is refused", async () => {
    expect(await contract(withConfig(`  "rules": {\n    "no-console": "off"\n  }`))).toEqual([
      NO_REASON,
    ]);
  });

  // The wrong implementation reads "there is a line above it" rather than "that
  // line is a comment", and another rule's entry is the line it waves through.
  test("with another entry above it, it is refused", async () => {
    expect(
      await contract(
        withConfig(`  "rules": {\n    "no-debugger": "error",\n    "no-console": "off"\n  }`),
      ),
    ).toEqual([NO_REASON]);
  });

  // "Immediately above" is the whole convention: a reason a blank line away is
  // a reason for whatever used to be between them.
  test("with the reason a blank line away, it is refused", async () => {
    expect(
      await contract(withConfig(`  "rules": {\n    ${REASON}\n\n    "no-console": "off"\n  }`)),
    ).toEqual([NO_REASON]);
  });

  test("with the reason written immediately above it, it passes", async () => {
    expect(
      await contract(withConfig(`  "rules": {\n    ${REASON}\n    "no-console": "off"\n  }`)),
    ).toEqual([]);
  });

  // The reason is prose, and prose is written in either spelling of a comment.
  test("a block comment is a reason like any other", async () => {
    expect(
      await contract(
        withConfig(
          `  "rules": {\n    /* A console line is the gate's report. */\n    "no-console": "off"\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // The wrong implementation gates every override rather than the one that
  // argues nothing, and turns "this repo demands more than the base" into work.
  test("a rule tightened or reconfigured needs no reason", async () => {
    expect(
      await contract(
        withConfig(
          `  "rules": {\n    "no-console": "error",\n    "no-debugger": "warn",\n    "max-lines": ["error", { "max": 400 }]\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // oxlint takes a setting as a bare string or as the head of an array carrying
  // the rule's options; the wrong implementation reads only the first.
  test("the array spelling of off is the same off", async () => {
    const entry = `"no-console": ["off", { "allow": ["error"] }]`;
    expect(await contract(withConfig(`  "rules": {\n    ${entry}\n  }`))).toEqual([NO_REASON]);
    expect(await contract(withConfig(`  "rules": {\n    ${REASON}\n    ${entry}\n  }`))).toEqual(
      [],
    );
  });

  // `AllowWarnDeny` documents `"allow"` as the synonym of `"off"` and `0` as
  // the number that means it, and oxlint honours all three (probed against
  // 1.78). A check that knew only the word `off` would pass a rule switched off
  // in either of the other two spellings, in silence, which is the whole
  // failure this gate exists to stop.
  test.each([
    ['"allow"', `"no-console": "allow"`],
    ["0", `"no-console": 0`],
    ['["allow", …]', `"no-console": ["allow", { "allow": ["error"] }]`],
    ["[0]", `"no-console": [0]`],
  ])("the %s spelling of off is the same off", async (_what, entry) => {
    expect(await contract(withConfig(`  "rules": {\n    ${entry}\n  }`))).toEqual([NO_REASON]);
    expect(await contract(withConfig(`  "rules": {\n    ${REASON}\n    ${entry}\n  }`))).toEqual(
      [],
    );
  });

  // The on-spellings, including the two numbers, so the gate cannot pass by
  // demanding a reason for every entry it meets.
  test("a rule left on in any spelling needs no reason", async () => {
    expect(
      await contract(
        withConfig(
          `  "rules": {\n    "no-console": "deny",\n    "no-debugger": 2,\n    "no-empty": 1\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // A category switched off takes every rule in it with it, which is a bigger
  // silence than any single entry and was the one this gate first missed.
  test("a category switched off carries a reason too", async () => {
    expect(await contract(withConfig(`  "categories": {\n    "correctness": "off"\n  }`))).toEqual([
      containing("correctness is turned off with no reason"),
    ]);
    expect(
      await contract(
        withConfig(
          `  "categories": {\n    // Every rule in it is stated by name below.\n    "correctness": "allow"\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // `GlobalValue` is its own vocabulary and `"off"` is one of its words, so a
  // check that searched the file for the word rather than walking to the block
  // would demand a reason for declaring a global. The same for the options
  // object hanging off a rule that IS on.
  test("an off that is not a rule being switched off is left alone", async () => {
    expect(
      await contract(
        withConfig(
          `  "globals": {\n    "structuredClone": "off"\n  },\n  "rules": {\n    "no-restricted-syntax": ["error", { "selector": "x", "message": "off" }]\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // An override block is where a rule is most often switched off — for one
  // directory, or one file kind — so a check that read only the top level would
  // grade every place but the one an off is usually written.
  test("an off inside an override block is read too", async () => {
    const block = (reason: string): string =>
      `  "overrides": [\n    {\n      "files": ["scripts/**"],\n      "rules": {\n${reason}        "no-console": "off"\n      }\n    }\n  ]`;
    expect(await contract(withConfig(block("")))).toEqual([NO_REASON]);
    expect(
      await contract(withConfig(block(`        // A script's output is its interface.\n`))),
    ).toEqual([]);
  });
  // A `\"` inside a string ends nothing. A walk that read it as the closing
  // quote reads the rest of the file shifted by one string — every path wrong
  // and every switch-off after it missed, silently.
  test("an escaped quote inside a string does not end it", async () => {
    const quoted = String.raw`"no-restricted-syntax": ["error", { "message": "say \"}\" here" }]`;
    expect(
      await contract(withConfig(`  "rules": {\n    ${quoted},\n    "no-console": "off"\n  }`)),
    ).toEqual([NO_REASON]);
  });

  // A gate that names the file and not the line makes the reader search a
  // config that may hold a hundred rules; `report` writes `line=` beside
  // `file=` so the annotation lands on the entry itself.
  test("the finding names the line the entry sits on", async () => {
    const root = await materialise(
      withConfig(`  "rules": {\n    "no-debugger": "error",\n    "no-console": "off"\n  }`),
      [".env.example"],
    );
    expect(
      (await repoContract(root, DEFAULTS))
        .filter(({ message }) => message.includes("turned off"))
        .map(({ file, line }) => `${file ?? ""}:${line ?? 0}`),
    ).toEqual([".oxlintrc.json:5"]);
  });
  // A reason is owed per switch-off, not per line: a comment above two entries
  // says nothing about which of them it excuses, and no reader can recover the
  // difference. So a switch-off sharing its line with any other entry is
  // refused outright, which is the state that makes the ambiguity
  // unrepresentable rather than merely discouraged.
  test("a second entry on the line takes the reason's meaning with it", async () => {
    expect(
      await contract(
        withConfig(
          `  "rules": {\n    ${REASON}\n    "no-console": "off", "no-debugger": "off"\n  }`,
        ),
      ),
    ).toEqual([
      containing("no-console shares its line with another entry"),
      containing("no-debugger shares its line with another entry"),
    ]);
  });

  // The boundary of the rule above, stated as its own case: what makes a line
  // ambiguous is a second thing a reason could be about, and the `"rules"` key
  // itself is not one. A lone switch-off written inline is unambiguous, and
  // refusing it would be a formatting mandate rather than this rule.
  test("a lone switch-off written inline is unambiguous and passes", async () => {
    expect(await contract(withConfig(`  ${REASON}\n  "rules": { "no-console": "off" }`))).toEqual(
      [],
    );
  });

  // The predicate this replaces was a filter over the line, so one comment
  // excused however many switch-offs were written under it.
  test("ten switch-offs behind one comment are ten findings", async () => {
    const entries = Array.from({ length: 10 }, (_, at) => `"unicorn/r${at}": "off"`).join(", ");
    expect(
      await contract(withConfig(`  "rules": {\n    ${REASON}\n    ${entries}\n  }`)),
    ).toHaveLength(10);
  });

  // One argument routinely retires several rules at once, and the fleet's own
  // configs are written that way: this block is `nfp-elysia`'s, four categories
  // under one paragraph. The implementation this replaces credited the first
  // entry of the group and refused the other three — eight findings across that
  // one file — which asks for the same paragraph copied under each key.
  test("a reason above a group of entries covers the group", async () => {
    const group = `  "categories": {
    // The pedantic & style opinion sets are deliberately NOT adopted: run at
    // "warn" they emit ~31k diagnostics from rules that contradict established
    // house conventions. That is noise, not signal.
    "pedantic": "off",
    "style": "off",
    "restriction": "off",
    "nursery": "off"
  }`;
    expect(await contract(withConfig(group))).toEqual([]);
  });

  // The group's other end. A blank line is what closes it — a reason on the far
  // side of one is a reason for whatever used to be between them, which is the
  // rule the single-entry case already states, and a walk that stepped over
  // entries without stopping at blank lines would spend one comment on a whole
  // block.
  test("a blank line closes the group the reason covers", async () => {
    const split = `  "rules": {\n    ${REASON}\n    "no-debugger": "off",\n\n    "no-console": "off"\n  }`;
    expect(await contract(withConfig(split))).toEqual([NO_REASON]);
  });

  // And what continues the group is a switch-off, never an entry: a rule left
  // ON is a different subject, so the comment above THAT is about it staying
  // on. `oxlint.base.json` is the tree this was found on — a `"warn"` sits
  // between the JSX runtime's reason and `oxc/no-map-spread` — and a walk that
  // stepped over entries handed the first argument to the second, silently.
  test("a rule left on closes the group the reason covers", async () => {
    const between = `  "rules": {\n    ${REASON}\n    "no-debugger": "off",\n    "no-empty": "warn",\n    "no-console": "off"\n  }`;
    expect(await contract(withConfig(between))).toEqual([NO_REASON]);
  });

  // And the block's own opening line is not an entry, so a comment above it is
  // about the block: spending it on the switch-offs inside would be this gate
  // accepting "here are the rules" as an argument for turning one off.
  test("a reason above the block itself covers nothing inside it", async () => {
    expect(
      await contract(withConfig(`  ${REASON}\n  "rules": {\n    "no-console": "off"\n  }`)),
    ).toEqual([NO_REASON]);
  });

  // A comment that says nothing is the empty waiver `allowlistFrom` already
  // refuses; a gate that took the comment's existence for a reason asks for a
  // token, not an argument.
  test.each(["//", "//   ", "/**/", "/*   */", "/* */", "//\n    //"])(
    "an empty comment (%j) is not a reason",
    async (empty) => {
      expect(
        await contract(withConfig(`  "rules": {\n    ${empty}\n    "no-console": "off"\n  }`)),
      ).toEqual([NO_REASON]);
    },
  );

  // A block comment carried over several lines is one reason, and the line
  // directly above the entry is its last — which on its own says nothing.
  test("a reason spread over several comment lines is still a reason", async () => {
    expect(
      await contract(
        withConfig(
          `  "rules": {\n    /*\n     * The gates read files nobody typechecks.\n     */\n    "no-console": "off"\n  }`,
        ),
      ),
    ).toEqual([]);
  });

  // oxlint decodes the config before it reads a setting out of it, so a gate
  // comparing raw bytes disagrees with the linter about the same file.
  test("an escaped spelling of off is the same off", async () => {
    const escaped = String.raw`"no-console": "\u006ff\u0066"`;
    expect(await contract(withConfig(`  "rules": {\n    ${escaped}\n  }`))).toEqual([NO_REASON]);
    expect(await contract(withConfig(`  "rules": {\n    ${REASON}\n    ${escaped}\n  }`))).toEqual(
      [],
    );
  });

  // `typeAware: false` takes every type-aware rule in the base with it — twelve
  // at `error` — and `bun run lint` passes no flag that puts them back.
  test("type-aware linting left on needs no reason", async () => {
    expect(
      await contract(withConfig(`  "options": { "typeAware": true },\n  "rules": {}`)),
    ).toEqual([]);
  });

  test("turning type-aware linting off carries a reason like any switch-off", async () => {
    const off = `  "options": {\n    "typeAware": false\n  },\n  "rules": {}`;
    expect(await contract(withConfig(off))).toEqual([
      containing("typeAware is turned off with no reason"),
    ]);
    expect(
      await contract(
        withConfig(
          `  "options": {\n    // tsgolint is not installable on this runner yet.\n    "typeAware": false\n  },\n  "rules": {}`,
        ),
      ),
    ).toEqual([]);
  });
});

// A rule switched off in a file this gate never opens is switched off just the
// same. Both of these replace what the root config says rather than adding to
// it, and neither leaves the root config a reader could get the answer from.
describe("a second place lint config can come from", () => {
  test("a second extends target is refused", async () => {
    expect(
      await contract({
        ...CLEAN,
        ".oxlintrc.json": JSON.stringify({
          extends: ["./node_modules/@gokayo43/dev-config/oxlint.base.json", "./lint-relax.json"],
        }),
        "lint-relax.json": JSON.stringify({ rules: { "no-console": "off" } }),
      }),
    ).toEqual([containing("extends must name the shared base and nothing else")]);
  });

  // `config-lineage` waives WHERE a config inherits from. How many places it
  // inherits from is a different fact, and the exemption does not reach it.
  test("config-lineage does not waive the second target", async () => {
    const own = {
      ...CLEAN,
      ".oxlintrc.json": JSON.stringify({ extends: ["./oxlint.base.json", "./lint-relax.json"] }),
      "lint-relax.json": JSON.stringify({ rules: {} }),
    };
    expect(await contract(own, { exemptions: ["config-lineage"] })).toEqual([
      containing("extends must name the shared base and nothing else"),
    ]);
  });

  test.each([
    ["src/.oxlintrc.json", '{ "rules": {} }'],
    ["apps/web/.oxlintrc.jsonc", '{ "rules": {} }'],
    ["packages/ui/oxlint.config.ts", "export default {};\n"],
    // A scaffold's source reads like the one honest exception — this is the
    // file `project-template` copies into a new repo, where it becomes that
    // repo's root config — and is refused anyway, because no run ever grades
    // that tree: the template's CI points this gate at the scaffold its setup
    // produced, where `setup/` is gone.
    ["setup/monorepo/root/.oxlintrc.json", '{ "rules": {} }'],
  ])("a config at %s is refused", async (path, body) => {
    expect(await contract({ ...CLEAN, [path]: body })).toEqual([
      containing("replaces the root's rules for its subtree"),
    ]);
  });

  test("the root's own config is not mistaken for a nested one", async () => {
    expect(await contract(CLEAN)).toEqual([]);
  });
});
