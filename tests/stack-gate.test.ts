import { afterEach, describe, expect, test } from "bun:test";

import { stackGate } from "../.github/actions/stack-gate/stack-gate.ts";
import { discard, materialise, type Tree } from "./tree.ts";

const DENYLIST = new URL(
  "../.github/actions/stack-gate/stack-denylist.json",
  import.meta.url,
);

const CLEAN: Tree = {
  ".gitignore": "node_modules/\n",
  "package.json": JSON.stringify({
    name: "clean",
    dependencies: { "drizzle-orm": "0.44.7", sonner: "2.0.7", clsx: "2.1.1" },
    devDependencies: { "drizzle-kit": "0.31.6", "jest-expo": "54.0.0" },
  }),
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(discard));
});

async function gate(tree: Tree): Promise<string[]> {
  const root = await materialise(tree);
  roots.push(root);
  return (await stackGate(root, DENYLIST)).map(({ file, message }) => `${file ?? ""}: ${message}`);
}

async function withDependency(name: string, version = "1.0.0"): Promise<string[]> {
  const manifest = JSON.parse(CLEAN["package.json"] ?? "") as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies[name] = version;
  return await gate({ ...CLEAN, "package.json": JSON.stringify(manifest) });
}

describe("stack gate", () => {
  test("a tree that only names house picks passes", async () => {
    expect(await gate(CLEAN)).toEqual([]);
  });

  test.each([
    ["prisma", "Drizzle"],
    ["ioredis", "Redis"],
    ["valibot", "zod"],
    ["@radix-ui/react-dialog", "Base UI"],
    ["react-hot-toast", "sonner"],
    ["classnames", "clsx"],
    ["@emotion/react", "Tailwind"],
    ["dayjs", "Temporal"],
    ["recharts", "dataviz"],
    ["next-auth", "Better Auth"],
    ["nodemailer", "Resend"],
    ["node-cron", "Effect Schedule"],
    ["vitest", "bun test"],
    ["nativewind", "StyleSheet"],
    ["@react-native-async-storage/async-storage", "expo-secure-store"],
  ])("%s is refused and the diagnostic names the pick", async (name, pick) => {
    const problems = await withDependency(name);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`dependencies.${name}`);
    expect(problems[0]).toContain(pick);
  });

  test("an exact-name entry does not take its prefixed neighbours with it", async () => {
    // jest-expo is the Expo test preset and is the only way to run a
    // React Native suite; the bare `jest` entry must not reach it.
    expect(await gate(CLEAN)).toEqual([]);
    expect(await withDependency("jest")).toHaveLength(1);
  });

  test("a workspace package is read too", async () => {
    const problems = await gate({
      ...CLEAN,
      "apps/api/package.json": JSON.stringify({ dependencies: { redis: "5.9.1" } }),
    });
    expect(problems).toEqual([
      expect.stringContaining("apps/api/package.json: dependencies.redis"),
    ]);
  });

  test("an ignored directory is not read", async () => {
    const problems = await gate({
      ...CLEAN,
      "node_modules/left-pad/package.json": JSON.stringify({ dependencies: { mobx: "6.15.0" } }),
    });
    expect(problems).toEqual([]);
  });

  test("a recorded deviation unlocks the entry that names it", async () => {
    const withState = await withDependency("zustand", "5.0.8");
    expect(withState).toHaveLength(1);
    expect(withState[0]).toContain("docs/adr/*state-management*.md");

    const manifest = JSON.parse(CLEAN["package.json"] ?? "") as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["zustand"] = "5.0.8";
    expect(
      await gate({
        ...CLEAN,
        "package.json": JSON.stringify(manifest),
        "docs/adr/0003-state-management.md": "# 3. Zustand for the editor's transient state\n",
      }),
    ).toEqual([]);
  });

  test("a deviation record does not unlock the entries that never offered one", async () => {
    const manifest = JSON.parse(CLEAN["package.json"] ?? "") as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["prisma"] = "6.18.0";
    expect(
      await gate({
        ...CLEAN,
        "package.json": JSON.stringify(manifest),
        "docs/adr/0003-state-management.md": "# 3. anything\n",
      }),
    ).toHaveLength(1);
  });
});
