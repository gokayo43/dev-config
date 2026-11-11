import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { configObjects, isList, record } from "../.github/actions/_lib/gate.ts";
import { type Case, cases, gradedByBase } from "./lint-fixture.ts";

const REPO = dirname(import.meta.dir);

/**
 * The two plugin rules the suite scope decides, and the files that scope is
 * made of. The suite scope is the suffixes, the support-file names and the
 * `tests/` and `e2e/` directories: a suite's helpers and its fixtures are the
 * suite's code one file over, so a rule switched off or on "in test files" is
 * stated there, and a helper gets the same answer as the case that uses it.
 *
 * `no-chained-type-assertions` is on only there, because in source
 * `typescript/consistent-type-assertions` already refuses every assertion it
 * would. `no-test-support-imports` is on everywhere else, because a support
 * file is graded as test code and production must not ship one.
 */
const USER = `interface User {
  readonly id: string;
}
declare const input: unknown;
declare const user: User;
`;

const IN_SUITES = {
  "no-chained-type-assertions": [
    {
      name: "a chain that fabricates the target type is refused",
      source: `${USER}export const one = input as object as User;`,
      reports: ["6:20"],
    },
    {
      name: "one assertion is not a chain — the rule counts links, not assertions",
      source: `${USER}export const one = input as User;`,
      reports: [],
    },
    {
      name: "a const-only chain is the sanctioned one",
      source: `export const ids = ["a", "b"] as const;
export const settings = { retries: 2 } as const;`,
      reports: [],
    },
    {
      name: "parentheses between the links do not hide the chain",
      source: `${USER}export const one = (input as object) as User;`,
      reports: ["6:20"],
    },
    {
      name: "a three-link chain is one diagnostic, at the outermost link",
      source: `${USER}export const one = input as object as Record<string, string> as User;`,
      reports: ["6:20"],
    },
    {
      name: "a const assertion beside a real one is still fabrication",
      source: `${USER}export const one = input as const as User;`,
      reports: ["6:20"],
    },
    {
      name: "an angle-bracket assertion is the same assertion",
      source: `${USER}export const one = <User>(<object>input);`,
      reports: ["6:20"],
    },
    {
      // Why this rule survived the differential against
      // `typescript/no-unsafe-type-assertion`, which refuses every other
      // violating case in this block: each link here widens, so the native
      // rule has nothing unsafe to say and `no-unnecessary-type-assertion`
      // nothing redundant. A chain up a hierarchy still discards the type it
      // started from, and this is the only rule in the base that says so.
      name: "a chain whose every link widens is refused by nothing else",
      source: `interface Admin {
  readonly id: string;
  readonly level: number;
}
interface User {
  readonly id: string;
}
declare const admin: Admin;
export const one = admin as User as object;`,
      reports: ["9:20"],
    },
  ],

  "no-test-support-imports": [
    {
      name: "a fixture imported with or without its extension",
      source: `import { order } from "./order.fixture";
import { page } from "./page.fixture.ts";
export const used = [order, page];`,
      reports: ["`./order.fixture`", "`./page.fixture.ts`"],
    },
    {
      name: "a harness reached through an alias is the same file",
      source: `import { mount } from "@/tests/page.test-harness";
export const used = mount;`,
      reports: ["`@/tests/page.test-harness`"],
    },
    {
      // Each of these reaches the support file without a value import, and a
      // rule reading only `import { x } from` is one keystroke from off.
      name: "a type-only import, a re-export, a star, a dynamic import and an import type reach it too",
      source: `import type { Order } from "./order.fixture";
export { order } from "./order.fixture";
export * from "./page.test-harness";
export const later = await import(\`./order.fixture\`);
export type Page = typeof import("./page.test-harness");
export type Held = Order;`,
      reports: ["1:", "2:", "3:", "4:", "5:"],
    },
    {
      name: "a name that only contains the word is not a support file",
      source: `import { a } from "./fixture";
import { b } from "./fixtures/order";
import { c } from "./order-fixture";
import { d } from "fixture-kit";
import { e } from "./test-harness.ts";
export const used = [a, b, c, d, e];`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** The base's suite-scope globs, read from the block that switches the native assertion rule off. */
const SUITE_GLOBS = await (async (): Promise<string[]> => {
  const base = record(
    (await configObjects(REPO, ["oxlint.base.json"], "JSON with comments")).read[0]?.value,
  );
  const overrides = isList(base["overrides"]) ? base["overrides"] : [];
  const suite = overrides
    .map(record)
    .find((block) => record(block["rules"])["typescript/consistent-type-assertions"] === "off");
  const files = suite?.["files"];
  return isList(files) ? files.filter((glob) => typeof glob === "string") : [];
})();

// The support-file names among them, each the `<name>` of a glob shaped
// `**/*.<name>.*`: a name graded as test code in any directory.
const SUPPORT_NAMES = SUITE_GLOBS.flatMap((glob) => {
  const named = /^\*\*\/\*\.([\w-]+)\.\*$/u.exec(glob)?.[1];
  return named === undefined ? [] : [named];
});

/** A file each glob matches, so the scope is graded on the base's own list rather than a copy. */
function fileMatching(glob: string): string {
  return glob
    .replace(/^\*\*\//u, "src/")
    .replace(/\/\*\*$/u, "/orders.ts")
    .replace(/^src\/\*\./u, "src/orders.")
    .replace(/\.\*$/u, ".ts");
}

/** One file holding a violation of every rule the suite scope decides here. */
const DECIDED = `import { order } from "./order.fixture";
interface Admin {
  readonly id: string;
  readonly level: number;
}
interface User {
  readonly id: string;
}
declare const admin: Admin;
export const one = admin as User as object;
export const home = process.env["HOME"];
export const used = order;
`;

const SUITE_FILES = SUITE_GLOBS.map(fileMatching);
const SOURCE_FILES = ["src/orders.ts", "src/orders.stories.tsx", "scripts/seed.ts"];

const GRADED = await gradedByBase(
  Object.fromEntries([...SUITE_FILES, ...SOURCE_FILES].map((path) => [path, DECIDED])),
);

function codesIn(path: string): string[] {
  return (GRADED.get(path) ?? []).map(({ code }) => code);
}

describe("the suite scope", () => {
  for (const [rule, list] of Object.entries(IN_SUITES)) cases(rule, list);

  test("is read off the base, and carries the support-file names", () => {
    expect(SUITE_FILES).toContain("src/tests/orders.ts");
    expect(SUPPORT_NAMES.length).toBeGreaterThan(0);
  });

  // A support file is the suite's code one file over: what the suite scope
  // switches off for a case it switches off for the harness that case imports.
  test.each(SUITE_FILES)("grades %s as test code", (path) => {
    const codes = codesIn(path);
    expect(codes).toContain("anti-slop(no-chained-type-assertions)");
    expect(codes).not.toContain("typescript(consistent-type-assertions)");
    expect(codes).not.toContain("anti-slop(no-env-access)");
    expect(codes).not.toContain("anti-slop(no-test-support-imports)");
  });

  // Production, and every file that is neither production nor a suite: a story
  // or a seed script that imports a fixture ships it as surely as a route does.
  test.each(SOURCE_FILES)("and %s as code that ships", (path) => {
    const codes = codesIn(path);
    expect(codes).toContain("anti-slop(no-test-support-imports)");
    expect(codes).toContain("typescript(consistent-type-assertions)");
    expect(codes).not.toContain("anti-slop(no-chained-type-assertions)");
  });

  // The rule's list of names and the base's globs are one fact stated twice,
  // so each glob the base adds has to be one the rule refuses an import of.
  test.each(SUPPORT_NAMES)("an import of a .%s file from source is refused", async (name) => {
    const graded = await gradedByBase({
      "src/orders.ts": `import { order } from "./order.${name}";\nexport const used = order;\n`,
    });
    expect((graded.get("src/orders.ts") ?? []).map(({ code }) => code)).toEqual([
      "anti-slop(no-test-support-imports)",
    ]);
  });
});
