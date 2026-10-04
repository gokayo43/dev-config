import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { plugin } from "@shadcn/lint";

import { configObjects, isList, record } from "../.github/actions/_lib/gate.ts";
import { type Diagnostic, lintAt } from "./lint-fixture.ts";
import { materialise, type Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);

/**
 * The wiring README documents, written the way a repo writes it: both bases by
 * their `node_modules` path, the components named through `settings.shadcn`
 * with no `components.json`, and `no-restyle` switched off where the components
 * are defined.
 */
const OXLINTRC = `{
  "extends": [
    "./node_modules/@gokayo43/dev-config/oxlint.base.json",
    "./node_modules/@gokayo43/dev-config/design-system.base.json"
  ],
  "options": { "typeAware": false },
  "ignorePatterns": ["node_modules/**"],
  "settings": { "shadcn": { "ui": "~/ui" } },
  "overrides": [
    {
      "files": ["src/ui/**"],
      "rules": {
        // A shared component styles itself here; the rule is about the pages that use it.
        "shadcn/no-restyle": "off"
      }
    }
  ]
}
`;

/**
 * A product with a design system: a theme in its stylesheet and one shared
 * component with sizes and tones. `src/ui` is not a directory the plugin finds
 * on its own, so every component-scoped case below also proves the
 * `settings.shadcn` line reached it.
 */
const PRODUCT: Tree = {
  "package.json": JSON.stringify({
    name: "design-system-fixture",
    private: true,
    type: "module",
    devDependencies: {
      "@gokayo43/dev-config": "github:gokayo43/dev-config#0b0af716bad80fd46a212d05a4c4b2de034ba215",
      "@shadcn/lint": "0.2.0",
      tailwindcss: "4.3.3",
    },
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { jsx: "react-jsx", paths: { "~/*": ["./src/*"] } },
  }),
  ".oxlintrc.json": OXLINTRC,
  "src/styles.css": `@import "tailwindcss";

@theme {
  --color-surface: oklch(0.98 0 0);
  --color-ink: oklch(0.2 0 0);
  --color-accent: oklch(0.62 0.21 0);
}
`,
  "src/ui/button.tsx": `import { cva, type VariantProps } from "class-variance-authority";

const button = cva("inline-flex items-center rounded-md bg-accent text-surface", {
  variants: {
    size: { sm: "h-8 px-3 text-sm", lg: "h-11 px-6 text-base" },
    tone: { solid: "bg-accent text-surface", quiet: "bg-surface text-ink" },
  },
});

export function Button({
  className,
  size,
  tone,
  children,
}: { className?: string; children?: string } & VariantProps<typeof button>) {
  return <button className={button({ size, tone, className })}>{children}</button>;
}
`,
  // Layout on a shared component is the fleet default the base allows, and
  // every class here is a theme token or on the scale.
  "src/pages/conforming.tsx": `import { Button } from "~/ui/button";

export function Conforming() {
  return (
    <section className="flex flex-col gap-4 bg-surface p-4 text-ink">
      <Button className="mt-4 w-full" size="lg" tone="quiet">
        Save
      </Button>
    </section>
  );
}
`,
};

/**
 * One page per way a page drifts from the design, each naming the rule that
 * must refuse it and the alternative its diagnostic must name.
 */
const DRIFT = [
  {
    rule: "no-raw-colors",
    page: `export function Page() {\n  return <p className="bg-pink-500">Hello</p>;\n}\n`,
    alternative: "Nearest theme tokens: bg-accent",
  },
  {
    rule: "no-arbitrary-values",
    page: `export function Page() {\n  return <p className="p-[13px]">Hello</p>;\n}\n`,
    alternative: 'Use "p-3.25" instead',
  },
  {
    rule: "no-restyle",
    page: `import { Button } from "~/ui/button";\n\nexport function Page() {\n  return <Button className="p-4">Save</Button>;\n}\n`,
    alternative: "Use a size (sm, lg)",
  },
  {
    rule: "no-inline-styles",
    page: `export function Page() {\n  return <p style={{ marginTop: 16 }}>Hello</p>;\n}\n`,
    alternative: "Style through classes",
  },
  {
    rule: "no-unknown-classes",
    page: `export function Page() {\n  return <p className="rounded-xll">Hello</p>;\n}\n`,
    alternative: 'Did you mean "rounded-xl"?',
  },
  {
    rule: "require-static-classes",
    page: `import { Button } from "~/ui/button";\n\nexport function Page({ gap }: { gap: string }) {\n  return <Button className={\`mt-\${gap}\`}>Save</Button>;\n}\n`,
    alternative: "Use static class strings",
  },
] as const;

/** What the two bases are made of, as `files` ships them. */
const SHIPPED = ["package.json", "oxlint.base.json", "design-system.base.json", "anti-slop"];

/**
 * The tree installed the way a consuming repo has it: the shipped bases as
 * `@gokayo43/dev-config`, and the plugin and Tailwind beside it in the repo's
 * own `node_modules` — the plugin because the base names it by a bare
 * specifier, Tailwind because `no-unknown-classes` asks the project's own copy
 * which classes exist. The package is linked file by file rather than as this
 * checkout, because oxlint reads every `.oxlintrc.json` below the directory it
 * lints, symlinks followed, and a checkout carries more than a package does.
 */
async function linted(tree: Tree): Promise<ReadonlyMap<string, readonly Diagnostic[]>> {
  const root = await materialise(tree);
  const modules = join(root, "node_modules");
  const devConfig = join(modules, "@gokayo43", "dev-config");
  await mkdir(devConfig, { recursive: true });
  await mkdir(join(modules, "@shadcn"), { recursive: true });
  for (const name of SHIPPED) await symlink(join(REPO, name), join(devConfig, name));
  await symlink(join(REPO, "node_modules", "@shadcn", "lint"), join(modules, "@shadcn", "lint"));
  await symlink(join(REPO, "node_modules", "tailwindcss"), join(modules, "tailwindcss"));
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of await lintAt(root)) {
    grouped.set(diagnostic.filename, [...(grouped.get(diagnostic.filename) ?? []), diagnostic]);
  }
  return grouped;
}

describe("the design-system base", () => {
  // One oxlint run for every drifted page, started by whichever case reads it
  // first, so the tree is made inside a case like every other fixture here.
  let run: Promise<ReadonlyMap<string, readonly Diagnostic[]>> | undefined;
  const drifted = async (): Promise<ReadonlyMap<string, readonly Diagnostic[]>> =>
    await (run ??= linted({
      ...PRODUCT,
      ...Object.fromEntries(DRIFT.map(({ rule, page }) => [`src/pages/${rule}.tsx`, page])),
    }));

  for (const { rule, alternative } of DRIFT) {
    test(`${rule} refuses its page at error and names what to use instead`, async () => {
      const reported = (await drifted()).get(`src/pages/${rule}.tsx`) ?? [];
      expect(reported.map(({ severity, code }) => `${severity} ${code}`)).toEqual([
        `error shadcn(${rule})`,
      ]);
      expect(reported[0]?.message).toContain(alternative);
    });
  }

  // The fixture's own component and its conforming page sit in the same run as
  // the drift: a rule that fired on everything would pass every case above.
  test("the component's own file and the conforming page draw nothing", async () => {
    const reported = await drifted();
    expect(reported.get("src/ui/button.tsx") ?? []).toEqual([]);
    expect(reported.get("src/pages/conforming.tsx") ?? []).toEqual([]);
  });

  test("the product with only conforming pages is clean", async () => {
    expect([...(await linted(PRODUCT)).values()].flat()).toEqual([]);
  });

  // Asked of the plugin and the base rather than of a fixture: a rule the
  // plugin ships that the base leaves off is drift nobody is told about, and a
  // version that adds one fails here, on the bump that has to decide it.
  test("the base enables every rule the plugin defines, each at error", async () => {
    const base = record((await configObjects(REPO, ["design-system.base.json"])).read[0]?.value);
    const rules = Object.entries(record(base["rules"])).map(([name, setting]) => [
      name,
      isList(setting) ? setting[0] : setting,
    ]);
    expect(rules.toSorted(([left], [right]) => String(left).localeCompare(String(right)))).toEqual(
      Object.keys(plugin.rules)
        .map((name) => [`shadcn/${name}`, "error"])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    );
  });
});
