import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { materialise, type Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);
const OXLINT = join(REPO, "node_modules/.bin/oxlint");
/** The shipped base, which is what a scoping case has to be graded against rather than a copy. */
export const BASE = join(REPO, "oxlint.base.json");
const PLUGIN = join(REPO, "anti-slop/index.js");

/**
 * A case is linted by the same binary CI runs, in a tree of its own: the rules
 * here are a plugin oxlint loads and drives, so nothing short of running it
 * says whether a rule fires. Type-aware checking is off because a fixture tree
 * has no tsconfig — every rule in this plugin is syntactic, and the ones that
 * are not live in `oxlint.base.json` as oxlint's own.
 *
 * One run per block rather than per case: a case is a file in the tree, and
 * grouping the diagnostics by file is what puts each one back with its case.
 * Nine spawns instead of a hundred, with no case able to see another's.
 */
export async function oxlint(tree: Tree): Promise<string[]> {
  const root = await materialise(tree);
  const proc = Bun.spawn([OXLINT, "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  const status = await proc.exited;
  const lines = output.split("\n").map((line) => line.trim());

  // A rule that throws is reported as a line with no `file:line:col:` in it, so
  // the filter below drops it and the file reads as clean — which is exactly
  // what a case expecting no diagnostics asserts. Every clean tree in this file
  // would certify a plugin that crashed on all nine rules.
  const crashed = lines.find((line) => line.includes("Error running JS plugin"));
  if (crashed !== undefined) throw new Error(crashed);

  const reported = lines.filter((line) => /^\S+:\d+:\d+: (error|warning)/.test(line));
  // And a config oxlint refuses, or a plugin it cannot load, is a run with no
  // diagnostics at all. oxlint exits 1 for an error and 0 for warnings alone,
  // so the two have to agree or something other than the rules answered.
  const errors = reported.filter((line) => line.includes(": error")).length;
  if (status !== (errors > 0 ? 1 : 0)) {
    throw new Error(`oxlint exited ${status} with ${errors} error(s):\n${output}`);
  }
  return reported;
}

/** The rule under test and nothing else, so a case cannot pass on another rule's diagnostic. */
function alone(rule: string): string {
  return JSON.stringify({
    plugins: [],
    categories: { correctness: "off" },
    jsPlugins: [{ name: "anti-slop", specifier: PLUGIN }],
    rules: { [`anti-slop/${rule}`]: "error" },
  });
}

/** Where a diagnostic sits, so a file's diagnostics read in source order whatever order they arrived in. */
function position(line: string): [number, number] {
  const [, at = "0", column = "0"] = line.split(":");
  return [Number(at), Number(column)];
}

const runs = new Map<string, Promise<readonly (readonly string[])[]>>();

/**
 * Every case in one block, lit by one oxlint run and handed back per case.
 * Memoised on the key so the block's cases share the run rather than repeating
 * it, and started by whichever case is executed first.
 */
export async function reportsFor(
  key: string,
  rule: string,
  sources: readonly string[],
): Promise<readonly (readonly string[])[]> {
  const started =
    runs.get(key) ??
    (async () => {
      const files = sources.map((_, index) => `case-${index}.ts`);
      const reported = await oxlint({
        ".oxlintrc.json": alone(rule),
        ...Object.fromEntries(files.map((file, index) => [file, sources[index] ?? ""])),
      });
      const byFile = new Map<string, string[]>();
      for (const line of reported) {
        const [path = ""] = line.split(":");
        const name = path.slice(path.lastIndexOf("/") + 1);
        byFile.set(name, [...(byFile.get(name) ?? []), line]);
      }
      return files.map((file) =>
        (byFile.get(file) ?? []).toSorted((left, right) => {
          const [leftAt, leftColumn] = position(left);
          const [rightAt, rightColumn] = position(right);
          return leftAt - rightAt || leftColumn - rightColumn;
        }),
      );
    })();
  runs.set(key, started);
  return await started;
}

export interface Case {
  /** The wrong implementation this case would catch — not a restatement of the source. */
  readonly name: string;
  readonly source: string;
  /**
   * One fragment per diagnostic the rule must produce, in source order. An
   * empty list is the assertion that the tree is clean, which is half of what
   * every rule here has to get right.
   */
  readonly reports: readonly string[];
}

/** Runs a rule's cases, each against the diagnostics of its own file. */
export function cases(rule: string, list: readonly Case[]): void {
  describe(rule, () => {
    const sources = list.map(({ source }) => source);
    for (const [index, each] of list.entries()) {
      test(each.name, async () => {
        const reported = (await reportsFor(rule, rule, sources))[index] ?? [];
        expect(reported).toHaveLength(each.reports.length);
        for (const [at, fragment] of each.reports.entries()) {
          expect(reported[at]).toContain(`anti-slop(${rule})`);
          expect(reported[at]).toContain(fragment);
        }
      });
    }
  });
}

/** The case a rule exists to reject, which is what the base has to be wired to catch. */
function violating(list: readonly Case[]): string {
  const first = list.find(({ reports }) => reports.length > 0);
  if (first === undefined) throw new Error("a rule with no violating case is a rule with no suite");
  return first.source;
}

/**
 * Every rule's violating case, in a file named the way the base decides what it
 * grades — which is the whole of what a scoped rule's suite is asking about.
 */
export function underBase(suffix: string, rules: Record<string, readonly Case[]>): Tree {
  return {
    ".oxlintrc.json": JSON.stringify({ extends: [BASE], options: { typeAware: false } }),
    ...Object.fromEntries(
      Object.entries(rules).map(([rule, list]) => [`${rule}${suffix}`, violating(list)]),
    ),
  };
}
