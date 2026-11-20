import { symlink } from "node:fs/promises";
import { join } from "node:path";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import {
  type Input,
  mutationLane,
  RUN_DEADLINE_MS,
  UNFINISHED,
} from "../.github/actions/mutation-lane/mutation-lane.ts";
import { git, history, type Tree } from "./tree.ts";

/**
 * Stryker resolves its runner plugin, and `bun test` its own imports, out of
 * the tree it is pointed at — so a fixture repository needs the install a real
 * one has. This repo's own, linked in: the two packages under test are its
 * devDependencies, at the versions its lockfile pins, which is the same install
 * the gate asks a consuming repo for.
 */
export const NODE_MODULES = join(import.meta.dir, "..", "node_modules");

export const OXLINTRC = JSON.stringify({
  settings: { "boundaries/elements": [{ type: "domain", pattern: "src/domain" }] },
});

/**
 * The tsconfig every repo in this fleet has: a root file extending a base
 * beside it. In every fixture because it is in every repo the lane grades, and
 * because Stryker's sandbox preprocessor only wakes for a project that has
 * one — a fixture without it exercises a shape no repo the lane grades has.
 */
const TSCONFIG_BASE = JSON.stringify({
  compilerOptions: { target: "ES2023", module: "preserve", moduleResolution: "bundler" },
});
const TSCONFIG = JSON.stringify({
  extends: "./tsconfig.base.json",
  compilerOptions: { types: ["bun"] },
  include: ["src/**/*.ts", "tests/**/*.ts"],
});

/** A repository the lane can be run against: a manifest, the layer declaration, and a suite. */
export function repo(tree: Tree): Tree {
  return {
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ name: "fixture", type: "module", private: true }),
    ".oxlintrc.json": OXLINTRC,
    "tsconfig.base.json": TSCONFIG_BASE,
    "tsconfig.json": TSCONFIG,
    ...tree,
  };
}

/** A domain function its suite pins completely, so the file starts with nothing undetected. */
export const PRICING = `export function total(cents: number, quantity: number): number {
  return cents * quantity;
}
`;

/** A second function, whose lines are the ones a branch adds. */
export const WITH_FEE = `
export function withFee(cents: number): number {
  return cents + 50;
}
`;

export const TOTAL_TEST = `import { expect, test } from "bun:test";
import { total } from "../src/domain/pricing.ts";

test("charges for every unit", () => {
  expect(total(100, 3)).toBe(300);
});
`;

export const FEE_TEST = `import { expect, test } from "bun:test";
import { total, withFee } from "../src/domain/pricing.ts";

test("charges for every unit", () => {
  expect(total(100, 3)).toBe(300);
});

test("adds the fee", () => {
  expect(withFee(100)).toBe(150);
});
`;

/**
 * A spec beside the unit suite that throws the moment it is loaded — a browser
 * suite whose harness is not `bun test`, and which the runner's own walk of the
 * tree hands `bun test` regardless of what the repo's script selects.
 */
export const BROWSER_SPEC = `throw new Error("the browser suite runs under its own harness");

export {};
`;

export const BEFORE = repo({
  "src/domain/pricing.ts": PRICING,
  "tests/pricing.test.ts": TOTAL_TEST,
});

interface Run {
  readonly floor?: string;
  /** What the repo passes as `mutation-tests`. */
  readonly tests?: string;
  /** Whether the fixture has the install a repo running this lane declares. */
  readonly installed?: boolean;
  /** Settings written into the checkout's own config, the way a developer's `~/.gitconfig` would arrive. */
  readonly configured?: readonly (readonly [string, string])[];
  /** What the repo passes as `mutation-case-timeout`. */
  readonly caseTimeout?: string;
  /** How long the whole lane may run, in milliseconds. */
  readonly runDeadline?: number;
}

/** What the action hands the lane for a checkout at `root`: every input empty, the run's own deadline, unless a case says otherwise. */
export function laneInput(root: string, given: Partial<Omit<Input, "root">> = {}): Input {
  return {
    root,
    event: { baseRef: "", before: "" },
    floor: "",
    tests: "",
    caseTimeout: "",
    runDeadline: RUN_DEADLINE_MS,
    ...given,
  };
}

export async function lane(trees: readonly Tree[], run: Run = {}): Promise<Verdict> {
  return (await laneIn(trees, run)).verdict;
}

/** The same run, with the checkout it worked in — for a case about what it left there. */
export async function laneIn(
  trees: readonly Tree[],
  { installed = true, configured = [], ...given }: Run = {},
): Promise<{ verdict: Verdict; root: string }> {
  const { root } = await history(...trees);
  if (installed) await symlink(NODE_MODULES, join(root, "node_modules"));
  for (const [name, value] of configured) await git(root, ["config", "--local", name, value]);
  return {
    verdict: await mutationLane(laneInput(root, given)),
    root,
  };
}

/**
 * The problems as the action shows them. A Stryker run that exited without a
 * report says to fix what it reported above, where the action prints its log
 * and where a case never looks, so here the log is part of that message: a case
 * that meets such a run fails with what Stryker printed, which is all that
 * explains it on a machine nobody can log into.
 */
export function messages({ note, log, problems }: Verdict): string[] {
  const above = note === UNFINISHED ? `\n${log ?? ""}` : "";
  return problems.map(({ file, message }) => `${file ?? ""}: ${message}${above}`);
}
