import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ConfigObject, configObjects, record } from "../.github/actions/_lib/gate.ts";
import { BASE, lintAt, oxlint } from "./lint-fixture.ts";
import { CLEAN, contract } from "./repo-contract-fixture.ts";
import { materialise } from "./tree.ts";

const REPO = dirname(import.meta.dir);

/**
 * The base itself, read through the gates' own JSONC decoder — it carries the
 * reason for every entry in it as a comment, which is the thing the README
 * asks every repo to write and `JSON.parse` refuses.
 */
const base = record(
  (await configObjects(REPO, ["oxlint.base.json"], "JSON with comments")).read[0]?.value,
);

/**
 * The rules whose configuration is a list of entries rather than one options
 * object: the settled-decision choke pattern the README describes. Anything
 * here that the base states at the top level has to hold everywhere.
 */
const ENTRY_LIST_RULES = [
  "no-restricted-globals",
  "no-restricted-imports",
  "no-restricted-properties",
];

/** A rule's configured entries — everything after the severity, which is the list itself. */
function entriesOf(configured: unknown): string[] {
  return Array.isArray(configured) ? configured.slice(1).map((entry) => JSON.stringify(entry)) : [];
}

/**
 * The semantics the guard below exists for, proven against a config built here
 * rather than against the shipped base.
 *
 * It cannot be read off the base, because the base is entitled to have no
 * override redefining a list-shaped rule — which is exactly the state it is in.
 * A fact this whole file rests on must not be provable only while some other
 * file happens to be shaped a certain way: a canary asserting "the base still
 * has one for us to look at" turns the day someone deletes the last one into a
 * failing test about nothing, which is how a real guard gets deleted with it.
 */
describe("an override that names a list-shaped rule", () => {
  const USES_ALL = `export const a = __dirname;
export const b = __filename;
export const c = typeof require;
`;

  /** The base's own shape in miniature: three entries stated once, at the top. */
  function config(override: ConfigObject | undefined): string {
    return JSON.stringify({
      plugins: [],
      categories: { correctness: "off" },
      rules: {
        "no-restricted-globals": [
          "error",
          { name: "__dirname", message: "a" },
          { name: "__filename", message: "b" },
          { name: "require", message: "c" },
        ],
      },
      overrides: [{ files: ["**/*.test.ts"], rules: override ?? {} }],
    });
  }

  async function restricted(override: ConfigObject | undefined): Promise<number> {
    const reported = await oxlint({
      ".oxlintrc.json": config(override),
      "case.test.ts": USES_ALL,
    });
    return reported.filter(({ code }) => code.includes("no-restricted-globals")).length;
  }

  test("an override that says nothing about it inherits the whole list", async () => {
    expect(await restricted(undefined)).toBe(3);
  });

  // REPLACES rather than merges (oxc#12179). An override that redefines the
  // rule to change one thing about it silently exempts every file it matches
  // from every entry it did not restate — in every repo extending the base.
  test("an override that redefines it keeps only what it restated", async () => {
    const kept = { "no-restricted-globals": ["error", { name: "__dirname", message: "a" }] };
    expect(await restricted(kept)).toBe(1);
  });
});

describe("the base's list-shaped rules", () => {
  const overrides = Array.isArray(base["overrides"]) ? base["overrides"] : [];
  const rules = record(base["rules"]);

  const redefinitions = ENTRY_LIST_RULES.flatMap((rule) =>
    overrides.flatMap((override) => {
      const configured = record(record(override)["rules"])[rule];
      return configured === undefined
        ? []
        : [{ rule, files: JSON.stringify(record(override)["files"]), configured }];
    }),
  );

  // The left-hand side of the comparison below. With no list-shaped rule stated
  // at the top level there is nothing for an override to drop, and every case
  // here would pass over an empty set for the rest of this repo's life.
  test("the base states a list-shaped rule at the top level", () => {
    expect(ENTRY_LIST_RULES.filter((rule) => entriesOf(rules[rule]).length > 0)).not.toEqual([]);
  });

  // One case rather than one per redefinition. Nothing redefines a list-shaped
  // rule today, and a `test.each` over that empty list registers no test at all
  // — no `<testcase>` in the report, nothing for the suite gate to count, and a
  // guard that is indistinguishable from a deleted one. Written this way it is
  // always in the report, passes over an empty list, and names the offender the
  // day there is one.
  test("no override drops an entry the base states", () => {
    const dropped = redefinitions.flatMap(({ rule, files, configured }) => {
      const carried = entriesOf(configured);
      return entriesOf(rules[rule])
        .filter((entry) => !carried.includes(entry))
        .map((entry) => `${rule} in the override for ${files} drops ${entry}`);
    });
    expect(dropped).toEqual([]);
  });
});

/**
 * What the base says about a widened binding asserted back to what it was.
 *
 * This repo shipped a rule for exactly that and deleted it, because oxlint's
 * own `typescript/no-unsafe-type-assertion` — which the base denies through
 * `suspicious` — refuses every one of the shapes below at the same line and
 * column. That is the whole reason the rule is gone, so it is graded here
 * rather than asserted in a commit message: widening a value and asserting it
 * back is an assertion to a narrower type by construction, which is precisely
 * what the native rule reads.
 *
 * Type-aware, because none of the base's own rules answer otherwise: the
 * analysis runs in `oxlint-tsgolint`, so the tree gets this repo's install to
 * resolve it out of, and a tsconfig for the checker to read.
 */
describe("the widened bindings the base still refuses", () => {
  const USER = `interface User {
  readonly id: string;
}
declare const user: User;
`;

  const WIDENED = {
    "an operator over a literal, widened and asserted back": `export function round(): number {
  const wide: unknown = -1;
  return wide as number;
}`,
    "a known value widened by its annotation": `${USER}export function round(value: User): User {
  const wide: unknown = value;
  return wide as User;
}`,
    "the widening written as an assertion rather than an annotation": `${USER}export function round(value: User): User {
  const wide = value as unknown;
  return wide as User;
}`,
    "the binding in scope rather than the one with the name": `${USER}export function carry(value: User): User {
  const wide = value;
  return wide as User;
}
export function round(value: User): User {
  const wide: unknown = value;
  return wide as User;
}`,
  };

  test.each(Object.entries(WIDENED))("%s", async (_name, source) => {
    const root = await materialise({
      ".oxlintrc.json": JSON.stringify({
        extends: [BASE],
        ignorePatterns: ["node_modules/**"],
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["*.ts"],
      }),
      "case.ts": `${source}\n`,
    });
    await symlink(join(REPO, "node_modules"), join(root, "node_modules"));

    const reported = await lintAt(root);
    expect(reported.map(({ code }) => code)).toContain("typescript(no-unsafe-type-assertion)");
  });
});

/**
 * The base is the file every repo's `.oxlintrc.json` inherits, and it switches
 * rules off itself — so it is graded by the rule it makes those repos keep,
 * through the walker the contract actually runs rather than a reading of it.
 * A base that could not pass its own gate is a rule the fleet would learn to
 * treat as advisory.
 */
const shipped = await Bun.file(join(REPO, "oxlint.base.json")).text();

describe("the base against the rule it makes every repo keep", () => {
  /** The base with the reason directly above one of its switch-offs taken out. */
  function withoutReasonFor(rule: string): string {
    const lines = shipped.split("\n");
    const at = lines.findIndex((line) => line.trim().startsWith(`"${rule}"`));
    let first = at;
    while (first > 0 && (lines[first - 1] ?? "").trim().startsWith("//")) first -= 1;
    lines.splice(first, at - first);
    return lines.join("\n");
  }

  test("carries a reason for every switch-off in it", async () => {
    const problems = await contract({ ...CLEAN, ".oxlintrc.json": shipped });
    expect(problems.filter((message) => message.includes("turned off"))).toEqual([]);
  });

  // The half that makes the half above mean something. Asserting only that a
  // file draws no findings is a test a walker returning nothing at all passes,
  // and this base holds four switch-offs for it to find.
  test("and is graded by the walker that would find one missing", async () => {
    const problems = await contract({
      ...CLEAN,
      ".oxlintrc.json": withoutReasonFor("oxc/no-map-spread"),
    });
    expect(problems.filter((message) => message.includes("turned off"))).toEqual([
      "oxc/no-map-spread is turned off with no reason — add the reason above the entry",
    ]);
  });
});
