import { afterEach, describe, expect, test } from "bun:test";

import { suppressionHygiene } from "../.github/actions/suppression-hygiene/suppression-hygiene.ts";
import { discard, materialise, type Tree } from "./tree.ts";

const REASONED = [
  "// oxlint-disable-next-line typescript/no-unnecessary-condition",
  " -- typed from the schema, arrives unvalidated over the wire",
].join("");

const CLEAN: Tree = {
  ".gitignore": "node_modules\ndist\n",
  "src/index.ts": `${REASONED}\nif (payload.items) {\n}\n`,
  "README.md": "# A repo\n",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(discard));
});

async function hygiene(tree: Tree): Promise<string[]> {
  const root = await materialise(tree);
  roots.push(root);
  return (await suppressionHygiene(root)).map(({ file, message }) => `${file ?? ""}: ${message}`);
}

describe("suppression hygiene", () => {
  test("a directive that says why it is there passes", async () => {
    expect(await hygiene(CLEAN)).toEqual([]);
  });

  test("a directive with no reason is refused", async () => {
    const bare = ["// oxlint-disable-next-line typescript/no-unnecessary-condition"].join("");
    expect(await hygiene({ ...CLEAN, "src/index.ts": `${bare}\nif (payload.items) {\n}\n` })).toEqual([
      expect.stringContaining("src/index.ts: line 1"),
    ]);
  });

  test("a whole-file directive is held to the same rule", async () => {
    const bare = ["/* oxlint-disable no-console */"].join("");
    expect(await hygiene({ ...CLEAN, "src/cli.ts": `${bare}\nconsole.log("hi");\n` })).toEqual([
      expect.stringContaining("src/cli.ts: line 1"),
    ]);
  });

  test("prose that happens to mention the directive is not code", async () => {
    const prose = ["An `oxlint", "-disable` needs a reason.\n"].join("");
    expect(await hygiene({ ...CLEAN, "docs/style.md": prose })).toEqual([]);
  });

  test("an ignored build output is not read", async () => {
    const bare = ["// oxlint-disable no-console"].join("");
    expect(await hygiene({ ...CLEAN, "dist/bundle.js": `${bare}\n` })).toEqual([]);
  });

  test.each(["TODO.md", "BACKLOG.md", "TASKS.md", "ISSUES.md", "ROADMAP.md"])(
    "%s is a second register and is refused",
    async (name) => {
      expect(await hygiene({ ...CLEAN, [name]: "- ship the thing\n" })).toEqual([
        expect.stringContaining("second register"),
      ]);
    },
  );

  test("a register file in a subdirectory is refused too", async () => {
    expect(await hygiene({ ...CLEAN, "docs/TODO.md": "- later\n" })).toEqual([
      expect.stringContaining("docs/TODO.md"),
    ]);
  });
});
