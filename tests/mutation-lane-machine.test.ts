import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineProblems } from "../.github/actions/mutation-lane/machine.ts";
import { containing } from "./matchers.ts";
import { UNFINISHED } from "../.github/actions/mutation-lane/mutation-lane.ts";
import { BEFORE, lane, messages, PRICING, repo, WITH_FEE } from "./mutation-lane-fixture.ts";
import { scratch } from "./tree.ts";

/** The branch every case below asks the lane to grade: one domain file, changed. */
const CHANGED = [BEFORE, repo({ ...BEFORE, "src/domain/pricing.ts": PRICING + WITH_FEE })];

/** How the lane ends a run that exited without a report on any machine. */
const EXITED =
  ": fix what the run reported above: it exited 1 without a report, so nothing was graded";

/** What the lane adds to each thing it names that the machine lacks. */
const LIKELY =
  ". This is what this machine lacks, and a likely cause of the run's exit, not a certain one";

/**
 * A `node` that reports `version` and, where it `runs`, runs everything else on
 * this machine's own, in a folder of its own. One that does not run prints a
 * line and exits 1, which is how Stryker meets a Node it cannot run under.
 */
async function nodeAt(version: string, { runs }: { readonly runs: boolean }): Promise<string> {
  const real = Bun.which("node");
  if (real === null) throw new Error("this suite runs Stryker, which needs a node on PATH");
  const folder = await scratch();
  const node = join(folder, "node");
  const otherwise = runs ? `exec ${real} "$@"` : "echo this node runs nothing >&2; exit 1";
  await Bun.write(
    node,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; else ${otherwise}; fi\n`,
  );
  await chmod(node, 0o755);
  return folder;
}

/** The version this machine's own `node` reports, which every package the run loads accepts here. */
async function realVersion(): Promise<string> {
  return (await Bun.$`node --version`.text()).trim();
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
  // `^22.18.0 || >=24.11.0`. `engines.node` is advisory, so a Node outside a
  // declared range says nothing of whether Stryker runs: here it does, and the
  // lane grades the branch as it would on any machine.
  test("a node outside a range a package declares, under which Stryker runs, is graded as any other", async () => {
    using _path = setting(
      "PATH",
      `${await nodeAt("v22.0.0", { runs: true })}:${process.env["PATH"] ?? ""}`,
    );
    const verdict = await lane(CHANGED);

    expect(messages(verdict)).toEqual([
      "src/domain/pricing.ts: write the test that reaches line 5: this branch wrote it and nothing runs it, so `{}` (BlockStatement) in its place goes unnoticed",
      "src/domain/pricing.ts: write the test that reaches line 6: this branch wrote it and nothing runs it, so `cents - 50` (ArithmeticOperator) in its place goes unnoticed",
    ]);
    expect(verdict.note).toBe("mutation score 50.0% over 1 changed domain file");
  });

  // On 22.0.0 Stryker exited 1 with no report and a stack trace about
  // require() of an ES module, before testing any mutant.
  test("a run that exited under a node outside a declared range names that node as a likely cause", async () => {
    using _path = setting(
      "PATH",
      `${await nodeAt("v22.0.0", { runs: false })}:${process.env["PATH"] ?? ""}`,
    );
    const verdict = await lane(CHANGED);

    const [exited, node, ...rest] = messages(verdict);
    expect(exited).toEqual(containing(EXITED));
    expect(node).toEqual(
      containing(
        ": install a Node.js on this machine that every package the mutation run loads accepts: ",
      ),
    );
    expect(node).toEqual(containing(", which is v22.0.0, and "));
    expect(node).toEqual(containing("other packages declare `^22.18.0 || >=24.11.0`"));
    expect(node).toEqual(containing(`${LIKELY}\n`));
    expect(rest).toEqual([]);
    expect(verdict.note).toBe(UNFINISHED);
  });

  // A machine with nothing to name: what a run that exited says is what it
  // said before the lane named anything, so a failure of the repo's own is
  // never blamed on the machine.
  test("a run that exited on a machine lacking nothing is reported as it always was", async () => {
    using _path = setting(
      "PATH",
      `${await nodeAt(await realVersion(), { runs: false })}:${process.env["PATH"] ?? ""}`,
    );
    const verdict = await lane(CHANGED);

    expect(messages(verdict)).toEqual([containing(`${EXITED}\n`)]);
    expect(verdict.note).toBe(UNFINISHED);
  });

  // `/` is root's and never group-writable, so the temp dir adds nothing here.
  test("a machine with no node is told to install one", async () => {
    expect(await machineProblems(await scratch(), [], null, "/")).toEqual([
      {
        message: `install Node.js on this machine: Stryker runs under the \`node\` on PATH, not under Bun, and there is none${LIKELY}`,
      },
    ]);
  });

  // A broken `node` is a cause the lane can name; a throw in its place would
  // end the lane without the log of the run it was explaining.
  test("a node that cannot say its version is named as one that does not run", async () => {
    const folder = await nodeAt("v0", { runs: false });
    const node = join(folder, "node");
    await Bun.write(node, "#!/bin/sh\nexit 3\n");
    expect(await machineProblems(await scratch(), [], node, "/")).toEqual([
      {
        message: `install a Node.js on this machine that runs: Stryker runs under the \`node\` on PATH, ${node}, and asked its version it exited 3${LIKELY}`,
      },
    ]);
  });

  // dev-config's CI machine set TMPDIR to a directory of mode 0775, and every
  // Stryker run there exited 1 with no report, its Bun runner refusing the temp
  // dir: the directory that fails is above the one TMPDIR names, not that one.
  test("a run that exited with its temp dir under a group-writable directory names that directory", async () => {
    await using open = await groupWritable();
    const own = join(open.path, "own");
    await mkdir(own, { mode: 0o700 });
    using _temp = setting("TMPDIR", own);
    const verdict = await lane(CHANGED);

    expect(messages(verdict)).toEqual([
      containing(EXITED),
      containing(
        `: take group and other write off ${open.path} (\`chmod go-w\`), or give it the sticky bit (\`chmod +t\`): it is mode 0775, the mutation run's temp dir is under it, and Stryker's Bun runner refuses to run a script from below a directory another user could replace an entry of${LIKELY}\n`,
      ),
    ]);
    expect(verdict.note).toBe(UNFINISHED);
  });
});
