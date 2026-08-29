import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { BASE, type Case, cases, lines, underBase } from "./lint-fixture.ts";
import { CLEAN, contract } from "./repo-contract-fixture.ts";

const REPO = dirname(import.meta.dir);

/**
 * The rule the base enables everywhere and switches off in two places, which is
 * a third question about every case: a repo's environment is read in `env.ts`
 * and nowhere else, and a suite is where a variable is set rather than where one
 * is read for its value.
 *
 * Most of what is below is the spellings that would otherwise turn it off. The
 * subject is one object under three global names, reachable off `globalThis`,
 * through a `const`, or through an import — and readable as a member, in
 * brackets, by destructuring, by being handed on whole, or written back into.
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
      name: "a destructuring names no property on the object, and a rule watching for one would miss it",
      source: `export const { PORT } = process.env;`,
      reports: ["1:25"],
    },
    {
      name: "handed on whole it is every read the callee makes, at one line the rule has to catch",
      source: `declare function boot(settings: unknown): void;
boot(process.env);`,
      reports: ["2:6"],
    },
    {
      name: "a write is the same class — a variable set where it is read has no owner either",
      source: `process.env["PORT"] = "3000";`,
      reports: ["1:1"],
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
      reports: ["1:10"],
    },
    {
      name: "a property called env on an object of the file's own is not the environment",
      source: `const settings = { env: "production" };
export const stage = settings.env;`,
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
      name: "a key computed from a value has no name to read, and is not guessed at",
      source: `const held = "env";
export const all = process[held];`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** The violating source, in whatever file a scoping case wants it in. */
const VIOLATING = `export const port = process.env["PORT"];\n`;

/** The base as a repo inherits it, with nothing type-aware for a fixture tree to resolve. */
const EXTENDS_BASE = JSON.stringify({ extends: [BASE], options: { typeAware: false } });

/** The violating source at each path, and every diagnostic the base draws over the tree. */
async function underBaseAt(...paths: readonly string[]): Promise<string> {
  const files = Object.fromEntries(paths.map((path) => [path, VIOLATING]));
  return (await lines({ ".oxlintrc.json": EXTENDS_BASE, ...files })).join("\n");
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
  // second env module writes the switch-off and its reason itself, which is a
  // decision a reader can find; a glob forgiving `env.client.ts` is one nobody
  // ever sees.
  test.each(["env.client.ts", "env.server.ts", "src/env/index.ts"])(
    "while %s is an ordinary source file the rule still grades",
    async (path) => {
      expect(await underBaseAt(path)).toContain("anti-slop(no-env-access)");
    },
  );

  // A suite reads the runner's own environment to find a binary, a temp
  // directory or the database it was pointed at, and writes one for the process
  // it spawns. Neither is a repo's configuration, and there is no `env.ts` for
  // it to come from. Per suffix rather than pooled: the base names them one by
  // one, so a suffix left out is a hole a single assertion would report covered.
  test.each([".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"])(
    "and nothing in a %s either",
    async (suffix) => {
      expect((await lines(underBase(suffix, IN_SOURCE))).join("\n")).not.toContain(
        "anti-slop(no-env-access)",
      );
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
  /** The base with the reason directly above the env module's switch-off taken out. */
  function withoutTheReason(): string {
    const written = shipped.split("\n");
    const at = written.findLastIndex((line) => line.trim().startsWith(`"anti-slop/no-env-access"`));
    let first = at;
    while (first > 0 && (written[first - 1] ?? "").trim().startsWith("//")) first -= 1;
    written.splice(first, at - first);
    return written.join("\n");
  }

  // That the base as shipped draws nothing is `oxlint-base.test.ts`'s "carries a
  // reason for every switch-off in it", which grades the whole file and so
  // grades both of these. What is only askable here is the other half over a
  // subject that file has none of: a plugin rule, switched off in an override.
  test("are found by the walker when the reason goes missing", async () => {
    const problems = await contract({ ...CLEAN, ".oxlintrc.json": withoutTheReason() });
    expect(problems.filter((message) => message.includes("turned off"))).toEqual([
      "anti-slop/no-env-access is turned off with no reason — add the reason above the entry",
    ]);
  });
});
