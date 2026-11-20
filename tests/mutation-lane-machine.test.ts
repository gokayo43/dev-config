import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineProblems } from "../.github/actions/mutation-lane/machine.ts";
import { containing } from "./matchers.ts";
import { BEFORE, lane, messages, PRICING, repo, WITH_FEE } from "./mutation-lane-fixture.ts";
import { scratch } from "./tree.ts";

/** The branch every case below asks the lane to grade: one domain file, changed. */
const CHANGED = [BEFORE, repo({ ...BEFORE, "src/domain/pricing.ts": PRICING + WITH_FEE })];

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

/** Sets one variable of this process's environment, which every child the lane starts inherits, until disposed. */
function setting(name: string, value: string): Disposable {
  const previous = process.env[name];
  process.env[name] = value;
  return {
    [Symbol.dispose]: () => {
      if (previous === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = previous;
    },
  };
}

/**
 * A directory of mode 0775 straight under the temp dir, removed when disposed.
 * Not under the suite's fixtures, whose own mode follows the umask the suite
 * ran under and would be named beside it.
 */
async function groupWritable(): Promise<AsyncDisposable & { readonly path: string }> {
  const path = await mkdtemp(join(tmpdir(), "mutation-lane-machine-"));
  await chmod(path, 0o775);
  return { path, [Symbol.asyncDispose]: async () => await rm(path, { recursive: true }) };
}

describe("what the machine has to give a mutation run", () => {
  // Stryker 10.1.1 declares `>=22.0.0` and loads Babel 8, which declares
  // `^22.18.0 || >=24.11.0`: on 22.0.0 Stryker exited 1 with no report and a
  // stack trace about require() of an ES module, before testing any mutant.
  test("a node older than a package the run loads declares is refused before Stryker runs", async () => {
    using _path = setting("PATH", `${await nodeAt("v22.0.0")}:${process.env["PATH"] ?? ""}`);
    const verdict = await lane(CHANGED);

    const [only] = messages(verdict);
    expect(messages(verdict)).toHaveLength(1);
    expect(only).toEqual(containing(", which is v22.0.0, and "));
    expect(only).toEqual(containing("other packages declare `^22.18.0 || >=24.11.0`"));
    expect(verdict.note).toBe("this machine cannot run Stryker");
  });

  // `/` is root's and never group-writable, so the temp dir adds nothing here.
  test("a machine with no node is told to install one", async () => {
    expect(await machineProblems(await scratch(), [], null, "/")).toEqual([
      {
        message:
          "install Node.js on this machine: Stryker runs under the `node` on PATH, not under Bun, and there is none",
      },
    ]);
  });

  // dev-config's CI machine set TMPDIR to a directory of mode 0775, and every
  // Stryker run there exited 1 with no report, its Bun runner refusing the temp
  // dir: the directory that fails is above the one TMPDIR names, not that one.
  test("a temp dir under a group-writable directory is refused before Stryker runs, naming that directory", async () => {
    await using open = await groupWritable();
    const own = join(open.path, "own");
    await mkdir(own, { mode: 0o700 });
    using _temp = setting("TMPDIR", own);
    const verdict = await lane(CHANGED);

    expect(messages(verdict)).toEqual([
      `: take group and other write off ${open.path} (\`chmod go-w\`), or give it the sticky bit (\`chmod +t\`): it is mode 0775, the mutation run's temp dir is under it, and Stryker's Bun runner refuses to run a script from below a directory another user could replace an entry of`,
    ]);
    expect(verdict.note).toBe("this machine cannot run Stryker");
  });
});
