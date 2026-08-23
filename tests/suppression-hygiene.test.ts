import { describe, expect, test } from "bun:test";

import { suppressionHygiene } from "../.github/actions/suppression-hygiene/suppression-hygiene.ts";
import { materialise, type Tree } from "./tree.ts";
import { containing } from "./matchers.ts";

const REASONED =
  "// oxlint-disable-next-line typescript/no-unnecessary-condition -- typed from the schema, arrives unvalidated over the wire";

const CLEAN: Tree = {
  ".gitignore": "node_modules\ndist\n",
  "src/index.ts": `${REASONED}\nif (payload.items) {\n}\n`,
  "README.md": "# A repo\n",
};

async function hygiene(tree: Tree, fixtures: readonly string[] = []): Promise<string[]> {
  const root = await materialise(tree);
  return (await suppressionHygiene({ root, fixtures })).map(
    ({ file, message }) => `${file ?? ""}: ${message}`,
  );
}

describe("suppression hygiene", () => {
  test("a directive that says why it is there passes", async () => {
    expect(await hygiene(CLEAN)).toEqual([]);
  });

  // The separator alone is not a reason. A gate testing for the marker rather
  // than for what follows it accepts a directive that tells the next reader
  // exactly what no comment at all would — the same empty waiver
  // `allowlistFrom` already refuses in the other dialect a reason is written in.
  test.each([
    ["nothing after it", "// oxlint-disable-next-line no-empty -- "],
    ["only spaces after it", "// oxlint-disable-next-line no-empty --    "],
  ])("a directive with the separator and %s is refused", async (_what, line) => {
    expect(await hygiene({ ...CLEAN, "src/index.ts": `${line}\nif (x) {\n}\n` })).toEqual([
      containing("src/index.ts: line 1"),
    ]);
  });

  test.each([
    ["oxlint", "// oxlint-disable-next-line typescript/no-unnecessary-condition"],
    ["eslint", "// eslint-disable-next-line no-empty"],
    // Stryker's own, which takes a mutant out of the mutation lane's run and
    // out of its score. Three tools, one rule.
    ["Stryker", "// Stryker disable next-line all"],
  ])("a reasonless %s directive is refused — oxlint honours both spellings", async (_, line) => {
    expect(await hygiene({ ...CLEAN, "src/index.ts": `${line}\nif (x) {\n}\n` })).toEqual([
      containing("src/index.ts: line 1"),
    ]);
  });

  test.each([
    "/* oxlint-disable no-console */",
    "/* eslint-disable no-console */",
    "// oxlint-disable-line no-console",
    "// eslint-disable-line no-console",
  ])("%s is held to the same rule", async (line) => {
    expect(await hygiene({ ...CLEAN, "src/cli.ts": `${line}\nconsole.log("hi");\n` })).toEqual([
      containing("src/cli.ts: line 1"),
    ]);
  });

  test("a Stryker restore is not a suppression and owes nothing", async () => {
    const restored = "// Stryker restore all";
    expect(await hygiene({ ...CLEAN, "src/cli.ts": `${restored}\nconst x = 1;\n` })).toEqual([]);
  });

  test("either spelling passes once it carries a reason", async () => {
    const reasoned = "// eslint-disable-next-line no-empty -- the parse failure is the answer";
    expect(await hygiene({ ...CLEAN, "src/cli.ts": `${reasoned}\ntry {} catch {}\n` })).toEqual([]);
  });

  test("prose that happens to mention a directive is not code", async () => {
    expect(
      await hygiene({ ...CLEAN, "docs/style.md": "An `oxlint-disable` needs a reason.\n" }),
    ).toEqual([]);
  });

  test("an ignored build output is not read", async () => {
    expect(await hygiene({ ...CLEAN, "dist/bundle.js": "// oxlint-disable no-console\n" })).toEqual(
      [],
    );
  });

  test("a named fixture file is the one place a bare directive is text, not a suppression", async () => {
    const tree = { ...CLEAN, "tests/hygiene.test.ts": "// oxlint-disable no-console\n" };
    expect(await hygiene(tree)).toEqual([containing("tests/hygiene.test.ts")]);
    expect(await hygiene(tree, ["tests/hygiene.test.ts"])).toEqual([]);
  });

  test.each(["TODO.md", "BACKLOG.md", "TASKS.md", "ISSUES.md", "ROADMAP.md"])(
    "%s is a second register and is refused",
    async (name) => {
      expect(await hygiene({ ...CLEAN, [name]: "- ship the thing\n" })).toEqual([
        containing("second register"),
      ]);
    },
  );

  test("a register file in a subdirectory is refused too", async () => {
    expect(await hygiene({ ...CLEAN, "docs/TODO.md": "- later\n" })).toEqual([
      containing("docs/TODO.md"),
    ]);
  });
});
