import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { type Lane, mutationLane } from "../.github/actions/mutation-lane/mutation-lane.ts";
import { containing } from "./matchers.ts";
import { history, type Tree, without } from "./tree.ts";

/**
 * Stryker resolves its runner plugin, and `bun test` its own imports, out of
 * the tree it is pointed at — so a fixture repository needs the install a real
 * one has. This repo's own, linked in: the two packages under test are its
 * devDependencies, at the versions its lockfile pins, which is the same install
 * the gate asks a consuming repo for.
 */
const NODE_MODULES = join(import.meta.dir, "..", "node_modules");

const OXLINTRC = JSON.stringify({
  settings: { "boundaries/elements": [{ type: "domain", pattern: "src/domain" }] },
});

/** A repository the lane can be run against: a manifest, the layer declaration, and a suite. */
function repo(tree: Tree): Tree {
  return {
    ".gitignore": "node_modules\n",
    "package.json": JSON.stringify({ name: "fixture", type: "module", private: true }),
    ".oxlintrc.json": OXLINTRC,
    ...tree,
  };
}

/** A domain function its suite pins completely, so the file starts with nothing undetected. */
const PRICING = `export function total(cents: number, quantity: number): number {
  return cents * quantity;
}
`;

/** The same file with a branch the suite never reaches, so it starts carrying mutants nothing catches. */
const PRICING_WITH_A_GAP = `export function total(cents: number, quantity: number): number {
  if (quantity > 10) return cents * quantity - 100;
  return cents * quantity;
}
`;

/** A branch nothing reaches, written across lines so that the block is one mutant and its body another. */
const BRANCHING = (
  deduction: string,
): string => `export function total(cents: number, quantity: number): number {
  if (quantity > 10) {
    return cents * quantity - ${deduction};
  }
  return cents * quantity;
}
`;

/** A second function, whose lines are the ones a branch adds. */
const WITH_FEE = `
export function withFee(cents: number): number {
  return cents + 50;
}
`;

const TOTAL_TEST = `import { expect, test } from "bun:test";
import { total } from "../src/domain/pricing.ts";

test("charges for every unit", () => {
  expect(total(100, 3)).toBe(300);
});
`;

const FEE_TEST = `import { expect, test } from "bun:test";
import { total, withFee } from "../src/domain/pricing.ts";

test("charges for every unit", () => {
  expect(total(100, 3)).toBe(300);
});

test("adds the fee", () => {
  expect(withFee(100)).toBe(150);
});
`;

const BEFORE = repo({
  "src/domain/pricing.ts": PRICING,
  "tests/pricing.test.ts": TOTAL_TEST,
});

/** The branch every case below is graded on: one domain file, changed. */
const CHANGED = repo({ "src/domain/pricing.ts": PRICING + WITH_FEE });

const BEFORE_WITH_A_GAP = repo({
  "src/domain/pricing.ts": PRICING_WITH_A_GAP,
  "tests/pricing.test.ts": TOTAL_TEST,
});

async function lane(trees: readonly Tree[], floor = "", installed = true): Promise<Lane> {
  const { root } = await history(...trees);
  if (installed) await symlink(NODE_MODULES, join(root, "node_modules"));
  return await mutationLane({ root, event: { baseRef: "", before: "" }, floor });
}

function messages({ problems }: Lane): string[] {
  return problems.map(({ file, message }) => `${file ?? ""}: ${message}`);
}

/** Why the lane refused to run at all — a bad input is a throw, not a problem it reports. */
async function refusal(floor: string): Promise<string> {
  const { root } = await history(BEFORE);
  try {
    await mutationLane({ root, event: { baseRef: "", before: "" }, floor });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return `the lane accepted a floor of '${floor}'`;
}

describe("the mutation lane", () => {
  test("a branch whose new lines nothing tests is refused, naming each line to pin", async () => {
    const verdict = await lane([
      BEFORE_WITH_A_GAP,
      repo({
        "src/domain/pricing.ts": PRICING_WITH_A_GAP + WITH_FEE,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    // Exactly these two, out of the six the file leaves undetected: the branch
    // is answerable for the lines it wrote and for no others, and a lane that
    // reported every survivor in a file anyone touched would report all six.
    expect(messages(verdict)).toEqual([
      "src/domain/pricing.ts: write the test that reaches line 6: this branch wrote it and nothing runs it, so `{}` (BlockStatement) in its place goes unnoticed",
      "src/domain/pricing.ts: write the test that reaches line 7: this branch wrote it and nothing runs it, so `cents - 50` (ArithmeticOperator) in its place goes unnoticed",
    ]);
    expect(verdict.note).toBe("mutation score 40.0% over 1 changed domain file");
    expect(verdict.table).toEqual(containing("| Undetected | 6 |"));
  });

  test("the same branch passes once the test pins those lines", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 100.0% over 1 changed domain file");
    expect(verdict.table).toEqual(containing("| Undetected | 0 |"));
  });

  // The whole of what "selective" buys, and what separates this gate from a
  // campaign: the file it mutates still carries four mutants nothing catches —
  // `total`'s unreached branch — and the branch is not held to them, because it
  // did not write those lines. The score still says they are there.
  test("a mutant undetected outside this branch's own lines does not fail it", async () => {
    const verdict = await lane([
      BEFORE_WITH_A_GAP,
      repo({
        "src/domain/pricing.ts": PRICING_WITH_A_GAP + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 60.0% over 1 changed domain file");
    expect(verdict.table).toEqual(containing("| Undetected | 4 |"));
    expect(verdict.table).toEqual(containing("| Undetected on this branch's own lines | 0 |"));
  });

  test("the floor is what those four are still measured against", async () => {
    const verdict = await lane(
      [
        BEFORE_WITH_A_GAP,
        repo({
          "src/domain/pricing.ts": PRICING_WITH_A_GAP + WITH_FEE,
          "tests/pricing.test.ts": FEE_TEST,
        }),
      ],
      "0.95",
    );

    expect(messages(verdict)).toEqual([
      ": kill the mutants listed in the run summary: 60.0% of the mutants in 1 changed domain file were caught, under the 95.0% floor this repo declares",
    ]);
    expect(verdict.table).toEqual(containing("| Floor | 95.0% |"));
  });

  test("a branch that changed no domain file says so and mutates nothing", async () => {
    const verdict = await lane([BEFORE, repo({ ...BEFORE, "README.md": "# a repo\n" })]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("no domain file changed"));
    expect(verdict.table).toBeUndefined();
  });

  // README asks a repo to write the reason for an override beside it, and
  // oxlint's own schema declares allowComments — so the layer declaration
  // arrives in a dialect JSON.parse refuses, and reading it strictly would
  // refuse the file the linter reads happily.
  test("the layer declaration is read in the dialect oxlint writes it in", async () => {
    const commented = `{\n  // the domain core is pure\n${OXLINTRC.slice(1)}`;
    const verdict = await lane([
      BEFORE,
      {
        ...repo({
          "src/domain/pricing.ts": PRICING + WITH_FEE,
          "tests/pricing.test.ts": FEE_TEST,
        }),
        ".oxlintrc.json": commented,
      },
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("mutation score"));
  });

  // Half the fleet is a workspace, and its layer declaration is one element with
  // a glob in it rather than one per project. `apps/*/src/domain` is that
  // entry, and what it must and must not classify is the whole of this case.
  test("a monorepo's domain element reaches every project and nothing beside them", async () => {
    const elements = JSON.stringify({
      settings: { "boundaries/elements": [{ type: "domain", pattern: "apps/*/src/domain" }] },
    });
    const workspace = (tree: Tree): Tree => ({ ...repo(tree), ".oxlintrc.json": elements });
    const base = workspace({
      "apps/api/src/domain/pricing.ts": PRICING,
      "apps/api/tests/pricing.test.ts": TOTAL_TEST,
    });

    const reached = await lane([
      base,
      workspace({
        "apps/api/src/domain/pricing.ts": PRICING + WITH_FEE,
        "apps/api/tests/pricing.test.ts": FEE_TEST,
      }),
    ]);
    expect(messages(reached)).toEqual([]);
    expect(reached.note).toBe("mutation score 100.0% over 1 changed domain file");

    const beside = await lane([
      base,
      { ...base, "apps/api/src/lib/format.ts": 'export const dash = (): string => "-";\n' },
    ]);
    expect(beside.note).toEqual(containing("no domain file changed"));
  });

  test.each(["pricing.d.ts", "pricing.test.ts", "pricing.md"])(
    "a changed %s under the domain is not a file to mutate",
    async (name) => {
      const verdict = await lane([
        BEFORE,
        { ...BEFORE, [`src/domain/${name}`]: "export type Cents = number;\n" },
      ]);

      expect(verdict.note).toEqual(containing("no domain file changed"));
    },
  );

  test("a changed domain file that carries no mutants is a pass that says so", async () => {
    const verdict = await lane([
      BEFORE,
      { ...BEFORE, "src/domain/kind.ts": "export interface Kind {\n  readonly name: string;\n}\n" },
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("0 changed domain files held no mutants");
    expect(verdict.table).toBeUndefined();
  });

  test.each([
    ["declares no element", { ...CHANGED, ".oxlintrc.json": "{}" }],
    ["has no oxlint config at all", without(CHANGED, ".oxlintrc.json")],
  ])("a repo that %s is told which element to write", async (_, after) => {
    expect(messages(await lane([BEFORE, after]))).toEqual([
      containing(".oxlintrc.json: declare the pure domain as a boundaries element"),
    ]);
  });

  test("a repo without the runner installed is told which packages to declare", async () => {
    const verdict = await lane([BEFORE, CHANGED], "", false);

    expect(messages(verdict)).toEqual([
      containing("package.json: add @stryker-mutator/core and @hughescr/stryker-bun-runner"),
    ]);
  });

  test("a run that cannot finish reports what it wrote rather than a clean lane", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": `${PRICING}export function broken(: number {\n`,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([containing("to see it: the run exited")]);
    expect(verdict.table).toBeUndefined();
  });

  test("a base ref this checkout does not carry is refused, not read as nothing to mutate", async () => {
    const { root } = await history(BEFORE);
    const verdict = await mutationLane({
      root,
      event: { baseRef: "release", before: "" },
      floor: "",
    });

    expect(messages(verdict)).toEqual([containing("is not in this checkout")]);
  });

  test("a first commit has nothing to compare against and passes", async () => {
    const { root } = await history(BEFORE);
    const verdict = await mutationLane({ root, event: { baseRef: "", before: "" }, floor: "" });

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("no earlier commit"));
  });

  // The line the branch edited sits inside a block it did not write, and the
  // block is a mutant of its own — reported by an overlap rule, not by this
  // one. Two mutants rather than three is the whole of that difference.
  test("a mutant of the block around a changed line belongs to whoever wrote the block", async () => {
    const verdict = await lane([
      repo({ "src/domain/pricing.ts": BRANCHING("100"), "tests/pricing.test.ts": TOTAL_TEST }),
      repo({ "src/domain/pricing.ts": BRANCHING("200"), "tests/pricing.test.ts": TOTAL_TEST }),
    ]);

    expect(messages(verdict)).toEqual([
      containing(
        "write the test that reaches line 3: this branch wrote it and nothing runs it, so `cents * quantity + 200`",
      ),
      containing(
        "write the test that reaches line 3: this branch wrote it and nothing runs it, so `cents / quantity`",
      ),
    ]);
    expect(verdict.table).toEqual(containing("| Undetected on this branch's own lines | 2 |"));
  });

  test("a domain file this branch deleted is not a file to mutate", async () => {
    const verdict = await lane([BEFORE, repo({ "README.md": "# a repo\n" })]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toEqual(containing("no domain file changed"));
  });

  test.each(["75", "-1", "high"])(
    "a floor of '%s' is refused rather than read as a fraction",
    async (floor) => {
      expect(await refusal(floor)).toEqual(containing("write it as a fraction between 0 and 1"));
    },
  );
});
