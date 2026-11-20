/**
 * The Node.js the mutation run needs, asked of the runner before Stryker starts.
 *
 * Stryker's command begins `#!/usr/bin/env node`, so it runs under whatever
 * `node` the runner has on `PATH`, never under the Bun that runs the lane. What
 * that Node must be is what the packages the run loads declare in
 * `engines.node`, and Stryker's own declaration is not the strictest of them:
 * `@stryker-mutator/core` 10.1.1 says `>=22.0.0` and loads Babel 8, which says
 * `^22.18.0 || >=24.11.0` and, under a Node 22 older than 22.12, crashes
 * before any mutant is tested with a stack trace about `require()` of an ES
 * module. So the lane reads every declaration in the run's installed
 * dependency tree and holds the runner's Node to all of them.
 */
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

/** The version a `node` binary reports, as `v22.0.0`. */
async function versionOf(node: string): Promise<string> {
  const asked = Bun.spawn([node, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, status] = await Promise.all([new Response(asked.stdout).text(), asked.exited]);
  if (status !== 0) throw new Error(`\`${node} --version\` exited ${status}`);
  return out.trim();
}

/**
 * Why the runner's `node` cannot run Stryker for the repo at `root`, or nothing
 * when it can. `node` is the binary the run would start, as `Bun.which` finds it
 * on `PATH`, and `null` where there is none.
 */
export async function nodeProblem(
  root: string,
  packages: readonly string[],
  node: string | null,
): Promise<Problem | undefined> {
  if (node === null) {
    return {
      message:
        "install Node.js on this runner: Stryker runs under the `node` on PATH, not under Bun, and there is none",
    };
  }
  const version = await versionOf(node);
  const refused = (await declared(root, packages)).filter(
    ({ node: range }) => !Bun.semver.satisfies(version, range),
  );
  if (refused.length === 0) return undefined;
  return {
    message: `install a Node.js on this runner that every package the mutation run loads accepts: Stryker runs under the \`node\` on PATH, ${node}, which is ${version}, and ${byRange(refused)}`,
  };
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
