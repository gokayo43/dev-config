import { describe, expect, test } from "bun:test";

import { containing } from "./matchers.ts";
import { contract, manifestWith } from "./repo-contract-fixture.ts";
import type { Tree } from "./tree.ts";

/**
 * What CI type-checks with: the script check.yml's typecheck lane runs, and the
 * Bun `packageManager` names, which is the one setup-bun installs and the only
 * place `bun check` can come from. Its own file because the two are one fact
 * seen from both ends — a script naming a command, and the runtime that has it.
 */
describe("the Bun packageManager names", () => {
  const naming = (packageManager: string): Tree =>
    manifestWith((contents) => {
      contents.packageManager = packageManager;
    });

  test("has to be bun, named", async () => {
    const missing = await contract(manifestWith((contents) => delete contents.packageManager));
    expect(missing).toEqual([containing("packageManager")]);
    expect(await contract(naming("pnpm@10"))).toEqual([containing("packageManager")]);
  });

  // `bun check` arrived in 1.4.3. The likeliest wrong floors read the major
  // alone, which passes 1.4.2; compare the strings, which puts 1.10.0 below
  // 1.4.3; or read the minor alone, which puts 2.0.0 below it.
  test("is refused below 1.4.3, since bun check does not exist there", async () => {
    expect(await contract(naming("bun@1.4.2"))).toEqual([
      containing("packageManager names bun@1.4.2 — name bun@1.4.3 or later"),
    ]);
  });

  test.each(["bun@1.4.3", "bun@1.10.0", "bun@2.0.0"])("passes at %s", async (packageManager) => {
    expect(await contract(naming(packageManager))).toEqual([]);
  });

  // A tag or a partial version names no one Bun, so it is no Bun to hold to a
  // floor either: comparing `1.5` as a range answers that it is below 1.4.3,
  // which is a diagnostic about the wrong fault.
  test.each(["bun@latest", "bun@1.5"])(
    "is refused at %s, which names no one Bun",
    async (packageManager) => {
      expect(await contract(naming(packageManager))).toEqual([
        containing("packageManager must read bun@<version>, one exact version"),
      ]);
    },
  );
});

/**
 * check.yml's typecheck lane is `bun run typecheck`, so what the script ends up
 * running is the fact, read the way the browser suite's CI step is read: as
 * commands with heads, through every package script they reach. The likeliest
 * wrong readings are a substring match, which passes a script that only prints
 * the words, and an exact match on the script's text, which refuses every
 * monorepo whose root hands the task to its workspaces.
 */
describe("the typecheck script", () => {
  const RUN_BUN_CHECK = "the typecheck script must run `bun check --no-script`";

  const typecheckWith = (scripts: Record<string, string>): Tree =>
    manifestWith((contents) => {
      contents.scripts = { ...contents.scripts, ...scripts };
    });

  test.each([
    ["runs tsc, which a repo no longer installs", { typecheck: "tsc --noEmit" }],
    ["only prints the command", { typecheck: "echo bun check --no-script" }],
    // Without the flag `bun check` runs the repo's own `check` script, and that
    // script runs this one: a lane that recurses rather than type-checks.
    [
      "runs bun check without --no-script beside a check script",
      { typecheck: "bun check", check: "bun run lint && bun run typecheck" },
    ],
  ])("is refused where it %s", async (_what, scripts) => {
    expect(await contract(typecheckWith(scripts))).toEqual([containing(RUN_BUN_CHECK)]);
  });

  test("is refused where it is missing", async () => {
    const tree = manifestWith((contents) => {
      delete contents.scripts?.["typecheck"];
    });
    expect(await contract(tree)).toEqual([containing(RUN_BUN_CHECK)]);
  });

  test("passes where it reaches bun check through another script", async () => {
    const chained = typecheckWith({
      typecheck: "bun run typecheck:root",
      "typecheck:root": "bun check --no-script -p .",
    });
    expect(await contract(chained)).toEqual([]);
  });

  test("passes where turbo hands it to a workspace that runs bun check", async () => {
    const monorepo: Tree = {
      ...typecheckWith({ typecheck: "turbo run typecheck" }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        scripts: { typecheck: "bun check --no-script" },
      }),
    };
    expect(await contract(monorepo)).toEqual([]);
  });
});
