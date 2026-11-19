/**
 * What serving HTTP costs a live repo that owns a database: a test written
 * with request timing's conformance kit, or a reason in
 * `operations-timed-otherwise` saying how its operations are timed instead, or
 * that it serves nothing a connector covers.
 * Mirrors `request-timing.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Contract } from "../.github/actions/repo-contract/repo-contract.ts";
import { containing } from "./matchers.ts";
import {
  checkJob,
  contract,
  manifestWith,
  type PackageJson,
  workflow,
} from "./repo-contract-fixture.ts";
import { scratch, type Tree } from "./tree.ts";

const KIT = "@gokayo43/dev-config/request-timing/conformance";

const OWED = "proves its operations are timed";
const WAIVING_NOTHING = "operations-timed-otherwise is waiving nothing";

/** A conformance test as `docs/exports/request-timing.md` writes one. */
const CONFORMS = `import { test } from "bun:test";
import { requestTimingConforms } from "${KIT}";

test("request timing", () =>
  requestTimingConforms({
    method: "GET",
    operation: "/presets/:id",
    dbWaits: 1,
    drive: async () => void (await (await fetch("http://localhost:3000/presets/1")).text()),
    next: async () => "",
    sentinel: { operation: "/health", drive: async () => undefined },
  }));
`;

const TIMING_TEST = "src/request-timing.test.ts";

const RUNBOOK = "the box's borg job, restore drill in the runbook";

interface Shape {
  readonly live: boolean;
  readonly database: boolean;
  readonly http: boolean;
}

/**
 * A repo of that shape with every other contract rule satisfied, so a case's
 * output is this rule's alone. Its data jobs are waived, since what a live
 * database costs is `repo-contract-live.test.ts`'s subject.
 */
function shaped(
  { live, database, http }: Shape,
  change: (contents: PackageJson) => void = () => {},
): { tree: Tree; overrides: Partial<Contract> } {
  const tree: Tree = {
    ...manifestWith((contents) => {
      contents.lifecycle = live ? "live" : "dev";
      contents.dependencies = { "@sentry/bun": "10.24.0", ...(http && { elysia: "1.4.29" }) };
      if (!database) delete contents.scripts?.["db:migrate"];
      change(contents);
    }),
    ".github/workflows/ci.yml": workflow(
      database ? checkJob("database: postgres", "upgrade-gate: true") : checkJob(),
    ),
  };
  return {
    tree,
    overrides: {
      database: database ? "postgres" : "none",
      dataJobsExternal: live && database ? RUNBOOK : "",
    },
  };
}

async function graded(
  shape: Shape,
  extra: Tree = {},
  overrides: Partial<Contract> = {},
  change?: (contents: PackageJson) => void,
): Promise<string[]> {
  const repo = shaped(shape, change);
  return await contract({ ...repo.tree, ...extra }, { ...repo.overrides, ...overrides });
}

const OWES: Shape = { live: true, database: true, http: true };

// Invariant 1: the rule fires for exactly the conjunction. The likeliest wrong
// implementations drop one conjunct — a live API with no database, a dev app —
// and each is a row here.
describe("the conformance test is owed", () => {
  test.each([
    [true, true, true, [containing(OWED)]],
    [true, true, false, []],
    [true, false, true, []],
    [true, false, false, []],
    [false, true, true, []],
    [false, true, false, []],
    [false, false, true, []],
    [false, false, false, []],
  ])("live %p, database %p, HTTP %p", async (live, database, http, expected) => {
    expect(await graded({ live, database, http })).toEqual(expected);
  });

  // What a workspace ships, and not what it builds or tests against: this
  // repo's own manifest holds elysia and @tanstack/react-start as
  // devDependencies for the connector suites, and a library takes one as a peer.
  test.each([
    ["peerDependencies", ">=1.4.0"],
    ["devDependencies", "1.4.29"],
  ] as const)("and not by a library with the framework only in %s", async (field, spec) => {
    expect(
      await graded({ ...OWES, http: false }, {}, {}, (contents) => {
        contents[field] = { ...contents[field], elysia: spec };
      }),
    ).toEqual([]);
  });

  test.each(["next", "@tanstack/react-start"])(
    "and %s serves HTTP as elysia does",
    async (name) => {
      expect(
        await graded({ ...OWES, http: false }, {}, {}, (contents) => {
          contents.dependencies = { ...contents.dependencies, [name]: "16.0.0" };
        }),
      ).toEqual([containing(`ships ${name}`)]);
    },
  );

  test("and a workspace manifest that ships one is the repo serving HTTP", async () => {
    const app = { "apps/api/package.json": JSON.stringify({ dependencies: { elysia: "1.4.29" } }) };
    expect(await graded({ ...OWES, http: false }, app)).toEqual([
      containing("apps/api/package.json ships elysia"),
    ]);
  });

  // Invariant 2: the problem names what to do, and both ways out.
  test("and the problem names the kit, the doc and the waiver", async () => {
    expect(await graded(OWES)).toEqual([containing(`runs requestTimingConforms from ${KIT}`)]);
    expect(await graded(OWES)).toEqual([containing("`operations-timed-otherwise`")]);
    expect(await graded(OWES)).toEqual([containing("serves nothing a connector covers")]);
  });
});

// The fact is an import Bun's parser reads, and the wrong implementation is a
// match on the file's bytes, which dev-config#74 found in a sibling rule.
describe("a test meets the rule by importing the kit", () => {
  test.each([
    ["a named import", CONFORMS],
    [
      "a dynamic import",
      `test("t", async () => { await (await import("${KIT}")).requestTimingConforms(options); });\n`,
    ],
    [
      "a namespace import",
      `import * as kit from "${KIT}";\ntest("t", () => kit.requestTimingConforms(options));\n`,
    ],
  ])("is satisfied by %s", async (_what, source) => {
    expect(await graded(OWES, { [TIMING_TEST]: source })).toEqual([]);
  });

  test("in a .tsx test anywhere in the workspace", async () => {
    const tsx = `${CONFORMS}export const page = <main />;\n`;
    expect(await graded(OWES, { "apps/api/src/timing.test.tsx": tsx })).toEqual([]);
  });

  test.each([
    ["the import in a line comment", `// import { requestTimingConforms } from "${KIT}";\n`],
    ["the import in a block comment", `/* import { requestTimingConforms } from "${KIT}"; */\n`],
    [
      "the import as a string",
      `export const s = 'import { requestTimingConforms } from "${KIT}"';\n`,
    ],
    [
      "the import as a template",
      `export const s = \`import { requestTimingConforms } from "${KIT}"\`;\n`,
    ],
    [
      "a type-only import, which runs nothing",
      `import type { Options } from "${KIT}";\nexport const o: Options | undefined = undefined;\n`,
    ],
    ["the source spelling, which the package does not export", CONFORMS.replace(KIT, `${KIT}.ts`)],
  ])("is not satisfied by %s", async (_what, source) => {
    expect(await graded(OWES, { [TIMING_TEST]: source })).toEqual([containing(OWED)]);
  });

  // A spec is the Playwright lane, which never runs the kit.
  test("nor by a Playwright spec importing it", async () => {
    expect(await graded(OWES, { "e2e/timing.spec.ts": CONFORMS })).toEqual([containing(OWED)]);
  });

  // A file under review must not run inside the gate: `Transpiler.scan`
  // evaluates a Bun macro, and a macro in the gate's realm can forge every
  // contract verdict, since they are reported in one batch.
  test("and reading the imports runs no macro the test file names", async () => {
    const outside = await scratch();
    const marker = join(outside, "ran");
    await Bun.write(
      join(outside, "macro.ts"),
      `import { writeFileSync } from "node:fs";\nexport function f() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`,
    );
    const macro = `import { f } from ${JSON.stringify(join(outside, "macro.ts"))} with { type: "macro" };\nexport const x = f();\n`;
    expect(await graded(OWES, { [TIMING_TEST]: macro })).toEqual([containing(OWED)]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("and a test that will not parse is named, since what it imports is unknown", async () => {
    const broken = `import { requestTimingConforms from "${KIT}";\n`;
    expect(await graded(OWES, { [TIMING_TEST]: broken })).toEqual([
      containing(`${TIMING_TEST} would not parse`),
    ]);
  });
});

// Invariant 3: the reason is the waiver, and it is refused once it waives nothing.
describe("operations-timed-otherwise", () => {
  const OTHERWISE = { operationsTimedOtherwise: "an OpenTelemetry exporter to the collector" };

  test("silences the rule on a repo that owes it", async () => {
    expect(await graded(OWES, {}, OTHERWISE)).toEqual([]);
  });

  test("and silences nothing else", async () => {
    const blind = (contents: PackageJson): void => {
      contents.dependencies = { elysia: "1.4.29" };
    };
    expect(await graded(OWES, {}, OTHERWISE, blind)).toEqual([
      containing("a live repo reports its crashes"),
    ]);
  });

  test("is refused beside a conformance test, which already meets the rule", async () => {
    expect(await graded(OWES, { [TIMING_TEST]: CONFORMS }, OTHERWISE)).toEqual([
      containing(`${TIMING_TEST} runs the conformance kit anyway`),
    ]);
  });

  test.each([
    ["a dev repo", { ...OWES, live: false }, "this repo is not live"],
    ["a repo with no database", { ...OWES, database: false }, "this repo owns no database"],
    [
      "a repo that serves no HTTP",
      { ...OWES, http: false },
      "no manifest ships elysia, next, @tanstack/react-start",
    ],
  ])("is refused on %s, which does not owe the rule", async (_what, shape, why) => {
    expect(await graded(shape, {}, OTHERWISE)).toEqual([
      containing(`${WAIVING_NOTHING} — request timing is owed by a live repo`),
    ]);
    expect(await graded(shape, {}, OTHERWISE)).toEqual([containing(why)]);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "  \n "],
  ])("and %s changes nothing", async (_what, reason) => {
    expect(await graded(OWES, {}, { operationsTimedOtherwise: reason })).toEqual([
      containing(OWED),
    ]);
    expect(
      await graded({ ...OWES, live: false }, {}, { operationsTimedOtherwise: reason }),
    ).toEqual([]);
  });

  // A repo that has not said which it is is graded against neither set of
  // rules, so the waiver on it is neither owed nor waiving nothing.
  test("is not graded on a repo with no lifecycle", async () => {
    const undeclared = (contents: PackageJson): void => {
      delete contents.lifecycle;
    };
    expect(await graded({ ...OWES, live: false }, {}, OTHERWISE, undeclared)).toEqual([
      containing("lifecycle is absent"),
    ]);
  });
});

// Invariant 9: a repo the contract holds to request timing, and that runs
// Effect, cannot pass while its Effect miscounts, and the kit's Effect check
// is what says so. Its import is read as the kit's is.
describe("the kit's Effect check is owed beside the kit where a manifest ships effect", () => {
  const CHECK = `${KIT}/effect`;
  const OWED_CHECK = "proves its Effect counts each wait in its own operation";
  const CHECK_TEST = "src/request-timing-effect.test.ts";
  const CHECKS = `import { test } from "bun:test";
import * as effect from "effect";
import { requestTimingEffectConforms } from "${CHECK}";

test("request timing counts an Effect program's waits", () => requestTimingEffectConforms(effect));
`;
  const shipsEffect = (contents: PackageJson): void => {
    contents.dependencies = { ...contents.dependencies, effect: "4.1.4" };
  };
  const noEffect = (): void => {};

  test.each([
    ["effect shipped and the check imported", shipsEffect, { [CHECK_TEST]: CHECKS }, []],
    [
      "effect shipped and the check imported dynamically",
      shipsEffect,
      {
        [CHECK_TEST]: `test("t", async () => (await import("${CHECK}")).requestTimingEffectConforms(effect));\n`,
      },
      [],
    ],
    ["effect shipped and no check", shipsEffect, {}, [containing(OWED_CHECK)]],
    [
      "effect shipped and the check imported as a type alone, which runs nothing",
      shipsEffect,
      {
        [CHECK_TEST]: `import type { EffectModule } from "${CHECK}";\nexport const m: EffectModule | undefined = undefined;\n`,
      },
      [containing(OWED_CHECK)],
    ],
    ["no effect and no check", noEffect, {}, []],
    [
      "effect a devDependency alone, which the app does not ship",
      (contents: PackageJson): void => {
        contents.devDependencies = { ...contents.devDependencies, effect: "4.1.4" };
      },
      {},
      [],
    ],
    [
      "effect in the lockfile alone, reached through another package",
      noEffect,
      { "bun.lock": '{ "packages": { "effect": ["effect@4.1.4", "", {}, ""] } }\n' },
      [],
    ],
    [
      "effect shipped by a workspace manifest and no check",
      noEffect,
      { "apps/api/package.json": JSON.stringify({ dependencies: { effect: "4.1.4" } }) },
      [containing("apps/api/package.json ships effect")],
    ],
  ])("%s", async (_what, change, extra, expected) => {
    expect(await graded(OWES, { [TIMING_TEST]: CONFORMS, ...extra }, {}, change)).toEqual(expected);
  });

  test("and with neither test, each is its own problem, and each offers the waiver", async () => {
    expect(await graded(OWES, {}, {}, shipsEffect)).toEqual([
      containing(OWED),
      containing(OWED_CHECK),
    ]);
    expect(await graded(OWES, {}, {}, shipsEffect)).toEqual([
      containing("`operations-timed-otherwise`"),
      containing("`operations-timed-otherwise`"),
    ]);
  });

  // Beside the kit's test the waiver is refused, so the problem does not offer it.
  test("and beside the kit's test, the missing check does not offer the waiver", async () => {
    const [problem] = await graded(OWES, { [TIMING_TEST]: CONFORMS }, {}, shipsEffect);
    expect(problem).toEqual(containing(OWED_CHECK));
    expect(problem).not.toContain("operations-timed-otherwise");
  });

  test("and nothing is owed of a repo that does not owe the kit", async () => {
    expect(await graded({ ...OWES, live: false }, {}, {}, shipsEffect)).toEqual([]);
  });

  const OTHERWISE = { operationsTimedOtherwise: "an OpenTelemetry exporter to the collector" };

  test.each([
    ["effect shipped and no check", shipsEffect],
    ["no effect and no check", noEffect],
  ])("operations-timed-otherwise waives it with the kit: %s", async (_what, change) => {
    expect(await graded(OWES, {}, OTHERWISE, change)).toEqual([]);
  });

  // One answer says how the operations are timed: a test running the check is
  // as much an answer as one running the kit.
  test("operations-timed-otherwise is refused beside a test that runs the check", async () => {
    expect(await graded(OWES, { [CHECK_TEST]: CHECKS }, OTHERWISE, shipsEffect)).toEqual([
      containing(`${CHECK_TEST} runs the kit's Effect check anyway`),
    ]);
  });
});
