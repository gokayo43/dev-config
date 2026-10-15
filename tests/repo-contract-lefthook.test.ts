import { describe, expect, test } from "bun:test";

import { containing } from "./matchers.ts";
import { CLEAN, contract } from "./repo-contract-fixture.ts";

/** CLEAN's hooks with more config after them. */
function withHooks(more: string): string {
  return `${CLEAN["lefthook.yml"]}\n${more}`;
}

describe("the git hooks a repo declares", () => {
  // lefthook 2.x leads with `jobs:`, a list whose entries may be a `group:`
  // holding another list, and a gate that knew only `commands:` passed a
  // config declaring every hook it asks for while reading none of them.
  test("the jobs form is read, groups and all, which kills a gate reading only the commands map", async () => {
    const jobs =
      "pre-commit:\n  jobs:\n    - name: staged\n      group:\n        jobs:\n          - run: gitleaks git --staged --redact --no-banner .\n";
    expect(await contract({ ...CLEAN, "lefthook.yml": jobs })).toEqual([]);
  });

  test("a jobs-form pre-commit that runs the wrong thing is refused, which kills a gate that reads a declared hook as a satisfied one", async () => {
    const wrong = "pre-commit:\n  jobs:\n    - run: echo hi\n";
    expect(await contract({ ...CLEAN, "lefthook.yml": wrong })).toEqual([
      containing("gitleaks git --staged"),
    ]);
  });

  test("the commit hook has to scan the index, and no push hook is asked for, which kills a gate still requiring one", async () => {
    expect(
      await contract({
        ...CLEAN,
        "lefthook.yml": "pre-commit:\n  commands:\n    secrets:\n      run: gitleaks git .\n",
      }),
    ).toEqual([containing("gitleaks git --staged")]);
  });

  // The suite is CI's, on the pull request, so a push hook that runs anything
  // is refused once, in either config shape. lefthook runs a file as well as a
  // command (a `script:` job, or a key of the hook's `scripts:` map), and a
  // hook's `setup:` commands before either.
  test.each([
    [
      "typechecks and tests in the commands form",
      "keeping the retired requirement",
      "pre-push:\n  commands:\n    typecheck:\n      run: bun run typecheck\n    test:\n      run: bun test\n",
    ],
    [
      "typechecks and tests in the jobs form",
      "keeping the retired requirement",
      "pre-push:\n  jobs:\n    - run: bun run typecheck\n    - run: bun test\n",
    ],
    [
      "runs a job nested in a group",
      "a refusal reading only top-level runs",
      "pre-push:\n  jobs:\n    - group:\n        jobs:\n          - run: bun test\n",
    ],
    [
      "runs a file through a script: job",
      "a refusal reading run: alone",
      'pre-push:\n  jobs:\n    - script: "suite.sh"\n      runner: bash\n',
    ],
    [
      "runs a file through a scripts: map",
      "a refusal reading run: alone",
      'pre-push:\n  scripts:\n    "suite.sh":\n      runner: bash\n',
    ],
    [
      "runs a setup: command",
      "a walk reading jobs and scripts alone",
      "pre-push:\n  setup:\n    - run: bun test\n",
    ],
  ])("a pre-push hook that %s is refused once, which kills %s", async (_what, _kills, prePush) => {
    expect(await contract({ ...CLEAN, "lefthook.yml": withHooks(prePush) })).toEqual([
      containing("pre-push runs nothing"),
    ]);
  });

  // A key with nothing under it runs nothing, so it is not what the rule
  // refuses. The wrong implementation refuses the key's presence.
  test.each([
    ["no hook list at all", "pre-push:\n"],
    ["an empty jobs list", "pre-push:\n  jobs: []\n"],
    ["an empty commands map", "pre-push:\n  commands: {}\n"],
  ])(
    "a pre-push key with %s passes, which kills a refusal of the key's presence",
    async (_shape, prePush) => {
      expect(await contract({ ...CLEAN, "lefthook.yml": withHooks(prePush) })).toEqual([]);
    },
  );

  // lefthook merges more config into lefthook.yml than lefthook.yml holds, and
  // this gate reads lefthook.yml alone, so a hook moved one file over would pass
  // it. The wrong implementation reads lefthook.yml and trusts it is the whole.
  test.each([
    ["an extends: key", "extends:\n  - hooks/push.yml\n"],
    ["a remotes: key", "remotes:\n  - git_url: https://example.com/hooks.git\n"],
  ])(
    "lefthook.yml with %s is refused, which kills reading lefthook.yml as the whole config",
    async (_key, more) => {
      expect(await contract({ ...CLEAN, "lefthook.yml": withHooks(more) })).toEqual([
        containing("reads lefthook.yml alone"),
      ]);
    },
  );

  test.each(["lefthook-local.yml", ".lefthook-local.yaml", ".config/lefthook-local.toml"])(
    "a %s in the repo is refused, which kills reading lefthook.yml as the whole config",
    async (path) => {
      const local = {
        ...CLEAN,
        [path]: "pre-push:\n  commands:\n    test:\n      run: bun test\n",
      };
      expect(await contract(local)).toEqual([containing("reads lefthook.yml alone")]);
    },
  );

  // lefthook's local config is a developer's own, and .gitignore keeps it out
  // of the repo. The wrong implementation refuses the file for being on disk.
  test("a gitignored lefthook-local.yml passes, which kills a refusal of the file being on disk", async () => {
    const ignored = {
      ...CLEAN,
      ".gitignore": `${CLEAN[".gitignore"]}lefthook-local.yml\n`,
      "lefthook-local.yml": "pre-push:\n  commands:\n    test:\n      run: bun test\n",
    };
    expect(await contract(ignored)).toEqual([]);
  });
});
