import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);
const OXLINT = join(REPO, "node_modules/.bin/oxlint");
/** The shipped base, which is what a scoping case has to be graded against rather than a copy. */
export const BASE = join(REPO, "oxlint.base.json");
const PLUGIN = join(REPO, "anti-slop/index.js");

/** One diagnostic, as much of the JSON report as a case reads. */
export interface Diagnostic {
  readonly filename: string;
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  /**
   * The rule's advice, which for a configured rule is the message the config
   * wrote. `no-restricted-imports` states the house pick there rather than in
   * `message`, so a suite grading what a diagnostic tells a reader reads this.
   */
  readonly help: string;
  readonly line: number;
  readonly column: number;
}

function textAt(held: ConfigObject, key: string): string {
  const value = held[key];
  return typeof value === "string" ? value : "";
}

function countAt(held: ConfigObject, key: string): number {
  const value = held[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Where a diagnostic sits: the first label's span, which is the one every
 * reporter prints. A diagnostic with no labels belongs to no line — and, as
 * `oxlint` below reads it, to no file either.
 */
function decoded(held: ConfigObject): Diagnostic {
  const labels = held["labels"];
  const span = record(record(isList(labels) ? labels[0] : {})["span"]);
  return {
    filename: textAt(held, "filename"),
    severity: textAt(held, "severity"),
    code: textAt(held, "code"),
    message: textAt(held, "message"),
    help: textAt(held, "help"),
    line: countAt(span, "line"),
    column: countAt(span, "column"),
  };
}

/**
 * What a fixture run is told about where it is running, over the environment
 * the suite was started in. An empty value is how one is taken away, which is
 * what oxlint reads a variable it selects on as.
 */
export type Environment = Record<string, string>;

/**
 * A diagnostic written out. Presentation, and the last thing that happens to
 * one: what a case matches on is a line, and nothing here reads a field back
 * out of it.
 */
function stated({ filename, line, column, severity, code, message }: Diagnostic): string {
  return `${filename}:${line}:${column}: ${severity} ${code}: ${message}`;
}

/**
 * A case is linted by the same binary CI runs, in a tree of its own: the rules
 * here are a plugin oxlint loads and drives, so nothing short of running it
 * says whether a rule fires. Type-aware checking is off because a fixture tree
 * has no tsconfig — every rule in this plugin is syntactic, and the ones that
 * are not live in `oxlint.base.json` as oxlint's own, graded by `lintAt` below
 * against a tree carrying both.
 *
 * One run per block rather than per case: a case is a file in the tree, and
 * grouping the diagnostics by file is what puts each one back with its case.
 * One spawn per rule instead of one per case, with no case able to see
 * another's.
 *
 * The format is pinned, and the report is parsed rather than matched. oxlint
 * chooses a reporter from the environment when nothing says otherwise —
 * `github` on a runner, `agent` under an AI agent's shell, a graphical one in
 * an ordinary terminal — and only the agent shape reads as
 * `file:line:column: severity`. A harness that recognised diagnostics by that
 * shape agreed with itself on a developer's machine and called every case on CI
 * a clean tree.
 */
export async function oxlint(
  tree: Tree,
  environment: Environment = {},
): Promise<readonly Diagnostic[]> {
  return await lintAt(await materialise(tree), environment);
}

/**
 * The same run, over a tree the caller has already made — which is what a case
 * needing more than files does: the base's own rules are type-aware, and the
 * analysis runs in a package the fixture has to be able to resolve.
 */
export async function lintAt(
  root: string,
  environment: Environment = {},
): Promise<readonly Diagnostic[]> {
  const proc = Bun.spawn([OXLINT, "--format=json", "."], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, failed] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;

  let report: unknown;
  try {
    report = JSON.parse(output) as unknown;
  } catch {
    // A config oxlint refuses, and a plugin it cannot load, never reach the
    // reporter at all: the run says so in prose and exits non-zero.
    throw new Error(`oxlint exited ${status} without a JSON report:\n${output}${failed}`);
  }

  const held = record(report)["diagnostics"];
  const diagnostics = (isList(held) ? held : []).map((each) => decoded(record(each)));

  // A diagnostic belonging to no file is dropped by the grouping every caller
  // does, and the cases it should have failed then read clean — which is
  // exactly what a case expecting no diagnostics asserts. Refused here instead,
  // so that one of them cannot certify a whole block.
  const loose = diagnostics.filter(({ filename }) => filename === "");
  if (loose.length > 0) throw new Error(loose.map(({ message }) => message).join("\n"));

  // oxlint exits 1 for an error and 0 for warnings alone, so the count and the
  // status have to agree or something other than the rules answered.
  const errors = diagnostics.filter(({ severity }) => severity === "error").length;
  if (status !== (errors > 0 ? 1 : 0)) {
    throw new Error(`oxlint exited ${status} with ${errors} error(s):\n${output}`);
  }

  return diagnostics.toSorted(
    (left, right) =>
      left.filename.localeCompare(right.filename) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

/**
 * A report grouped by the file each diagnostic belongs to, which is what puts
 * one back with the case that drew it — a file in a flat tree of cases, or a
 * path a rule is scoped by. oxlint answers paths relative to the root it ran in,
 * so the name a caller looks up is the one it wrote into the tree.
 */
export function byFile(
  diagnostics: readonly Diagnostic[],
): ReadonlyMap<string, readonly Diagnostic[]> {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    grouped.set(diagnostic.filename, [...(grouped.get(diagnostic.filename) ?? []), diagnostic]);
  }
  return grouped;
}

/** Every diagnostic written out, for a caller grading a whole tree at once. */
export async function lines(tree: Tree): Promise<string[]> {
  return (await oxlint(tree)).map(stated);
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

interface Run {
  /** Identity, not contents: one block computes its list once and every case reads that one. */
  readonly sources: readonly string[];
  readonly reported: Promise<readonly (readonly string[])[]>;
}

const runs = new Map<string, Run>();

/**
 * Every case in one block, lit by one oxlint run and handed back per case.
 * Memoised on the key so the block's cases share the run rather than repeating
 * it, and started by whichever case is executed first.
 *
 * Two blocks under one key would silently read each other's diagnostics —
 * every case of the second graded against the first's tree, passing or failing
 * for reasons nothing in it names — so a key arriving with a different list is
 * refused rather than answered.
 */
export async function reportsFor(
  key: string,
  rule: string,
  sources: readonly string[],
): Promise<readonly (readonly string[])[]> {
  const known = runs.get(key);
  if (known !== undefined) {
    if (known.sources !== sources) {
      throw new Error(`two blocks of cases are sharing the run key "${key}"`);
    }
    return await known.reported;
  }

  const reported = (async () => {
    const files = sources.map((_, index) => `case-${index}.ts`);
    const diagnostics = await oxlint({
      ".oxlintrc.json": alone(rule),
      ...Object.fromEntries(files.map((file, index) => [file, sources[index] ?? ""])),
    });
    const grouped = byFile(diagnostics);
    return files.map((file) => (grouped.get(file) ?? []).map(stated));
  })();
  runs.set(key, { sources, reported });
  return await reported;
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
 * The config a fixture inherits the shipped base through. Type-aware checking is
 * off because a fixture tree has no tsconfig for the checker to read; a case
 * needing more than that — the globals a repo declares, say — adds it.
 *
 * One definition, because every scoping case in this suite is graded against
 * the base as shipped, and a second copy of this object is a second answer to
 * "what does a repo inherit" that nothing would notice had drifted.
 */
export function baseConfig(extra: ConfigObject = {}): string {
  return JSON.stringify({ extends: [BASE], options: { typeAware: false }, ...extra });
}

/**
 * A tree of source files linted by the shipped base, grouped by path: the whole
 * of what a suite grading WHERE a rule applies needs, as against `cases` above,
 * which grades what one rule says about a source.
 */
export async function gradedByBase(
  files: Record<string, string>,
): Promise<ReadonlyMap<string, readonly Diagnostic[]>> {
  return byFile(await oxlint({ ".oxlintrc.json": baseConfig(), ...files }));
}

/**
 * Every rule's violating case, in a file named the way the base decides what it
 * grades — which is the whole of what a scoped rule's suite is asking about.
 */
export function underBase(suffix: string, rules: Record<string, readonly Case[]>): Tree {
  return {
    ".oxlintrc.json": baseConfig(),
    ...Object.fromEntries(
      Object.entries(rules).map(([rule, list]) => [`${rule}${suffix}`, violating(list)]),
    ),
  };
}
