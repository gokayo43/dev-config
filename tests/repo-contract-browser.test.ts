/**
 * The other thing a live repo can be. A repo that serves pages owes the
 * structural E2E suite testing.md asks of every one of them: a runner it
 * declares, specs written through this package's invariant sweep, and a CI job
 * that runs them — three facts, because each of them is a different file to fix.
 *
 * Its own file beside `repo-contract-live.test.ts` the way `browser-suite.ts`
 * is its own module beside `live.ts`: what a database costs a live repo and
 * what pages cost one are two subjects, and `repo-contract-fixture.ts` holds
 * the live static site both start every case from.
 *
 * What is deliberately never asked is how many flows the suite has. E2E is few
 * and structural, so a floor on flow count would be this gate asking for the
 * opposite of the rule it derives from — every case here is about the suite
 * existing, being swept, and running.
 */
import { describe, expect, test } from "bun:test";

import type { Contract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import {
  contract,
  LIVE_STATIC,
  liveSite,
  manifestWith,
  type PackageJson,
} from "./repo-contract-fixture.ts";
import type { Tree } from "./tree.ts";

const SPEC = "e2e/home.spec.ts";

/** A spec written through the sweep, which is the whole of what makes its pages swept. */
const SWEPT = `import { test } from "@gokayo43/dev-config/invariant-sweep.ts";

test("the home page loads", async ({ page }) => {
  await page.goto("/");
});
`;

/** The same spec against Playwright's own `test`: a suite that exists and sweeps nothing. */
const UNSWEPT = SWEPT.replace('"@gokayo43/dev-config/invariant-sweep.ts"', '"@playwright/test"');

/** That spec with the specifier present as prose, which is a spec nobody has moved yet. */
const PROMISED = `// TODO: move this to @gokayo43/dev-config/invariant-sweep.ts\n${UNSWEPT}`;

/** And present as a value, which is the other way the bytes carry it and the imports do not. */
const QUOTED = `${UNSWEPT}export const swept = "@gokayo43/dev-config/invariant-sweep.ts";\n`;

/** A live static site that ships pages, and whatever a case changes about its manifest. */
function pages(change: (contents: PackageJson) => void = () => {}): Tree {
  return liveSite((contents) => {
    contents.dependencies = { ...contents.dependencies, "react-dom": "19.2.0" };
    change(contents);
  });
}

/** The site's own check.yml call, plus a job this repo runs itself. */
function running(...commands: readonly string[]): Tree {
  const steps = commands.map((command) => `      - run: ${JSON.stringify(command)}\n`).join("");
  return {
    ".github/workflows/ci.yml": `${LIVE_STATIC[".github/workflows/ci.yml"] ?? ""}  e2e:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
  };
}

/** The same site with the whole suite: the runner, a swept spec, and CI running it. */
const SWEPT_SUITE: Tree = {
  ...pages((contents) => {
    contents.devDependencies["@playwright/test"] = "1.62.1";
  }),
  [SPEC]: SWEPT,
  ...running("bunx playwright test"),
};

/** That site with a manifest of its own, which is the graft most cases here make. */
function suiteWith(change: (contents: PackageJson) => void): Tree {
  return {
    ...SWEPT_SUITE,
    ...pages((contents) => {
      contents.devDependencies["@playwright/test"] = "1.62.1";
      change(contents);
    }),
  };
}

async function pageSite(tree: Tree, overrides: Partial<Contract> = {}): Promise<string[]> {
  return await contract(tree, { database: "none", ...overrides });
}

const DECLARE = "declare @playwright/test";
const SWEEP = "write its specs with the invariant sweep's `test`";
const RUN_IT = "have .github/workflows/ci.yml run it";

describe("a live repo that ships a browser surface", () => {
  test("owes a runner, a swept spec and a CI run, each naming its own file", async () => {
    expect(await pageSite(pages())).toEqual([
      containing(DECLARE),
      containing(SWEEP),
      containing(RUN_IT),
    ]);
  });

  test("and owes nothing once it has all three", async () => {
    expect(await pageSite(SWEPT_SUITE)).toEqual([]);
  });

  // Both web picks are the surface, and the second is graded exactly as the
  // first — the list is two names rather than one and a prefix.
  test("which is either web pick, so an astro site owes the same three", async () => {
    const site = liveSite((contents) => {
      contents.dependencies = { ...contents.dependencies, astro: "5.16.2" };
    });
    expect(await pageSite(site)).toEqual([
      containing(DECLARE),
      containing(SWEEP),
      containing(RUN_IT),
    ]);
  });

  // The field says what a deployment runs, which is the crash SDK's question
  // and not this one. A static site generator builds every page from
  // `devDependencies`, and a bundled SPA emits the same artifact either way —
  // so the pages are there whichever line the framework was declared on.
  test.each(["astro", "react-dom"])(
    "and %s in devDependencies is a page a browser opens all the same",
    async (name) => {
      const built = liveSite((contents) => {
        contents.devDependencies[name] = "5.16.2";
      });
      expect(await pageSite(built)).toEqual([
        containing(DECLARE),
        containing(SWEEP),
        containing(RUN_IT),
      ]);
    },
  );

  // `ci-call` waives the call into check.yml and the upgrade gate that call
  // carries. It does not waive this, and the steps are still read out of the
  // same file: a repo whose CI is its own runs the suite in a job of its own,
  // and a gate that stopped reading the workflow along with the call would
  // refuse it for a job sitting right there.
  test("and its CI is read for the suite even where the check.yml call is waived", async () => {
    const ownCi: Tree = {
      ...SWEPT_SUITE,
      ".github/workflows/ci.yml":
        "name: CI\non:\n  pull_request:\njobs:\n  e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bunx playwright test\n",
    };
    expect(await pageSite(ownCi, { exemptions: ["ci-call"] })).toEqual([]);
  });

  // Which manifest declares the runner is a monorepo's own business, and a repo
  // that shipped it rather than dev-declaring it has a suite either way.
  test.each([
    [
      "a workspace manifest",
      { "apps/web/package.json": '{ "devDependencies": { "@playwright/test": "1.62.1" } }' },
    ],
    [
      "the root's dependencies",
      pages((contents) => {
        contents.dependencies = { ...contents.dependencies, "@playwright/test": "1.62.1" };
      }),
    ],
  ])("takes the runner from %s", async (_where, declared) => {
    expect(
      await pageSite({
        ...pages(),
        ...declared,
        [SPEC]: SWEPT,
        ...running("bunx playwright test"),
      }),
    ).toEqual([]);
  });
});

// The fact is the import, and the wrong implementations are all the ways a file
// carries those bytes without making one: the spec on Playwright's own `test`,
// the note above it promising the move, and the specifier as a value. A gate
// reading the bytes passes all three, and each is a page nothing sweeps.
describe("a spec is swept by importing the sweep", () => {
  test.each([
    ["Playwright's own test", UNSWEPT],
    ["a TODO naming the sweep above the import it has not made", PROMISED],
    ["the specifier as a string, imported from nowhere", QUOTED],
  ])("is not satisfied by a spec with %s", async (_what, source) => {
    expect(await pageSite({ ...SWEPT_SUITE, [SPEC]: source })).toEqual([containing(SWEEP)]);
  });

  // The specifier is read in the position that imports it, so both quotings and
  // a dynamic import are the same import.
  test.each([
    ["single quotes, which is what a formatter may write", SWEPT.replaceAll('"', "'")],
    [
      "a dynamic import",
      'const { test } = await import("@gokayo43/dev-config/invariant-sweep.ts");\nexport const used = test;\n',
    ],
  ])("and is satisfied by %s", async (_what, source) => {
    expect(await pageSite({ ...SWEPT_SUITE, [SPEC]: source })).toEqual([]);
  });

  test("and one swept spec anywhere in the tree is what the rule asks for", async () => {
    const nested: Tree = {
      ...SWEPT_SUITE,
      [SPEC]: UNSWEPT,
      "apps/web/e2e/checkout.spec.tsx": SWEPT,
    };
    expect(await pageSite(nested)).toEqual([]);
  });
});

// The wrong implementation this fact exists against is a grep of the workflow
// for the word. Every Playwright job installs a browser and most of them print
// advice about the binary, so the word is in the ordinary passing workflow and
// in the ordinary failing one alike.
describe("CI runs the suite when a command runs it", () => {
  test.each([
    ["the install step every Playwright job has", "playwright install --with-deps chromium"],
    ["a comment above it", "# playwright test runs in the nightly workflow\nplaywright install"],
    ["advice echoed to the log", "echo Run playwright test locally to reproduce"],
    ["the same advice as a workflow command", 'echo "::notice::run playwright test to reproduce"'],
    [
      "a command whose ARGUMENT looks like one",
      "echo Running playwright\ntest -f playwright.config.ts",
    ],
  ])("is not satisfied by %s", async (_what, command) => {
    expect(await pageSite({ ...SWEPT_SUITE, ...running(command) })).toEqual([containing(RUN_IT)]);
  });

  // Nor by a script whose NAME carries the word while its command installs.
  test("nor by a script named for the binary that does not run it", async () => {
    const named = suiteWith((contents) => {
      contents.scripts = { ...contents.scripts, "playwright:setup": "playwright install" };
    });
    expect(await pageSite({ ...named, ...running("bun run playwright:setup") })).toEqual([
      containing(RUN_IT),
    ]);
  });

  test.each([
    ["the binary directly", "playwright test --project=desktop"],
    ["bunx", "bunx playwright test"],
    ["bun x", "bun x playwright test"],
    ["the local binary", "./node_modules/.bin/playwright test"],
    ["a chain after a build", "bun run build && playwright test"],
    ["a command carrying its own environment", "CI=1 PWTEST_SKIP=0 playwright test"],
  ])("counts a step that runs it through %s", async (_how, command) => {
    expect(await pageSite({ ...SWEPT_SUITE, ...running(command) })).toEqual([]);
  });

  // A repo runs its suite through the script it named it, and a script runs
  // another: `e2e` is what a person types and `test:e2e:ci` is what CI needs.
  test("follows a package script, and a chain of them", async () => {
    const throughScripts = suiteWith((contents) => {
      contents.scripts = {
        ...contents.scripts,
        e2e: "bun run test:e2e:ci",
        "test:e2e:ci": "playwright test --project=desktop",
      };
    });
    expect(await pageSite({ ...throughScripts, ...running("bun run e2e") })).toEqual([]);
  });

  // A script that calls itself is a run that never starts, and a walk that
  // followed it would be a gate that never answers. The case passing at all is
  // the assertion; the message is what it answers with once it terminates.
  test("and terminates on a script that calls itself", async () => {
    const circular = suiteWith((contents) => {
      contents.scripts = { ...contents.scripts, e2e: "bun run ci:e2e", "ci:e2e": "bun run e2e" };
    });
    expect(await pageSite({ ...circular, ...running("bun run e2e") })).toEqual([
      containing(RUN_IT),
    ]);
  });
});

/**
 * A monorepo runs the suite in the workspace that owns the pages, and every
 * flag that takes a value has to be consumed with it: read as a bare word, the
 * value IS the script name, and `bun run --filter web test:e2e` becomes a run
 * of the script `web` — a suite reported missing while CI runs it every push.
 */
describe("a suite a workspace declares", () => {
  const WORKSPACE_SUITE = JSON.stringify({
    name: "web",
    scripts: { "test:e2e": "playwright test" },
  });

  test.each([
    ["--cwd names the directory", "bun run --cwd apps/web test:e2e"],
    ["--cwd=, written with an equals", "bun run --cwd=apps/web test:e2e"],
    ["--cwd with a path a person typed", "bun run --cwd ./apps/web/ test:e2e"],
    ["--filter selects across the workspace", "bun run --filter web test:e2e"],
    ["--filter=, written with an equals", "bun run --filter=web test:e2e"],
    ["-F, which is what bun's own help calls it", "bun run -F web test:e2e"],
    ["turbo runs the task", "turbo run test:e2e"],
    ["turbo with a filter of its own", "turbo run --filter web test:e2e"],
  ])("is found where %s", async (_how, command) => {
    const monorepo: Tree = {
      ...SWEPT_SUITE,
      "apps/web/package.json": WORKSPACE_SUITE,
      ...running(command),
    };
    expect(await pageSite(monorepo)).toEqual([]);
  });

  // The root is a directory like any other, and `.` is how a step spells it.
  test("and `--cwd .` is the root manifest, not a directory called `.`", async () => {
    const atTheRoot = suiteWith((contents) => {
      contents.scripts = { ...contents.scripts, "test:e2e": "playwright test" };
    });
    expect(await pageSite({ ...atTheRoot, ...running("bun run --cwd . test:e2e") })).toEqual([]);
  });

  // `--cwd` names the manifest, so a script of that name in a different one is
  // not the script this step runs. `--filter` is the opposite by design.
  test("but --cwd reads the manifest it names, not whichever one has the script", async () => {
    const elsewhere: Tree = {
      ...SWEPT_SUITE,
      "apps/api/package.json": WORKSPACE_SUITE,
      ...running("bun run --cwd apps/web test:e2e"),
    };
    expect(await pageSite(elsewhere)).toEqual([containing(RUN_IT)]);
  });
});

// Which repos have pages is read off the two names STACK picks. A prefix or a
// substring answers yes for the runtime that has no page at all, and for a
// crash SDK named after one.
describe("a repo with no browser surface owes none of it", () => {
  test.each([
    [
      "an Expo app, which ships react-native",
      { "@sentry/react-native": "10.24.0", "react-native": "0.83.1" },
    ],
    ["a crash SDK named after a web pick", { "@sentry/astro": "10.24.0" }],
    ["an API, which ships neither", { "@sentry/bun": "10.24.0" }],
  ])("%s is asked for no Playwright suite", async (_what, dependencies) => {
    const site = liveSite((contents) => {
      contents.dependencies = dependencies;
    });
    expect(await pageSite(site)).toEqual([]);
  });
});

// The whole rule set is reached through the one field: a repo with pages and no
// suite is a complete `dev` repo, which is what `dev` is for.
describe("the browser rules are reached through the lifecycle field", () => {
  test("a dev repo that ships pages owes nothing at all", async () => {
    const shipped = manifestWith((contents) => {
      contents.dependencies = { "react-dom": "19.2.0" };
    });
    expect(await contract(shipped)).toEqual([]);
  });
});
