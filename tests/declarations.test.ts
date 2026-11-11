import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { plainly } from "../.github/actions/_lib/gate.ts";
import { byFile, lintAt } from "./lint-fixture.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The two declaration files, each graded in a consumer's shape: the package
 * installed as `@gokayo43/dev-config` with only the files a declaration reaches,
 * this repo's own install beside it for `@types/bun`, `@types/react` and
 * `oxlint-tsgolint`, and the declaration named in the consumer's own `types` by
 * its export, which is the one line README tells a repo to write. The
 * consumer's `exclude` carries `node_modules`, so a declaration reached through
 * `include` instead would be dropped here as it is in a repo.
 */

// A type check or a type-aware lint of a fixture program takes a few seconds
// with the machine to itself, against bun's 5s default.
setDefaultTimeout(60_000);

const REPO = dirname(import.meta.dir);
const SHIPPED = ["package.json", "bun-test.d.ts", "css-custom-properties.d.ts"];
const BUN_TEST = "@gokayo43/dev-config/bun-test";
const CSS = "@gokayo43/dev-config/css-custom-properties";

/** A consumer's program over `tree`, with `types` as its own `compilerOptions.types`. */
async function installed(
  tree: Tree,
  types: readonly string[],
  skipLibCheck = true,
): Promise<string> {
  const root = await materialise({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck,
        types,
      },
      include: ["*.ts"],
      exclude: ["node_modules"],
    }),
    ...tree,
  });
  const modules = join(root, "node_modules");
  await mkdir(join(modules, "@gokayo43", "dev-config"), { recursive: true });
  for (const name of await readdir(join(REPO, "node_modules"))) {
    await symlink(join(REPO, "node_modules", name), join(modules, name));
  }
  for (const name of SHIPPED) {
    await symlink(join(REPO, name), join(modules, "@gokayo43", "dev-config", name));
  }
  return root;
}

/** Each error the type checker reports, as `file: TS code`. */
async function typeErrors(root: string): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, "check", "--no-script", "--no-pretty", "-p", root], {
    cwd: root,
    env: plainly(Bun.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const errors = [...`${out}${err}`.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+)/gmu)].map(
    ([, file, code]) => `${file}: ${code}`,
  );
  // A checker that could not run says so in prose and lists nothing, which
  // would read as a clean program.
  expect(status === 0, `${out}${err}`).toBe(errors.length === 0);
  return errors;
}

describe("css-custom-properties", () => {
  const STYLES: Tree = {
    "custom.ts": `import type { CSSProperties } from "react";
const width = 3;
export const panel: CSSProperties = { "--panel-width": \`\${width}px\`, "--gap": 2, width: 4 };
`,
    // The template key admits a custom property and nothing else, so a
    // misspelt one and a value no style takes are still refused.
    "misspelt.ts": `import type { CSSProperties } from "react";
export const panel: CSSProperties = { "-panel-width": 1 };
`,
    "object-value.ts": `import type { CSSProperties } from "react";
export const panel: CSSProperties = { "--panel-width": { px: 1 } };
`,
  };

  test("a custom property type-checks with the declaration, and a typo or an object value does not", async () => {
    expect(await typeErrors(await installed(STYLES, [CSS], false))).toEqual([
      "misspelt.ts: TS2353",
      "object-value.ts: TS2322",
    ]);
  });

  test("without the declaration a custom property is an excess property", async () => {
    expect(await typeErrors(await installed(STYLES, []))).toContain("custom.ts: TS2353");
  });
});

describe("bun-test", () => {
  /** One case per file, each the body of a `test` in a bun:test suite. */
  const body = (statement: string): string => `import { expect, test } from "bun:test";
const settled = Promise.resolve(1);
const refused = Promise.reject(new Error("x"));
const sync = (): number => 1;
test("case", async () => {
  ${statement}
});
`;

  /** The awaits the declaration exists to allow. */
  const AWAITED = {
    "resolves.toBe": "await expect(settled).resolves.toBe(1);",
    "resolves.toMatchObject":
      "await expect(Promise.resolve({ a: 1 })).resolves.toMatchObject({ a: 1 });",
    "resolves.not.toBe": "await expect(settled).resolves.not.toBe(2);",
    "rejects.toThrow": 'await expect(refused).rejects.toThrow("x");',
    "rejects.toBeInstanceOf": "await expect(refused).rejects.toBeInstanceOf(Error);",
  };

  /** Awaits of nothing, which the rule must still refuse. */
  const POINTLESS = {
    "a plain matcher": "await expect(1).toBe(1);",
    "a sync throw matcher": "await expect(sync).toThrow();",
    "a bare resolves": "await expect(settled).resolves;",
  };

  /** A chain that settles later, left unawaited. */
  const FLOATING = {
    "an unawaited resolves": "expect(settled).resolves.toBe(1);",
    "an unawaited rejects": "expect(refused).rejects.toThrow();",
  };

  const file = (name: string): string => `${name.replaceAll(/[^a-z]+/gu, "-")}.test.ts`;
  const CASES = { ...AWAITED, ...POINTLESS, ...FLOATING };
  const TREE: Tree = {
    ".oxlintrc.json": JSON.stringify({
      plugins: ["typescript"],
      categories: { correctness: "off" },
      options: { typeAware: true },
      ignorePatterns: ["node_modules/**"],
      rules: { "typescript/await-thenable": "error", "typescript/no-floating-promises": "error" },
    }),
    ...Object.fromEntries(
      Object.entries(CASES).map(([name, statement]) => [file(name), body(statement)]),
    ),
  };

  /** What each case's file draws, one oxlint run per program, started by whichever case reads it first. */
  const AWAIT_THENABLE = "typescript(await-thenable)";
  const runs = new Map<string, Promise<ReadonlyMap<string, readonly string[]>>>();
  const drawn = async (types: readonly string[], name: string): Promise<readonly string[]> => {
    const key = types.join(",");
    let run = runs.get(key);
    if (run === undefined) {
      run = (async () => {
        const grouped = byFile(await lintAt(await installed(TREE, types)));
        const codes = new Map(
          [...grouped].map(([path, found]) => [path, found.map(({ code }) => code)]),
        );
        // A program the type-aware pass could not build draws nothing at all,
        // which every "draws nothing" case would read as a pass. The pointless
        // awaits are pointless under either program, so a run that missed one
        // of them graded nothing.
        const unread = Object.keys(POINTLESS).filter(
          (pointless) => !(codes.get(file(pointless)) ?? []).includes(AWAIT_THENABLE),
        );
        if (unread.length > 0) {
          throw new Error(`the type-aware run under types ${key} missed: ${unread.join(", ")}`);
        }
        return codes;
      })();
      runs.set(key, run);
    }
    return (await run).get(file(name)) ?? [];
  };

  const WITH = ["bun", BUN_TEST];
  const WITHOUT = ["bun"];

  for (const name of Object.keys(AWAITED)) {
    test(`an awaited ${name} draws nothing with the declaration`, async () => {
      expect(await drawn(WITH, name)).toEqual([]);
    });
    test(`an awaited ${name} draws await-thenable without it`, async () => {
      expect(await drawn(WITHOUT, name)).toEqual([AWAIT_THENABLE]);
    });
  }

  for (const name of Object.keys(POINTLESS)) {
    test(`${name} awaited still draws await-thenable with the declaration`, async () => {
      expect(await drawn(WITH, name)).toEqual([AWAIT_THENABLE]);
    });
  }

  for (const name of Object.keys(FLOATING)) {
    test(`${name} draws no-floating-promises with the declaration`, async () => {
      expect(await drawn(WITH, name)).toEqual(["typescript(no-floating-promises)"]);
    });
  }

  // The argument check survives: an escape-hatch overload read in place of the
  // matcher's own would accept any argument and leave this program clean.
  test("a matcher's argument is still checked through resolves, and the declaration checks without skipLibCheck", async () => {
    const program: Tree = {
      "argument.test.ts": `import { expect, test } from "bun:test";
test("case", async () => {
  await expect(Promise.resolve(1)).resolves.toBe("one");
});
`,
    };
    expect(await typeErrors(await installed(program, WITH, false))).toEqual([
      "argument.test.ts: TS2769",
    ]);
  });
});
