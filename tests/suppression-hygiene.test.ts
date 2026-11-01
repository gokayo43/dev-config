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

async function hygiene(tree: Tree): Promise<string[]> {
  return (await suppressionHygiene(await materialise(tree))).map(
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
    // out of its score, and the one that keeps a clone the duplicate-code gate
    // would refuse. Four spellings, one rule.
    ["Stryker", "// Stryker disable next-line all"],
    ["duplicate-code", "// duplicate-code-allow"],
  ])(
    "a reasonless %s directive is refused, in every spelling any tool honours",
    async (_, line) => {
      expect(await hygiene({ ...CLEAN, "src/index.ts": `${line}\nif (x) {\n}\n` })).toEqual([
        containing("src/index.ts: line 1"),
      ]);
    },
  );

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

  // A directive is a comment, and a string spelling one is data to oxlint as
  // much as to this gate. The wrong implementation scans raw lines, which
  // refuses every suite whose fixtures spell a directive.
  test("a directive spelled inside a string literal is not a suppression", async () => {
    const fixture = 'const fixture = "// oxlint-disable no-console";\n';
    expect(await hygiene({ ...CLEAN, "tests/fixture.test.ts": fixture })).toEqual([]);
  });

  // The reason is what the directive says after its own token. The wrong
  // implementation takes the first ` -- ` on the line, which here is code.
  test("a separator in the code before a directive is not its reason", async () => {
    const line = 'console.log("a -- b"); // oxlint-disable-line no-console\n';
    expect(await hygiene({ ...CLEAN, "src/cli.ts": line })).toEqual([
      containing("src/cli.ts: line 1"),
    ]);
  });

  // A block comment may open on one line and name its directive on the next,
  // which oxlint honours. The wrong implementations read only a comment's
  // first line, which misses it, or report where the comment opens.
  test("a directive on a block comment's second line is refused on that line", async () => {
    const block = "const a = 1;\n/*\n  oxlint-disable no-console\n*/\nconsole.log(a);\n";
    expect(await hygiene({ ...CLEAN, "src/cli.ts": block })).toEqual([
      containing("src/cli.ts: line 3"),
    ]);
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
