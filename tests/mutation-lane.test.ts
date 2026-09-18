import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import manifest from "../package.json";

import type { Verdict } from "../.github/actions/_lib/gate.ts";
import { mutationLane } from "../.github/actions/mutation-lane/mutation-lane.ts";
import { containing } from "./matchers.ts";
import { git, history, type Tree, under, without } from "./tree.ts";

/**
 * Stryker resolves its runner plugin, and `bun test` its own imports, out of
 * the tree it is pointed at — so a fixture repository needs the install a real
 * one has. This repo's own, linked in: the two packages under test are its
 * devDependencies, at the versions its lockfile pins, which is the same install
 * the gate asks a consuming repo for.
 */
const NODE_MODULES = join(import.meta.dir, "..", "node_modules");

// Every case here spawns a real Stryker run over a fixture repository. With the
// machine to itself the slowest takes 3.9s and the rest about 2.1s, against a
// 5s default — so a case is one busy neighbour away from reporting a timeout as
// a fault in the lane. Raised to the same 30s the backfill suite gives a case
// that runs two gates, for the same reason: what a shared machine does to a
// spawn is not a signal about the code under test.
setDefaultTimeout(30_000);

const OXLINTRC = JSON.stringify({
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
function repo(tree: Tree): Tree {
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

/** Reaches the new function and asserts almost nothing about it, so its arithmetic mutant lives. */
const WEAK_FEE_TEST = `import { expect, test } from "bun:test";
import { total, withFee } from "../src/domain/pricing.ts";

test("charges for every unit", () => {
  expect(total(100, 3)).toBe(300);
});

test("adds the fee", () => {
  expect(typeof withFee(100)).toBe("number");
});
`;

/** The same two suites with only the import specifier changed, so the alias is the one variable. */
const ALIASED_TOTAL_TEST = TOTAL_TEST.replace("../src/domain/pricing.ts", "~/domain/pricing.ts");
const ALIASED_FEE_TEST = FEE_TEST.replace("../src/domain/pricing.ts", "~/domain/pricing.ts");

/** A domain file that is all types, so Stryker finds nothing in it to mutate. */
const KIND = `export interface Kind {
  readonly name: string;
}
`;

/** A tagged expression, so a mutant's replacement carries the backticks a code span is made of. */
const TAGGED = "export function tag(cents: number): number {\n  return cents + `x`.length;\n}\n";

/** Stryker's own way of taking a mutant out of the run, carrying the reason every disable here owes. */
const DISABLED = `
// Stryker disable next-line all -- the fee is a product decision, not arithmetic
export const fee = (cents: number): number => cents + 50;
`;

const NOT_DISABLED = `
export const fee = (cents: number): number => cents + 50;
`;

/**
 * A file whose every mutant carries a disable, so the report holds mutants and
 * the ratio holds none of them.
 */
const ALL_DISABLED = `// Stryker disable next-line all -- the fee is a product decision, not arithmetic
export const fee = (cents: number): number => cents + 50;
`;

const FEE_ONLY_TEST = `import { expect, test } from "bun:test";
import { fee } from "../src/domain/pricing.ts";

test("adds the fee", () => {
  expect(fee(100)).toBe(150);
});
`;

/** A change to a domain file that carries no mutants of its own, so every mutant reported is somebody else's. */
const CENTS = "\nexport type Cents = number;\n";

/**
 * A spec beside the unit suite that throws the moment it is loaded — a browser
 * suite whose harness is not `bun test`, which is what the runner's own walk of
 * the tree for `*.test.*` and `*.spec.*` hands `bun test` regardless.
 */
const BROWSER_SPEC = `throw new Error("the browser suite runs under its own harness");

export {};
`;

/** The `bunfig.toml` the lane's diagnostic asks for, and the whole of what it takes to scope the run. */
const SCOPED = `[test]
pathIgnorePatterns = ["e2e/**"]
`;

/** A repository with a browser suite sitting in the tree beside its unit tests. */
function withBrowserSuite(tree: Tree): Tree {
  return repo({ "e2e/pages.spec.ts": BROWSER_SPEC, ...tree });
}

/**
 * A module-level guard, the shape a domain file gives a constant it cannot work
 * without. The mutants that make it hold throw on import, so they break every
 * test before one runs: static, and the one ungraded mutant nothing could have
 * caught.
 */
const GUARD = `const RATE = 21;
if (RATE < 0) throw new RangeError("the rate is a percentage");
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

interface Run {
  readonly floor?: string;
  /** Whether the fixture has the install a repo running this lane declares. */
  readonly installed?: boolean;
  /** Settings written into the checkout's own config, the way a developer's `~/.gitconfig` would arrive. */
  readonly configured?: readonly (readonly [string, string])[];
}

async function lane(
  trees: readonly Tree[],
  { floor = "", installed = true, configured = [] }: Run = {},
): Promise<Verdict> {
  return (await laneIn(trees, { floor, installed, configured })).verdict;
}

/** The same run, with the checkout it worked in — for a case about what it left there. */
async function laneIn(
  trees: readonly Tree[],
  { floor = "", installed = true, configured = [] }: Run = {},
): Promise<{ verdict: Verdict; root: string }> {
  const { root } = await history(...trees);
  if (installed) await symlink(NODE_MODULES, join(root, "node_modules"));
  for (const [name, value] of configured) await git(root, ["config", "--local", name, value]);
  return { verdict: await mutationLane({ root, event: { baseRef: "", before: "" }, floor }), root };
}

function messages({ problems }: Verdict): string[] {
  return problems.map(({ file, message }) => `${file ?? ""}: ${message}`);
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

  // The other undetected status, and the one the diagnostic reads differently:
  // a test does reach the line, and passes whatever the arithmetic on it says.
  // Every other case here produces NoCoverage, so without this one the arm that
  // addresses a reader who already has a test is never executed.
  // Everything this lane knows about a branch it reads out of `git diff` text,
  // and every setting below rewrites that text. They are the ones a developer
  // turns on for themselves and forgets, and they arrive in a checkout's own
  // config exactly as they arrive from a `~/.gitconfig` — so the gate answers
  // the same under them or it does not answer at all. `color.ui` is the one
  // that matters most: escape codes stop `diff --git ` from starting a line,
  // and a lane that finds no changed domain file reports a clean run.
  test.each([
    ["colour forced on", [["color.ui", "always"]] as const],
    ["the diff prefixes dropped", [["diff.noprefix", "true"]] as const],
    ["mnemonic prefixes", [["diff.mnemonicPrefix", "true"]] as const],
    [
      "all of them at once",
      [
        ["color.ui", "always"],
        ["diff.noprefix", "true"],
        ["diff.mnemonicPrefix", "true"],
      ] as const,
    ],
  ])(
    "a checkout configured with %s grades the same branch the same way",
    async (_name, configured) => {
      const verdict = await lane(
        [
          BEFORE,
          repo({
            "src/domain/pricing.ts": PRICING + WITH_FEE,
            "tests/pricing.test.ts": WEAK_FEE_TEST,
          }),
        ],
        { configured },
      );

      expect(messages(verdict)).toEqual([
        "src/domain/pricing.ts: write the case that fails on `cents - 50` (ArithmeticOperator) at line 6: this branch wrote that line and the suite passes either way",
      ]);
    },
  );

  test("a new line a test reaches without pinning is refused as a survivor", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": WEAK_FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([
      "src/domain/pricing.ts: write the case that fails on `cents - 50` (ArithmeticOperator) at line 6: this branch wrote that line and the suite passes either way",
    ]);
    expect(verdict.note).toBe("mutation score 75.0% over 1 changed domain file");
    expect(verdict.table).toEqual(
      containing("- `src/domain/pricing.ts:6` ArithmeticOperator → `cents - 50` (Survived)"),
    );
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
      { floor: "0.95" },
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

  // docs/gates/mutation-lane.md says a monorepo may declare one element per
  // project. `apps/web/src/domain/` also carries the trailing slash a folder is
  // often written with, which the lane trims before handing git the pathspec —
  // untrimmed it would ask for `apps/web/src/domain//**` and match nothing,
  // which is the shape a gate takes when it silently stops gating.
  test.each(["api", "web"])(
    "a domain element per project reaches the %s project",
    async (project) => {
      const elements = JSON.stringify({
        settings: {
          "boundaries/elements": [
            { type: "domain", pattern: "apps/api/src/domain" },
            { type: "domain", pattern: "apps/web/src/domain/" },
          ],
        },
      });
      const workspace = (tree: Tree): Tree => ({ ...repo(tree), ".oxlintrc.json": elements });
      const source = `apps/${project}/src/domain/pricing.ts`;
      const suite = `apps/${project}/tests/pricing.test.ts`;

      const verdict = await lane([
        workspace({ [source]: PRICING, [suite]: TOTAL_TEST }),
        workspace({ [source]: PRICING + WITH_FEE, [suite]: FEE_TEST }),
      ]);

      expect(messages(verdict)).toEqual([]);
      expect(verdict.note).toBe("mutation score 100.0% over 1 changed domain file");
    },
  );

  // The count is the change, not the report: Stryker lists only files it found
  // something to mutate in, so a branch touching a file of types alongside a
  // real one would otherwise be told it changed one file fewer than it did.
  test("a file the run found nothing to mutate in is still a file this branch changed", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "src/domain/kind.ts": KIND,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 100.0% over 2 changed domain files");
  });

  // THE CLASS these four cases belong to: a filename crosses three name-spaces
  // on its way through the lane — git's diff output, the filesystem under the
  // root, Stryker's glob resolver — and a file that goes missing between two of
  // them has no mutants, which reads as a branch with nothing wrong. Each case
  // drops a file out of one crossing and asserts the lane says so.

  test.each([
    ["names a file rather than a folder", "src/domain/pricing.ts", "names a file"],
    ["reaches nothing at all", "src/nowhere", "nothing here is under"],
  ])("a domain pattern that %s is refused", async (_, pattern, said) => {
    const declared = JSON.stringify({
      settings: { "boundaries/elements": [{ type: "domain", pattern }] },
    });
    const verdict = await lane([BEFORE, { ...CHANGED, ".oxlintrc.json": declared }]);

    expect(messages(verdict)).toEqual([containing(said)]);
  });

  // Stryker resolves every `mutate` entry as a glob, and this is the filename
  // every router in this house produces. Unescaped it resolves to nothing, and
  // a file nothing mutated has no mutants — the class, in the crossing into
  // Stryker.
  test("a domain file whose name is a glob pattern is still mutated", async () => {
    const verdict = await lane([BEFORE, { ...BEFORE, "src/domain/[id].ts": WITH_FEE.trimStart() }]);

    expect(messages(verdict)).toEqual([
      containing("src/domain/[id].ts: write the test that reaches line 1"),
      containing("src/domain/[id].ts: write the test that reaches line 2"),
    ]);
  });

  // The residue of the same crossing: three characters have no working escape,
  // so the lane reads Stryker's own report of what it could not resolve rather
  // than trusting the escape to have covered everything.
  test("a domain file Stryker cannot resolve is named rather than passed over", async () => {
    const verdict = await lane([
      BEFORE,
      { ...BEFORE, "src/domain/{a,b}.ts": WITH_FEE.trimStart() },
    ]);

    expect(messages(verdict)).toEqual([
      containing("rename src/domain/{a,b}.ts so its name carries no glob character"),
    ]);
    expect(verdict.note).toBe("a changed file never reached the run");
  });

  // The crossing out of git: a path holding a control character is C-quoted in
  // the diff header, so the `+++ b/` line never matches and the file left the
  // change set without a word.
  test("a changed file git could not name plainly is refused", async () => {
    const quoted = "src/domain/o\td.ts";
    const verdict = await lane([BEFORE, { ...BEFORE, [quoted]: WITH_FEE.trimStart() }]);

    expect(messages(verdict)).toEqual([containing("so git can name it plainly")]);
    expect(verdict.note).toBe("a changed file could not be named");
  });

  // The crossing into the filesystem: `git diff` answers in paths from the
  // repository root, and a project below it — every monorepo — would hand
  // Stryker a path it cannot resolve from the project.
  test("a project below the git root is graded against its own paths", async () => {
    const { root } = await history(
      { ".gitignore": "node_modules\n", ...under("app", BEFORE) },
      {
        ".gitignore": "node_modules\n",
        ...under(
          "app",
          repo({
            "src/domain/pricing.ts": PRICING + WITH_FEE,
            "tests/pricing.test.ts": FEE_TEST,
          }),
        ),
      },
    );
    await symlink(NODE_MODULES, join(root, "app", "node_modules"));
    const verdict = await mutationLane({
      root: join(root, "app"),
      event: { baseRef: "", before: "" },
      floor: "",
    });

    // The project's own path, not `app/src/domain/pricing.ts`: the second is
    // what the repository root would have called it, and what Stryker could not
    // have resolved from inside the project.
    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 100.0% over 1 changed domain file");
    expect(verdict.table).toEqual(containing("| Undetected | 0 |"));
  });

  // `Ignored` leaves BOTH sides of the ratio, so before this rule a branch that
  // wrote an untested line and disabled it scored HIGHER than one that only
  // wrote it — 100% against 50% — and cleared a floor it should have breached.
  // On a line the branch wrote, the directive is the branch's own choice.
  test("a Stryker disable on a new line cannot raise the score", async () => {
    const disabled = await lane([
      BEFORE,
      repo({ "src/domain/pricing.ts": PRICING + DISABLED, "tests/pricing.test.ts": TOTAL_TEST }),
    ]);
    const plain = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + NOT_DISABLED,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    expect(disabled.note).toBe(plain.note);
    expect(disabled.note).toBe("mutation score 50.0% over 1 changed domain file");
    expect(messages(disabled)).toEqual([
      containing("write the test for line 6 or drop the `Stryker disable` above it"),
      containing("write the test for line 6 or drop the `Stryker disable` above it"),
    ]);
  });

  // eslint-plugin-boundaries takes `pattern` as a string or an array of them,
  // so a repo mixing the two forms is one the linter gates whole. Reading only
  // the string form gated half of it and said nothing about the other half.
  test("a domain element whose pattern is an array is read as the linter reads it", async () => {
    const mixed = JSON.stringify({
      settings: {
        "boundaries/elements": [
          { type: "domain", pattern: "apps/api/src/domain" },
          { type: "domain", pattern: ["apps/web/src/domain"] },
        ],
      },
    });
    const workspace = (tree: Tree): Tree => ({ ...repo(tree), ".oxlintrc.json": mixed });
    const both = {
      "apps/api/src/domain/pricing.ts": PRICING,
      "apps/api/tests/pricing.test.ts": TOTAL_TEST,
      "apps/web/src/domain/pricing.ts": PRICING,
      "apps/web/tests/pricing.test.ts": TOTAL_TEST,
    };

    // The branch's only domain change is in the project declared as an array.
    const verdict = await lane([
      workspace(both),
      workspace({ ...both, "apps/web/src/domain/pricing.ts": PRICING + WITH_FEE }),
    ]);

    expect(verdict.note).toBe("mutation score 50.0% over 1 changed domain file");
    expect(messages(verdict)).toEqual([
      containing("apps/web/src/domain/pricing.ts: write the test that reaches line 5"),
      containing("apps/web/src/domain/pricing.ts: write the test that reaches line 6"),
    ]);
  });

  // The summary is markdown, and a replacement is repo source: every template
  // literal in the tree carries the backticks a code span is delimited by.
  test("a replacement carrying backticks cannot end the span it is shown in", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": PRICING + "\n" + TAGGED,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    expect(verdict.table).toEqual(containing("``cents - `x`.length``"));
    expect(verdict.table).not.toEqual(containing("→ `cents - `x`.length` ("));
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
    const verdict = await lane([BEFORE, { ...BEFORE, "src/domain/kind.ts": KIND }]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("1 changed domain file held no mutants");
    expect(verdict.table).toBeUndefined();
  });

  test("a repo whose config names no domain is told which element to write", async () => {
    expect(messages(await lane([BEFORE, { ...CHANGED, ".oxlintrc.json": "{}" }]))).toEqual([
      containing(".oxlintrc.json: declare the pure domain as a boundaries element"),
    ]);
  });

  // Not this gate's diagnostic to write: the repo contract already grades that
  // file, and a second gate paraphrasing it is a second thing to keep true.
  test("a repo with no oxlint config at all gets the answer that file's reader gives", async () => {
    expect(messages(await lane([BEFORE, without(CHANGED, ".oxlintrc.json")]))).toEqual([
      ".oxlintrc.json: .oxlintrc.json is missing",
    ]);
  });

  // Read back out of this repo's manifest rather than written out here, because
  // the versions the diagnostic names are a claim about an install: the one the
  // suite symlinks in, and so the only pair the lane is ever run against. A bump
  // that leaves the diagnostic behind sends every consuming repo to a version
  // this lane never ran, and it fails here instead.
  test("a repo without the runner installed is told which packages to declare", async () => {
    const pins = manifest.devDependencies;
    const verdict = await lane([BEFORE, CHANGED], { installed: false });

    expect(messages(verdict)).toEqual([
      `package.json: add @stryker-mutator/core@${pins["@stryker-mutator/core"]} and @hughescr/stryker-bun-runner@${pins["@hughescr/stryker-bun-runner"]} to devDependencies — the lane runs the repo's own install, so those are the versions it runs`,
    ]);
  });

  // The lane names no tsconfig, so Stryker's sandbox keeps the repo's own
  // unrewritten — the rewrite goes through `ts.parseConfigFileTextToJson`,
  // which the native TypeScript 7 port does not export. This fixture's suite
  // reaches its domain file ONLY through a `paths` alias, so a sandbox copy
  // `bun test` could not resolve against grades nothing: the score below is
  // what proves the copy is enough.
  test("a repo whose suite reaches its domain through tsconfig paths is graded", async () => {
    const aliased = (tree: Tree): Tree => ({
      ...repo(tree),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { types: ["bun"], paths: { "~/*": ["./src/*"] } },
        include: ["src/**/*.ts", "tests/**/*.ts"],
      }),
    });

    const verdict = await lane([
      aliased({ "src/domain/pricing.ts": PRICING, "tests/pricing.test.ts": ALIASED_TOTAL_TEST }),
      aliased({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": ALIASED_FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 100.0% over 1 changed domain file");
  });

  // Stryker copies the project into a sandbox to mutate it, and its default
  // puts that copy in the checkout and cleans it only after a run that
  // finished — so every crash left a second tree of the repo's own source for
  // the steps after this one to lint, scan and count.
  test.each([
    ["that cannot finish", `${PRICING}export function broken(: number {\n`],
    ["that finishes", PRICING + WITH_FEE],
  ])("a run %s leaves nothing in the checkout", async (_, source) => {
    const { root } = await laneIn([
      BEFORE,
      repo({ "src/domain/pricing.ts": source, "tests/pricing.test.ts": FEE_TEST }),
    ]);

    expect(await readdir(root)).not.toContain(".stryker-tmp");
    expect(await readdir(root)).not.toContain("reports");
  });

  test("a run that cannot finish reports what it wrote rather than a clean lane", async () => {
    const verdict = await lane([
      BEFORE,
      repo({
        "src/domain/pricing.ts": `${PRICING}export function broken(: number {\n`,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([containing("fix what the run reported above")]);
    expect(verdict.log).toEqual(containing("Stryker"));
    expect(verdict.table).toBeUndefined();
  });

  // THE CLASS these five cases belong to, and the one the four above cannot
  // reach: a run that finishes, exits 0 and writes a report in which nothing was
  // graded. Stryker's own reading of an errored mutant is "outside the ratio",
  // so before this rule the lane scored the run over the empty set, said "held no
  // mutants" and passed — a false statement and a green gate. Measured on
  // fec-program: 121 of 121 mutants `RuntimeError`, Stryker exit 0, because two
  // Playwright specs in the tree throw the moment `bun test` loads them.

  test("a suite the run cannot load fails the lane rather than passing with nothing graded", async () => {
    const verdict = await lane([
      withBrowserSuite({ "src/domain/pricing.ts": PRICING, "tests/pricing.test.ts": TOTAL_TEST }),
      withBrowserSuite({
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    // One problem for the class, not one per mutant: four here, eighty-six on
    // fec, and every one of them the same finding.
    const [only] = messages(verdict);
    expect(messages(verdict)).toHaveLength(1);
    expect(only).toEqual(containing("4 mutants in 1 file came back with no verdict"));
    // The only thing in the report that names what would not load.
    expect(only).toEqual(containing("e2e/pages.spec.ts"));
    expect(only).toEqual(containing("`[test] pathIgnorePatterns`"));
    // No score at all, rather than one computed over the mutants that did get a
    // verdict — which here is none of them.
    expect(verdict.note).toBe("part of the run over 1 changed domain file was never graded");
    expect(verdict.table).toBeUndefined();
  });

  test("the same repo grades normally once bunfig keeps that spec out of the run", async () => {
    const verdict = await lane([
      withBrowserSuite({
        "bunfig.toml": SCOPED,
        "src/domain/pricing.ts": PRICING,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
      withBrowserSuite({
        "bunfig.toml": SCOPED,
        "src/domain/pricing.ts": PRICING + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 100.0% over 1 changed domain file");
    expect(verdict.table).toEqual(containing("| Not graded | 0 |"));
  });

  // The exemption, and the whole of it: a mutant that runs at module load breaks
  // every test before one runs, so there is no test anyone could write and a
  // `Stryker disable` would count here as a mutant nothing caught — failing the
  // branch on one would be a red with no exit. Measured on tcs-pricing-engine,
  // where `src/money.ts` carries seven of them.
  test("a mutant that throws on import is outside the ratio and counted in the summary", async () => {
    const verdict = await lane([
      repo({
        "src/domain/pricing.ts": GUARD + PRICING,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
      repo({
        "src/domain/pricing.ts": GUARD + PRICING + WITH_FEE,
        "tests/pricing.test.ts": FEE_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe("mutation score 57.1% over 1 changed domain file");
    // Visible rather than silent: the count is why the ratio is over seven
    // mutants and the file holds nine.
    expect(verdict.table).toEqual(containing("| Not graded | 2 |"));
  });

  // Blame is what the containment rule decides, and this is not a question of
  // blame: the score published is over a partial set whoever wrote the lines the
  // ungraded mutants sit on. Here the branch's own change carries no mutant at
  // all, so a lane checking only its own lines finds nothing and passes.
  test("ungraded mutants outside this branch's own lines still fail it", async () => {
    const verdict = await lane([
      withBrowserSuite({ "src/domain/pricing.ts": PRICING, "tests/pricing.test.ts": TOTAL_TEST }),
      withBrowserSuite({
        "src/domain/pricing.ts": PRICING + CENTS,
        "tests/pricing.test.ts": TOTAL_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([
      containing("2 mutants in 1 file came back with no verdict"),
    ]);
  });

  // "Held no mutants" is a statement about the report, and this report holds
  // two. Said of one that merely scored none of them, it sends the reader to
  // write tests for a file whose mutants are all disabled.
  test("a report whose mutants all left the ratio is not called a report with none", async () => {
    const verdict = await lane([
      repo({ "src/domain/pricing.ts": ALL_DISABLED, "tests/pricing.test.ts": FEE_ONLY_TEST }),
      repo({
        "src/domain/pricing.ts": ALL_DISABLED + CENTS,
        "tests/pricing.test.ts": FEE_ONLY_TEST,
      }),
    ]);

    expect(messages(verdict)).toEqual([]);
    expect(verdict.note).toBe(
      "no mutant in 1 changed domain file counted toward a score: 0 not graded, 2 outside the ratio",
    );
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
      const { root } = await history(BEFORE);
      expect(mutationLane({ root, event: { baseRef: "", before: "" }, floor })).rejects.toThrow(
        "write it as a fraction between 0 and 1",
      );
    },
  );
});
