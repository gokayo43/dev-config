import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ConfigObject, configObjects, isList, record } from "../.github/actions/_lib/gate.ts";
import { BASE, baseConfig, lintAt, oxlint } from "./lint-fixture.ts";
import { CLEAN, contract, withoutReasonFor } from "./repo-contract-fixture.ts";
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
  return isList(configured) ? configured.slice(1).map((entry) => JSON.stringify(entry)) : [];
}

/**
 * The semantics the guard below exists for, proven against a config built here
 * rather than against the shipped base.
 *
 * It cannot be read off the base, because the base is entitled to have no
 * override redefining a list-shaped rule — which is exactly the state it is in,
 * and the state the block below keeps it in. A fact this whole file rests on
 * must not be provable only while some other file happens to be shaped a certain
 * way: a canary asserting "the base still has one for us to look at" turns the
 * day someone deletes the last one into a failing test about nothing, which is
 * how a real guard gets deleted with it.
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
      const carried = new Set(entriesOf(configured));
      return entriesOf(rules[rule])
        .filter((entry) => !carried.has(entry))
        .map((entry) => `${rule} in the override for ${files} drops ${entry}`);
    });
    expect(dropped).toEqual([]);
  });
});

/**
 * What the base's own overrides do to a decision a consuming repo made for
 * itself. README tells every repo to lock one as a `no-restricted-*` entry in
 * its own config, and an override REPLACES that list for every file it matches
 * — so a block in the base redefining one would delete that lock wherever it
 * reached, silently, from a file nobody in that repo is reading. Which is why a
 * ban a file's position decides is a rule of its own, whose scalar setting in an
 * override replaces only itself; the block above holds the base to stating no
 * list-shaped rule in an override, and this one is what that buys.
 */
describe("a repo's own lock on an import", () => {
  const LOCKED = `import { randomUUID } from "node:crypto";
export const id = randomUUID;
`;

  /** What the base plus a repo's own entry refuse, in a file at that path. */
  async function refusedAt(path: string): Promise<string[]> {
    const reported = await oxlint({
      ".oxlintrc.json": baseConfig({
        rules: {
          "no-restricted-imports": [
            "error",
            { name: "node:crypto", importNames: ["randomUUID"], message: "REPO LOCK" },
          ],
        },
      }),
      [path]: LOCKED,
    });
    return reported
      .filter(({ code }) => code.includes("no-restricted-imports"))
      .map(({ help }) => help);
  }

  // The two directories are the cases: they are where the base scopes a ban, and
  // a scoped ban carried as an entry rather than as a rule of its own is exactly
  // what would take this lock away here — silently, and in every repo at once.
  test.each(["src/thing.ts", "src/routes/index.ts", "src/hooks/use-id.ts"])(
    "holds in %s, because no block in the base redefines a list-shaped rule",
    async (path) => {
      expect(await refusedAt(path)).toEqual(["REPO LOCK"]);
    },
  );
});

/**
 * What the base says about a widened binding asserted back to what it was.
 *
 * This repo shipped a rule for exactly that and deleted it, because oxlint's
 * own `typescript/no-unsafe-type-assertion` refuses every one of the shapes
 * below at the same line and column. That is the whole reason the rule is gone,
 * so it is graded here rather than asserted in a commit message: widening a
 * value and asserting it back is an assertion to a narrower type by
 * construction, which is precisely what the native rule reads.
 *
 * Graded in a suite, which is where that rule now stands: in source it is off,
 * under the stronger `consistent-type-assertions`, which refuses these shapes
 * for being assertions at all rather than for what they assert — the case after
 * the block is that half.
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

  /**
   * What the base draws over one shape, as severity and code both. The severity
   * is half the assertion: a rule downgraded to `warn` still reports, so a
   * projection that dropped it would read a gate and a report as the same
   * answer.
   */
  async function drawnOver(source: string, path: string): Promise<string[]> {
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
      [path]: `${source}\n`,
    });
    await symlink(join(REPO, "node_modules"), join(root, "node_modules"));
    return (await lintAt(root)).map(({ severity, code }) => `${severity} ${code}`);
  }

  test.each(Object.entries(WIDENED))("%s", async (_name, source) => {
    expect(await drawnOver(source, "case.test.ts")).toContain(
      "error typescript(no-unsafe-type-assertion)",
    );
  });

  // And in source, where the rule above is off and the stronger one has already
  // refused the assertion — the half that makes turning it off there free.
  test("and in source, where the stronger rule answers first", async () => {
    const [first] = Object.values(WIDENED);
    expect(await drawnOver(first ?? "", "case.ts")).toContain(
      "error typescript(consistent-type-assertions)",
    );
  });

  // Promoted from `warn` with `no-console`, and graded in this block because it
  // is type-aware: whether `||` should have been `??` is a question about what
  // the left side can hold, which the fixture tree in `lint-policy.test.ts`
  // cannot ask with the checker off. The severity is the whole of the change.
  test("and a logical or over a nullable value denies rather than advises", async () => {
    const NULLABLE = `export function pick(v: string | undefined): string {
  return v || "fallback";
}`;
    expect(await drawnOver(NULLABLE, "case.ts")).toContain(
      "error typescript(prefer-nullish-coalescing)",
    );
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
  test("carries a reason for every switch-off in it", async () => {
    const problems = await contract({ ...CLEAN, ".oxlintrc.json": shipped });
    expect(problems.filter((message) => message.includes("turned off"))).toEqual([]);
  });

  // The half that makes the half above mean something. Asserting only that a
  // file draws no findings is a test a walker returning nothing at all passes,
  // and the base holds switch-offs for it to find. How many is not written here:
  // a count in a comment is a number to forget, and the case below names the one
  // it is about instead.
  test("and is graded by the walker that would find one missing", async () => {
    const problems = await contract({
      ...CLEAN,
      ".oxlintrc.json": withoutReasonFor(shipped, "oxc/no-map-spread"),
    });
    expect(problems.filter((message) => message.includes("turned off"))).toEqual([
      "oxc/no-map-spread is turned off with no reason — add the reason above the entry",
    ]);
  });
});
