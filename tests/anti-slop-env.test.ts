import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { baseConfig, type Case, cases, lines, underBase } from "./lint-fixture.ts";
import { CLEAN, contract, withoutReasonFor } from "./repo-contract-fixture.ts";

const REPO = dirname(import.meta.dir);

/**
 * The rule the base enables everywhere and switches off in two places, which is
 * a third question about every case: a repo's environment is read in `env.ts`
 * and nowhere else, and a suite is where a variable is set rather than where one
 * is read for its value.
 *
 * Most of what is below is the spellings that would otherwise turn it off. The
 * subject is one object under three global names — each of those reachable off
 * any of the global object's four — through a `const`, a static import, a
 * dynamic import, or a re-export; and readable as a member, in brackets, in a
 * template, by destructuring the object OR the holder, by being handed on whole,
 * or written back into.
 */
const IN_SOURCE = {
  "no-env-access": [
    {
      name: "the member read every default is written on",
      source: `export const port = process.env.PORT;`,
      reports: ["1:21"],
    },
    {
      name: "in brackets it is the same read — a rule reading only `a.b` is one keystroke from off",
      source: `export const port = process.env["PORT"];`,
      reports: ["1:21"],
    },
    {
      name: "and in a template with nothing in it, which is a spelling rather than a computation",
      source: `export const port = process[\`env\`]["PORT"];`,
      reports: ["1:21"],
    },
    {
      name: "a destructuring names no property on the object, and a rule watching for one would miss it",
      source: `export const { PORT } = process.env;`,
      reports: ["1:25"],
    },
    {
      name: "destructuring the HOLDER leaves no member expression at all — the shape that silenced this rule",
      source: `const { env } = process;
export const port = env["PORT"];`,
      reports: ["1:9"],
    },
    {
      name: "renamed on the way out it is the same property — the key says which, never the binding",
      source: `const { env: settings } = Bun;
export const port = settings["PORT"];`,
      reports: ["1:9"],
    },
    {
      name: "and off import.meta, which is a holder with no binding to resolve",
      source: `const { env: bundled } = import.meta;
export const mode = bundled["MODE"];`,
      reports: ["1:9"],
    },
    {
      name: "the holder destructured off a default import, which resolves to no global",
      source: `import runtime from "node:process";
const { env } = runtime;
export const port = env["PORT"];`,
      reports: ["2:9"],
    },
    {
      name: "and off a namespace import, which is the same module under a third spelling",
      source: `import * as runtime from "node:process";
const { env } = runtime;
export const port = env["PORT"];`,
      reports: ["2:9"],
    },
    {
      name: "handed on whole it is every read the callee makes, at one line the rule has to catch",
      source: `declare function boot(settings: unknown): void;
boot(process.env);`,
      reports: ["2:6"],
    },
    {
      name: "a write says something else than a read does, and says it in its own message",
      source: `process.env["PORT"] = "3000";`,
      reports: ["1:1: error anti-slop(no-env-access): Set process.env"],
    },
    {
      name: "so does deleting one, which is a write to the same slot",
      source: `delete process.env["PORT"];`,
      reports: ["1:8: error anti-slop(no-env-access): Set process.env"],
    },
    {
      name: "Bun's is a second object over the same variables, not an alias a rule can skip",
      source: `export const port = Bun.env["PORT"];`,
      reports: ["1:21"],
    },
    {
      name: "and the bundler's is a third, reached through no binding at all",
      source: `export const mode = import.meta.env.MODE;`,
      reports: ["1:21"],
    },
    {
      name: "off globalThis it is the same object reached the long way round",
      source: `export const port = globalThis.process.env["PORT"];`,
      reports: ["1:21"],
    },
    {
      name: "and off the global object's other three names, which a rule knowing one is silent on",
      source: `export const a = global.process.env["A"];
export const b = window.process.env["B"];
export const c = self.process.env["C"];`,
      reports: ["1:18", "2:18", "3:18"],
    },
    {
      name: "a const given the holder once carries it, under a name with no `process` in it",
      source: `const runtime = process;
export const port = runtime.env["PORT"];`,
      reports: ["2:21"],
    },
    {
      name: "imported rather than global is the same object under a name the file chose",
      source: `import runtime from "node:process";
export const port = runtime.env["PORT"];`,
      reports: ["2:21"],
    },
    {
      name: "the named import forms no member expression, so it is reported at the import instead",
      source: `import { env } from "node:process";
export const port = env["PORT"];`,
      reports: ["1:10: error anti-slop(no-env-access): Import the parsed value"],
    },
    {
      name: "a dynamic import is the same module fetched later, and a `const` holds the same object",
      source: `export const port = (await import("node:process")).env["PORT"];
const runtime = await import("node:process");
export const home = runtime.env["HOME"];`,
      reports: ["1:21", "3:21"],
    },
    {
      name: "re-exporting env launders it past both ends — this is the end that can still tell",
      source: `export { env } from "node:process";`,
      reports: ["1:10: error anti-slop(no-env-access): Import the parsed value"],
    },
    {
      name: "re-exporting the holder hands the far side the same object one specifier out",
      source: `export { default as runtime } from "node:process";`,
      reports: ["1:10"],
    },
    {
      name: "and a star re-export carries env by definition",
      source: `export * from "node:process";`,
      reports: ["1:1"],
    },
    {
      name: "a re-export of something else from the same module is not laundering, and is left alone",
      source: `export { cwd } from "node:process";`,
      reports: [],
    },
    {
      name: "a property called env on an object of the file's own is not the environment",
      source: `const settings = { env: "production" };
export const stage = settings.env;`,
      reports: [],
    },
    {
      name: "nor is destructuring one off it",
      source: `const settings = { env: "production" };
export const { env } = settings;`,
      reports: [],
    },
    {
      name: "a local named process shadows the global and is something else entirely",
      source: `export function read(process: { env: string }): string {
  return process.env;
}`,
      reports: [],
    },
    {
      name: "another property of the holder is not the environment",
      source: `const { argv } = process;
export const first = argv[0];`,
      reports: [],
    },
    {
      name: "a key computed from a value has no name to read, and is not guessed at",
      source: `const held = "env";
export const all = process[held];`,
      reports: [],
    },
    {
      name: "a template with a substitution in it is a computation again, and is not guessed at either",
      source: `const middle = "n";
export const all = process[\`e\${middle}v\`];`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** The violating source, in whatever file a scoping case wants it in. */
const VIOLATING = `export const port = process.env["PORT"];\n`;

/** The violating source at each path, and every diagnostic the base draws over the tree. */
async function underBaseAt(...paths: readonly string[]): Promise<string> {
  const files = Object.fromEntries(paths.map((path) => [path, VIOLATING]));
  return (await lines({ ".oxlintrc.json": baseConfig(), ...files })).join("\n");
}

describe("no-env-access", () => {
  for (const [rule, list] of Object.entries(IN_SOURCE)) cases(rule, list);

  test("the base enables it in an ordinary source file", async () => {
    expect((await lines(underBase(".ts", IN_SOURCE))).join("\n")).toContain(
      "anti-slop(no-env-access)",
    );
  });

  // The half that makes the rule sayable at all. `env.ts` is the module the
  // whole convention points at, and a rule that fired in it would be a rule
  // every repo turned off at the top level instead.
  test.each(["env.ts", "src/env.ts", "src/server/config/env.ts"])(
    "and says nothing in %s, wherever it sits",
    async (path) => {
      expect(await underBaseAt(path)).not.toContain("anti-slop(no-env-access)");
    },
  );

  // The glob is `**/env.ts` and deliberately nothing wider. A repo that needs a
  // second env module writes the switch-off and its reason in its own config,
  // which is a decision a reader can find; a glob forgiving `env.client.ts` is
  // one nobody ever sees.
  test.each(["env.client.ts", "env.server.ts", "src/env/index.ts"])(
    "while %s is an ordinary source file the rule still grades",
    async (path) => {
      expect(await underBaseAt(path)).toContain("anti-slop(no-env-access)");
    },
  );

  // A suite reads the runner's own environment to find a binary, a temp
  // directory or the database it was pointed at, and writes one for the process
  // it spawns. Its helpers are that same code one file over and carry no
  // suffix, which is the half a list of suffixes leaves failing.
  test.each([
    "case.test.ts",
    "case.spec.ts",
    "case.test.tsx",
    "case.spec.tsx",
    "tests/harness.ts",
    "tests/fixtures/migrator.ts",
    "packages/api/tests/spawn.ts",
    "e2e/flow.ts",
  ])("and nothing in %s, which is a suite or a suite's helper", async (path) => {
    expect(await underBaseAt(path)).not.toContain("anti-slop(no-env-access)");
  });

  // And the other side of that line: a directory is forgiven, a name that
  // merely reads like one is not.
  test.each(["src/app.ts", "test-utils.ts", "src/testing/spawn.ts"])(
    "while %s is ordinary source the rule still grades",
    async (path) => {
      expect(await underBaseAt(path)).toContain("anti-slop(no-env-access)");
    },
  );
});

const shipped = await Bun.file(join(REPO, "oxlint.base.json")).text();

/**
 * The base switches this rule off twice, and a repo needing a second env module
 * switches it off a third time in its own config — so the contract's off-reason
 * walker has to see a plugin rule in an `overrides` block exactly as it sees one
 * of oxlint's at the top level. It reads the path it is inside rather than the
 * name it finds there (`SWITCHES` in `repo-contract.ts`), and the case below is
 * that claim turned into a run.
 */
describe("the switch-offs the base carries for it", () => {
  // That the base as shipped draws nothing is `oxlint-base.test.ts`'s "carries a
  // reason for every switch-off in it", which grades the whole file and so
  // grades both of these. What is only askable here is the other half over a
  // subject that file has none of: a plugin rule, switched off in an override.
  test.each(["**/env.ts", "**/tests/**"])(
    "the one under %s is found by the walker when its reason goes missing",
    async (glob) => {
      const problems = await contract({
        ...CLEAN,
        ".oxlintrc.json": withoutReasonFor(shipped, "anti-slop/no-env-access", glob),
      });
      expect(problems.filter((message) => message.includes("turned off"))).toEqual([
        "anti-slop/no-env-access is turned off with no reason — add the reason above the entry",
      ]);
    },
  );
});
