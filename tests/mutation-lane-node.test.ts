import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { nodeProblem } from "../.github/actions/mutation-lane/node.ts";
import { containing } from "./matchers.ts";
import { BEFORE, lane, messages, PRICING, repo, WITH_FEE } from "./mutation-lane-fixture.ts";
import { scratch } from "./tree.ts";

/**
 * A `node` that reports `version` and runs everything else on this machine's
 * own, in a folder of its own: a lane that skipped the check would then grade
 * the branch rather than fail for want of a Node.
 */
async function nodeAt(version: string): Promise<string> {
  const real = Bun.which("node");
  if (real === null) throw new Error("this suite runs Stryker, which needs a node on PATH");
  const folder = await scratch();
  const node = join(folder, "node");
  await Bun.write(
    node,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; else exec ${real} "$@"; fi\n`,
  );
  await chmod(node, 0o755);
  return folder;
}

/** Puts `folder` first on this process's PATH, which every child the lane starts inherits, until disposed. */
function first(folder: string): Disposable {
  const previous = process.env["PATH"];
  process.env["PATH"] = `${folder}:${previous ?? ""}`;
  return {
    [Symbol.dispose]: () => {
      process.env["PATH"] = previous;
    },
  };
}

describe("the Node.js a mutation run needs", () => {
  // Stryker 10.1.1 declares `>=22.0.0` and loads Babel 8, which declares
  // `^22.18.0 || >=24.11.0`: on 22.0.0 Stryker exited 1 with no report and a
  // stack trace about require() of an ES module, before testing any mutant.
  test("a runner whose node is older than a package the run loads declares is refused before Stryker runs", async () => {
    using _path = first(await nodeAt("v22.0.0"));
    const verdict = await lane([
      BEFORE,
      repo({ ...BEFORE, "src/domain/pricing.ts": PRICING + WITH_FEE }),
    ]);

    const [only] = messages(verdict);
    expect(messages(verdict)).toHaveLength(1);
    expect(only).toEqual(containing(", which is v22.0.0, and "));
    expect(only).toEqual(containing("other packages declare `^22.18.0 || >=24.11.0`"));
    expect(verdict.note).toBe("the runner's Node.js cannot run the mutation run");
  });

  test("a runner with no node is told to install one", async () => {
    expect(await nodeProblem(await scratch(), [], null)).toEqual({
      message:
        "install Node.js on this runner: Stryker runs under the `node` on PATH, not under Bun, and there is none",
    });
  });
});
