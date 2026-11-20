/**
 * What the machine has to give Stryker: a Node.js every package of the run
 * accepts, and a temp directory no other user can tamper with. Either one
 * missing ends Stryker with exit 1, no report and a stack trace its operator
 * cannot act on, so when a run ends that way the lane names, beside the log,
 * what this machine lacks. It names a likely cause and never a certain one, and
 * never before Stryker has run: whether Stryker runs on a machine is answered
 * only by running it there, `engines.node` is advisory, the temp dir rule is the
 * runner's own and a later release can relax it, and a run on a machine named
 * here can still have failed for a reason of the repo's own.
 *
 * Stryker's command begins `#!/usr/bin/env node`, so it runs under whatever
 * `node` the machine has on `PATH`, never under the Bun that runs the lane. What
 * that Node must be is what the packages the run loads declare in
 * `engines.node`, and Stryker's own declaration is not the strictest of them:
 * `@stryker-mutator/core` 10.1.1 says `>=22.0.0` and loads Babel 8, which says
 * `^22.18.0 || >=24.11.0` and, under a Node 22 older than 22.12, crashes
 * before any mutant is tested with a stack trace about `require()` of an ES
 * module. So the lane reads every declaration in the run's installed
 * dependency tree and holds the machine's Node to all of them.
 */
import { realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import { byCodeUnit, isObject, plural, type Problem } from "../_lib/gate.ts";

interface Declared {
  readonly name: string;
  readonly version: string;
  readonly node: string;
}

/**
 * Where `name` is installed as seen from `from`, by the lookup Node itself makes
 * for a bare specifier: `node_modules/<name>` in `from` and in every folder
 * above it.
 */
async function installed(name: string, from: string): Promise<string | undefined> {
  for (let folder = from; ; folder = dirname(folder)) {
    const manifest = join(folder, "node_modules", name, "package.json");
    if (await Bun.file(manifest).exists()) return manifest;
    if (folder === dirname(folder)) return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The `engines.node` of every package installed under `packages`, followed
 * through `dependencies` and `optionalDependencies`. A dependency that is not
 * installed is not loaded, so it declares nothing about this run; an optional
 * one built for another platform is the case that happens.
 */
async function declared(root: string, packages: readonly string[]): Promise<Declared[]> {
  const found = await Promise.all(packages.map(async (name) => await installed(name, root)));
  const queue = found.filter((manifest) => manifest !== undefined);
  const seen = new Set<string>();
  const declarations: Declared[] = [];
  for (let manifest = queue.shift(); manifest !== undefined; manifest = queue.shift()) {
    if (seen.has(manifest)) continue;
    seen.add(manifest);
    const read: unknown = await Bun.file(manifest).json();
    if (!isObject(read)) throw new Error(`${manifest} is not a JSON object`);
    const engines = read["engines"];
    const node = isObject(engines) ? text(engines["node"]) : "";
    if (node !== "") {
      declarations.push({ name: text(read["name"]), version: text(read["version"]), node });
    }
    for (const field of ["dependencies", "optionalDependencies"]) {
      const dependencies = read[field];
      if (!isObject(dependencies)) continue;
      for (const name of Object.keys(dependencies)) {
        const next = await installed(name, dirname(manifest));
        if (next !== undefined) queue.push(next);
      }
    }
  }
  return declarations;
}

/** What a `node` binary answers when asked its version: `v22.0.0` and 0 from one that runs. */
async function versionOf(node: string): Promise<{ version: string; status: number }> {
  const asked = Bun.spawn([node, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, status] = await Promise.all([new Response(asked.stdout).text(), asked.exited]);
  return { version: out.trim(), status };
}

/**
 * Why the machine's `node` cannot run Stryker for the repo at `root`, or nothing
 * when it can. `node` is the binary the run would start, as `Bun.which` finds it
 * on `PATH`, and `null` where there is none.
 */
async function nodeProblem(
  root: string,
  packages: readonly string[],
  node: string | null,
): Promise<Problem | undefined> {
  if (node === null) {
    return {
      message:
        "install Node.js on this machine: Stryker runs under the `node` on PATH, not under Bun, and there is none",
    };
  }
  const { version, status } = await versionOf(node);
  if (status !== 0) {
    return {
      message: `install a Node.js on this machine that runs: Stryker runs under the \`node\` on PATH, ${node}, and asked its version it exited ${status}`,
    };
  }
  const refused = (await declared(root, packages)).filter(
    ({ node: range }) => !Bun.semver.satisfies(version, range),
  );
  if (refused.length === 0) return undefined;
  return {
    message: `install a Node.js on this machine that every package the mutation run loads accepts: Stryker runs under the \`node\` on PATH, ${node}, which is ${version}, and ${byRange(refused)}`,
  };
}

/** A directory's permission bits as `chmod` writes them. */
function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * Every directory from `temp` up to the root that another user could rename or
 * replace an entry of. `@hughescr/stryker-bun-runner` writes a script under its
 * temp dir that every `bun test` of the run executes, and since 1.6.0 it
 * refuses, with exit 1 and no report, a temp dir any directory above which is
 * owned by someone other than this user or root, or writable by group or others
 * without the sticky bit. Its check stops at the first such directory; this
 * names them all, so one fix on the machine is the whole fix.
 */
async function tempProblems(temp: string): Promise<Problem[]> {
  const { uid } = userInfo();
  const problems: Problem[] = [];
  for (let folder = await realpath(temp); ; folder = dirname(folder)) {
    const found = await stat(folder);
    const shared = (found.mode & 0o022) !== 0 && (found.mode & 0o1000) === 0;
    if (found.uid !== uid && found.uid !== 0) {
      problems.push({
        message: `point TMPDIR at a directory only this user (uid ${uid}) and root own, all the way up: the mutation run's temp dir is under ${folder}, which uid ${found.uid} owns and could replace, and Stryker's Bun runner refuses to run a script from below it`,
      });
    } else if (shared) {
      problems.push({
        message: `take group and other write off ${folder} (\`chmod go-w\`), or give it the sticky bit (\`chmod +t\`): it is mode ${octal(found.mode)}, the mutation run's temp dir is under it, and Stryker's Bun runner refuses to run a script from below a directory another user could replace an entry of`,
      });
    }
    if (folder === dirname(folder)) return problems;
  }
}

/**
 * What this machine lacks of what Stryker needs for the repo at `root` with
 * `temp` as its temp dir, each named as a likely cause of a run's exit: none of
 * these is something the repo can change.
 */
export async function machineProblems(
  root: string,
  packages: readonly string[],
  node: string | null,
  temp: string,
): Promise<Problem[]> {
  const runtime = await nodeProblem(root, packages, node);
  return [...(runtime === undefined ? [] : [runtime]), ...(await tempProblems(temp))].map(
    ({ message }) => ({
      message: `${message}. This is what this machine lacks, and a likely cause of the run's exit, not a certain one`,
    }),
  );
}

/**
 * The refusals grouped by the range they declare, each naming one package and
 * counting the rest: Babel's forty-odd packages all declare one range, and
 * listing them would bury the range.
 */
function byRange(refused: readonly Declared[]): string {
  const groups = new Map<string, Set<string>>();
  for (const { name, version, node } of refused) {
    groups.set(node, (groups.get(node) ?? new Set()).add(`${name} ${version}`));
  }
  return [...groups]
    .map(([range, members]) => {
      const [first, ...rest] = [...members].toSorted(byCodeUnit);
      const more =
        rest.length > 0 ? ` and ${plural(rest.length, "other package")} declare` : " declares";
      return `${first}${more} \`${range}\``;
    })
    .join("; ");
}
