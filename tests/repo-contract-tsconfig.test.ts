import { describe, expect, test } from "bun:test";

import { record } from "../.github/actions/_lib/gate.ts";
import { repoContract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import { CLEAN, contract, DEFAULTS } from "./repo-contract-fixture.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * A check the shared base turns on, set back in a tsconfig of the repo's own,
 * owes the reason above it that a lint switch-off owes, read the same way. Its
 * own file because it mirrors `tsconfig-flags.ts`: the subject is the base's
 * strictness, and the reading of a reason is graded where `.oxlintrc.json` is.
 */
describe("a check of the base a tsconfig sets back", () => {
  const BASE = "@gokayo43/dev-config/tsconfig.base.json";

  /** A tsconfig extending the base, with `body` as its `compilerOptions`, one line per entry. */
  function tsconfig(body: string): string {
    return `{\n  "extends": "${BASE}",\n  "compilerOptions": {\n${body}\n  }\n}\n`;
  }

  function withTsconfig(body: string, path = "tsconfig.json"): Tree {
    return { ...CLEAN, [path]: tsconfig(body) };
  }

  const REASON =
    "    // The generated client is typed loosely, and its own types are what we check.";

  // Each kind the design names: a flag the base sets `true` written `false`,
  // one of the two the base sets `false` written `true`, a member of the
  // `strict` family the base turns on only through `strict`, and the module
  // flags, which are checks like any other boolean the base states. The
  // likeliest wrong implementation treats only `false` as a weakening, which
  // the `allowUnreachableCode` case kills.
  test.each([
    `"strict": false`,
    `"noUncheckedIndexedAccess": false`,
    `"exactOptionalPropertyTypes": false`,
    `"allowUnreachableCode": true`,
    `"allowUnusedLabels": true`,
    `"strictNullChecks": false`,
    `"useUnknownInCatchVariables": false`,
    `"verbatimModuleSyntax": false`,
    `"isolatedModules": false`,
    `"erasableSyntaxOnly": false`,
  ])("%s with no reason is refused, and passes with one", async (entry) => {
    expect(await contract(withTsconfig(`    ${entry}`))).toEqual([
      containing("sets back a check the base turns on, with no reason"),
    ]);
    expect(await contract(withTsconfig(`${REASON}\n    ${entry}`))).toEqual([]);
  });

  // Invariant 2 stated against the base itself rather than a list typed here:
  // every boolean the shipped base states is a check unless it is one of the
  // five that choose resolution or emit, so a boolean added to the base later
  // is graded with nobody editing the gate.
  test("every boolean the shipped base states is a check, but the five that are not", async () => {
    const decoded: unknown = await Bun.file(
      new URL("../tsconfig.base.json", import.meta.url),
    ).json();
    const options = Object.entries(record(record(decoded)["compilerOptions"])).filter(
      ([, value]) => typeof value === "boolean",
    );
    const notChecks = new Set([
      "allowImportingTsExtensions",
      "esModuleInterop",
      "resolveJsonModule",
      "noEmit",
      "skipLibCheck",
    ]);
    for (const [name, value] of options) {
      const findings = await contract(withTsconfig(`    "${name}": ${String(!value)}`));
      expect({ name, findings: findings.length }).toEqual({
        name,
        findings: notChecks.has(name) ? 0 : 1,
      });
    }
  });

  // A flag written at the base's own value sets nothing back, and a flag the
  // base does not state is not one of its checks: after this release that is
  // `noPropertyAccessFromIndexSignature`, whose `false` is a dead line rather
  // than a weakening.
  test("a flag at the base's own value, or one the base does not state, owes nothing", async () => {
    const body = [
      `    "strict": true`,
      `    "allowUnreachableCode": false`,
      `    "noPropertyAccessFromIndexSignature": false`,
      `    "noUnusedLocals": false`,
    ].join(",\n");
    expect(await contract(withTsconfig(body))).toEqual([]);
  });

  // The reason is read the way the lint switch-off check reads it, by the one
  // implementation both call. These cases are that reading's edges as a
  // tsconfig meets them.
  test("two weakenings on one line are refused, whatever is above them", async () => {
    expect(
      await contract(withTsconfig(`${REASON}\n    "strict": false, "noImplicitReturns": false`)),
    ).toEqual([
      containing("strict: false shares its line with another entry"),
      containing("noImplicitReturns: false shares its line with another entry"),
    ]);
  });

  test.each(["//", "/* */"])("an empty comment (%j) is not a reason", async (empty) => {
    expect(await contract(withTsconfig(`    ${empty}\n    "strict": false`))).toEqual([
      containing("sets back a check the base turns on, with no reason"),
    ]);
  });

  test("a reason covers the run of weakenings under it, and a blank line ends the run", async () => {
    const run = `${REASON}\n    "strict": false,\n    "noImplicitReturns": false`;
    expect(await contract(withTsconfig(run))).toEqual([]);
    const broken = `${REASON}\n    "strict": false,\n\n    "noImplicitReturns": false`;
    expect(await contract(withTsconfig(broken))).toEqual([
      containing("noImplicitReturns: false sets back a check"),
    ]);
  });

  test("an entry left at the base's value ends the run too", async () => {
    const between = `${REASON}\n    "strict": false,\n    "noImplicitOverride": true,\n    "noImplicitReturns": false`;
    expect(await contract(withTsconfig(between))).toEqual([
      containing("noImplicitReturns: false sets back a check"),
    ]);
  });

  // The likeliest wrong implementation reads the root `tsconfig.json` alone,
  // which every split config of a Vite or a monorepo tree walks straight past.
  test("a nested tsconfig of another name is read", async () => {
    const tree = withTsconfig(`    "strict": false`, "apps/web/tsconfig.app.json");
    expect(await contract(tree)).toEqual([
      containing("apps/web/tsconfig.app.json strict: false sets back a check"),
    ]);
  });

  // A file of another name that only carries the word is not a tsconfig.
  test("a json file under a directory named for tsconfig is not one", async () => {
    const tree = { ...CLEAN, "tsconfig/presets.json": tsconfig(`    "strict": false`) };
    expect(await contract(tree)).toEqual([]);
  });

  test("the finding names the file and the line the entry sits on", async () => {
    const root = await materialise(withTsconfig(`    "noImplicitAny": false`), [".env.example"]);
    expect(
      (await repoContract(root, DEFAULTS)).map(({ file, line }) => `${file ?? ""}:${line ?? 0}`),
    ).toEqual(["tsconfig.json:4"]);
  });

  // `config-lineage` waives where a config inherits from, and a weakening is
  // what it sets back, which no exemption waives.
  test("config-lineage does not waive it", async () => {
    const tree = {
      ...CLEAN,
      "tsconfig.json": `{\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": {\n    "strict": false\n  }\n}\n`,
    };
    expect(await contract(tree, { exemptions: ["config-lineage"] })).toEqual([
      containing("strict: false sets back a check"),
    ]);
  });

  // `paths` is an object inside `compilerOptions`, and `false` inside an object
  // of another subject sets nothing back.
  test("a boolean inside a nested object of the options is not a flag", async () => {
    const tree = {
      ...CLEAN,
      "tsconfig.json": `{\n  "extends": "${BASE}",\n  "compilerOptions": {\n    "plugins": [{ "name": "x", "strict": false }]\n  },\n  "ts-node": { "compilerOptions": { "strict": false } }\n}\n`,
    };
    expect(await contract(tree)).toEqual([]);
  });
});
