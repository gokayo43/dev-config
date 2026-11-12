import { describe, expect, test } from "bun:test";

import { type Diagnostic, gradedByBase } from "./lint-fixture.ts";

/**
 * The house picks the base states as lint policy, graded where each of them is
 * decided: by the file a source sits in, since two of these bans hold in one
 * directory and not another, and by the message, since a ban whose diagnostic
 * does not name what the import lost to is a rule the next person argues with.
 *
 * One tree, one oxlint run, one file per case — the shape `lint-fixture.ts`
 * exists for. The config is the shipped base rather than a copy: what is being
 * asked here is what a repo extending it inherits, and a copy answers about
 * itself.
 *
 * Two carriers appear below and the difference between them is the subject of
 * half these cases. A ban that holds in every file is an entry in
 * `no-restricted-imports`; a ban a file's position decides is a rule of the
 * plugin, because a scalar setting in an override replaces only itself while a
 * redefined list replaces every entry it did not restate — a consuming repo's
 * own among them (`oxlint-base.test.ts` grades that half).
 */

/** What each ban carried as a list entry says instead, which is the config's own text. */
const CASE_SETUP =
  "Set a case up with a call it makes itself, and tear it down with `await using` — " +
  "beforeAll/afterAll stay for shared immutable resources.";
const SWEEP =
  "Import `test` from @gokayo43/dev-config/invariant-sweep — the sweep's fixture checks " +
  "every page a spec opens for console errors, uncaught errors and overflow. `expect` and the " +
  "rest of the module are unchanged.";
const BUDGET =
  "Import `check` from @gokayo43/dev-config/property — it multiplies every property's run " +
  "count by PROPERTY_RUNS_FACTOR, which is what lets one run search a hundred times as far as " +
  "another. The default export is refused with it because `fc.assert` reaches the same call: " +
  "import the generators by name.";

/** And what each plugin rule says, which is the rule's own. */
const MEMOISATION =
  "The React Compiler owns memoisation: delete the wrapper and use the value directly.";
const NAMED_HOOK = "Move this effect into a named hook under `hooks/`";
const LOADER = "A route's data is the loader's";

/** What all three say instead on a line that re-exports a module whole, which holds no use to change. */
const BY_NAME = "re-export by name only what this barrel needs";

/** Every React hook the base has an opinion about, in one import. */
const REACT_HOOKS = `import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
export const used = [
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
];
`;

/** The same import under a second export name, for a file that holds both halves. */
const REACT_HOOKS_AGAIN = REACT_HOOKS.replace("export const used", "export const also");

/** Both halves of the query pick: the two the loader owns, and the two it does not. */
const QUERY_HOOKS = `import {
  useInfiniteQuery,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
export const used = [useInfiniteQuery, useQuery, useSuspenseInfiniteQuery, useSuspenseQuery];
`;

/**
 * The members of a union wide enough that the classic count alone puts an
 * exhaustive mapping over the limit: twenty-four cases are twenty-five under
 * that count and two under this one.
 */
const LETTERS = "abcdefghijklmnopqrstuvwx".split("");

/** That union answered exhaustively, which is one decision written twenty-four ways. */
const EXHAUSTIVE_SWITCH =
  `type Suit =\n` +
  LETTERS.map((each) => `  | "${each}"\n`).join("") +
  `  ;\n` +
  `export function label(suit: Suit): string {\n` +
  `  switch (suit) {\n` +
  LETTERS.map((each) => `    case "${each}":\n      return "${each}";\n`).join("") +
  `    default:\n      return "";\n` +
  `  }\n` +
  `}\n`;

/** Twenty-one branches nobody wrote as a mapping: one decision per `if`. */
const BRANCHES =
  `export function pick(value: number): number {\n` +
  Array.from({ length: 21 }, (_, at) => `  if (value === ${at}) return ${at};\n`).join("") +
  `  return -1;\n` +
  `}\n`;

/** A body nested `depth` blocks deep, which is the whole of what `max-depth` counts. */
function nested(depth: number): string {
  const open = Array.from(
    { length: depth },
    (_, at) => `${"  ".repeat(at + 1)}if (value > ${at}) {\n`,
  );
  const close = Array.from({ length: depth }, (_, at) => `${"  ".repeat(depth - at)}}\n`);
  return (
    `export function deep(value: number): number {\n` +
    open.join("") +
    `${"  ".repeat(depth + 1)}return value;\n` +
    close.join("") +
    `  return 0;\n` +
    `}\n`
  );
}

/** The line of `ASSERTIONS` holding the one assertion in it, counted from 1. */
const ASSERTED_AT = 5;

/** The three shapes `consistent-type-assertions` has to tell apart. */
const ASSERTIONS = `interface Shape {
  readonly a: number;
}
declare const wide: unknown;
export const narrowed = wide as Shape;
export const modes = ["a", "b"] as const;
export const shaped = { a: 1 } satisfies Shape;
`;

/** The line of `NULLISH` holding the comparison `{ "null": "ignore" }` does not forgive. */
const LOOSE_AT = 3;

/** Both halves of the `eqeqeq` pick: the nullish check it keeps, and the one it refuses. */
const NULLISH = `declare const value: string | undefined;
export const missing = value == null;
export const one = value == "1";
`;

/**
 * A `catch` that reads the error it was handed into a message and then throws
 * without chaining it — the shape that loses the stack while looking like it
 * kept the information.
 */
const RETHROW = `export function run(fn: () => void): void {
  try {
    fn();
  } catch (cause) {
    throw new Error(\`failed: \${String(cause)}\`);
  }
}
`;

/** A filter-then-index, which is what the `perf` tier's rules look like. */
const PERF = `export function first(rows: readonly number[]): number | undefined {
  return rows.filter((r) => r > 2)[0];
}
`;

/** A console call in ordinary source, outside any server directory. */
const CONSOLE = `export function note(v: string): void {
  console.log(v);
}
`;

/** A dependency the effect reads and the list omits — the whole of what `exhaustive-deps` says. */
const MISSING_DEP = `import { useEffect, useState } from "react";
export function useRows(n: number) {
  const [rows, setRows] = useState<number[]>([]);
  useEffect(() => {
    const id = setTimeout(() => setRows([n]), 0);
    return () => clearTimeout(id);
  }, []);
  return rows;
}
`;

const TREE = {
  "src/nullish.ts": NULLISH,
  "src/hooks/use-rows.tsx": MISSING_DEP,
  "src/rethrow.ts": RETHROW,
  "src/logging.ts": CONSOLE,
  "src/first.ts": PERF,

  "switching.ts": EXHAUSTIVE_SWITCH,
  "branching.ts": BRANCHES,
  "nested-five.ts": nested(5),
  "nested-four.ts": nested(4),

  "src/panel.ts": REACT_HOOKS,
  "src/hooks/use-panel.ts": REACT_HOOKS,
  "hooks/use-root.ts": REACT_HOOKS,
  "src/hooks-like.ts": REACT_HOOKS,

  "src/renamed.ts": `import { useEffect as subscribe } from "react";
export const used = subscribe;
`,
  "src/namespaced.ts": `import * as React from "react";
export const used = [React.useLayoutEffect, React.useMemo];
`,
  "src/destructured.ts": `import * as React from "react";
const { useSyncExternalStore } = React;
export const used = useSyncExternalStore;
`,
  "src/deferred.ts": `const react = await import("react");
export const used = react.useEffect;
`,
  "src/barrel.ts": `export { useEffect, useLayoutEffect } from "react";
`,
  "src/everything.ts": `export * from "react";
`,
  "src/default-barrel.ts": `export { default as React } from "react";
`,
  "src/routes/everything.ts": `export * from "@tanstack/react-query";
`,
  "src/typed.ts": `import type { useEffect } from "react";
import { type useLayoutEffect, useState } from "react";
export type Effect = typeof useEffect;
export type Layout = typeof useLayoutEffect;
export const held = useState;
`,
  "src/typed-memo.ts": `import type { useMemo } from "react";
export type Memo = typeof useMemo;
`,
  "src/namespace-only.ts": `import * as React from "react";
export const element = React.createElement;
`,
  "src/memo-spellings.ts": `import { useCallback as stable } from "react";
import React from "react";
const { useMemo } = React;
const later = await import("react");
export const used = [stable, useMemo, later.useCallback];
`,
  "src/memo-barrel.ts": `export { useMemo } from "react";
`,

  "src/routes/index.ts": `${QUERY_HOOKS}${REACT_HOOKS_AGAIN}`,
  "src/routes/queries.ts": `export { useInfiniteQuery, useQuery } from "@tanstack/react-query";
`,
  "src/routes/deferred.ts": `const query = await import("@tanstack/react-query");
export const used = query.useQuery;
`,
  "src/widget.ts": QUERY_HOOKS,
  "src/routes/dashboard/hooks/use-filters.ts": `${QUERY_HOOKS}${REACT_HOOKS_AGAIN}`,
  "src/hooks/routes/use-nested.ts": `${QUERY_HOOKS}${REACT_HOOKS_AGAIN}`,

  "case.test.ts": `import { afterAll, afterEach, beforeAll, beforeEach, test } from "bun:test";
export const used = [afterAll, afterEach, beforeAll, beforeEach, test];
${ASSERTIONS}`,

  "e2e/home.spec.ts": `import { test } from "@playwright/test";
export const used = test;
`,
  "e2e/renamed.spec.ts": `import { test as base } from "@playwright/test";
export const used = base;
`,
  "e2e/namespaced.spec.ts": `import * as playwright from "@playwright/test";
export const used = playwright.test;
`,
  "e2e/fixtures.ts": `import { test } from "@playwright/test";
export const used = test;
`,
  "e2e/asserting.spec.ts": `import { expect } from "@playwright/test";
export const used = expect;
`,
  "playwright.config.ts": `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ projects: [{ name: "desktop", use: devices["Desktop Chrome"] }] });
`,
  "tests/harness.ts": ASSERTIONS,
  "src/asserting.ts": ASSERTIONS,

  "src/domain/total.property.test.ts": `import { assert, integer, property } from "fast-check";
export const used = [assert, property, integer];
`,
  "src/domain/rounding.property.test.ts": `import fc from "fast-check";
export const used = fc.assert;
`,
  "src/domain/money.property.test.ts": `import * as fc from "fast-check";
export const used = fc.assert;
`,
  "src/domain/generators.ts": `import { integer, property } from "fast-check";
export const used = [integer, property];
`,
  "src/domain/legacy-runner.ts": `import { assert } from "fast-check";
export const used = assert;
`,
};

const REPORTED = await gradedByBase(TREE);

function reportedIn(file: string): readonly Diagnostic[] {
  return REPORTED.get(file) ?? [];
}

/** What a file drew, as the rule and the severity it drew it at. */
function drawnIn(file: string): string[] {
  return reportedIn(file).map(({ severity, code }) => `${severity} ${code}`);
}

/**
 * The three ways a refusal names its subject: the plugin rules interpolate
 * `name from module` into a message of their own, and `no-restricted-imports`
 * quotes the specifier it refused — or, for an import that names none, the whole
 * restricted list it is invalid because of.
 */
const NAMED = [/`([\w, ]+) from [^`]+`/, /'([^']+)' import from/, /because '([^']+)' from/];

/**
 * The names refused in a file, in source order, whichever carrier refused them —
 * so a case that moved from one carrier to the other keeps its assertion.
 *
 * A diagnostic none of the three patterns reads is refused rather than dropped:
 * a projection that silently skips what it cannot name turns a rule whose
 * message changed into a file that suddenly refuses nothing.
 */
function refusedIn(file: string): string[] {
  return reportedIn(file)
    .filter(({ code }) => code.includes("no-restricted-imports") || code.includes("anti-slop"))
    .map(({ message }) => {
      const named = NAMED.map((pattern) => pattern.exec(message)?.[1]).find(
        (name) => name !== undefined,
      );
      if (named === undefined) throw new Error(`no name to read out of: ${message}`);
      return named;
    });
}

/** What a file's diagnostics told the reader to do instead, deduplicated. */
function adviceIn(file: string): string[] {
  return [...new Set(reportedIn(file).map(({ help, message }) => (help === "" ? message : help)))];
}

/** Whether anything a file drew says what it is about — the message, not the code. */
function saidIn(file: string, fragment: string): boolean {
  return adviceIn(file).some((each) => each.includes(fragment));
}

describe("the shape of a decision", () => {
  // The classic count charges a `case` each, so an exhaustive switch over a
  // union of any size is over the limit by being written at all — and the
  // repo's answer to that would be to stop writing the total mapping the
  // type-aware `switch-exhaustiveness-check` asks for.
  test("an exhaustive switch is one decision, not one per case", () => {
    expect(drawnIn("switching.ts")).toEqual([]);
  });

  test("twenty-one branches in one function are twenty-one decisions", () => {
    expect(drawnIn("branching.ts")).toEqual(["error eslint(complexity)"]);
  });

  test("five nested blocks deny, and four are the limit rather than the first refusal", () => {
    expect(drawnIn("nested-five.ts")).toEqual(["error eslint(max-depth)"]);
    expect(drawnIn("nested-four.ts")).toEqual([]);
  });
});

describe("memoisation", () => {
  test("is the compiler's, in ordinary source", () => {
    expect(refusedIn("src/panel.ts")).toContain("useCallback");
    expect(refusedIn("src/panel.ts")).toContain("useMemo");
    expect(saidIn("src/panel.ts", MEMOISATION)).toBe(true);
  });

  // A ban with no exception: a hand-written memo inside a hook is the same memo
  // the compiler already inserted.
  test("and is still the compiler's inside a hook, at any depth", () => {
    expect(refusedIn("src/hooks/use-panel.ts")).toEqual(["useCallback", "useMemo"]);
    expect(refusedIn("hooks/use-root.ts")).toEqual(["useCallback", "useMemo"]);
  });

  // A rule reading only named specifiers is one spelling away from off.
  test("through a namespace import, at the read rather than at the import", () => {
    expect(refusedIn("src/namespaced.ts")).toContain("useMemo");
    expect(saidIn("src/namespaced.ts", MEMOISATION)).toBe(true);
  });

  // How shadcn's components import React, and the reason the ban left
  // `no-restricted-imports`, which refused the import before anything was read.
  test("while a namespace import with no memo read off it draws nothing", () => {
    expect(drawnIn("src/namespace-only.ts")).toEqual([]);
  });

  test.each([
    ["src/memo-spellings.ts", ["useCallback", "useMemo", "useCallback"]],
    ["src/memo-barrel.ts", ["useMemo"]],
  ])("and through every other spelling that reaches it, in %s", (path, names) => {
    expect(refusedIn(path)).toEqual(names);
  });

  test("while the hooks React owns outright are left alone", () => {
    expect(refusedIn("src/panel.ts")).not.toContain("useState");
  });

  // `typeof useMemo` in a signature borrows the type without reaching the
  // value, which the list carrier this ban left could not tell apart.
  test("and a type-only import of one is not a memo at all", () => {
    expect(drawnIn("src/typed-memo.ts")).toEqual([]);
  });
});

describe("an effect", () => {
  test("is refused in ordinary source, by all three of its names", () => {
    expect(refusedIn("src/panel.ts")).toEqual([
      "useCallback",
      "useEffect",
      "useLayoutEffect",
      "useMemo",
      "useSyncExternalStore",
    ]);
    expect(saidIn("src/panel.ts", NAMED_HOOK)).toBe(true);
  });

  // The directory is what grants it, at any depth including none — and the
  // directory rather than the name, which is the exemption a glob like
  // `**/hooks*` would hand to every file that merely reads like one.
  test("and is granted by the directory it lives in, wherever that sits", () => {
    expect(refusedIn("src/hooks/use-panel.ts")).not.toContain("useEffect");
    expect(refusedIn("hooks/use-root.ts")).not.toContain("useEffect");
    expect(refusedIn("src/hooks-like.ts")).toContain("useEffect");
  });

  // Four spellings that reach the same value without importing its name, each
  // of which is one edit away from a rule that reads only the import statement.
  test.each([
    ["src/renamed.ts", "renamed on the way in, where the name that crosses is the key"],
    ["src/namespaced.ts", "read off the namespace, which imports no name at all"],
    ["src/destructured.ts", "destructured off it, which forms no member expression"],
    ["src/deferred.ts", "taken later, off a dynamic import of the same module"],
  ])("is refused in %s — %s", (path) => {
    expect(saidIn(path, NAMED_HOOK)).toBe(true);
  });

  // A barrel re-exports the name under a relative specifier the far side's rule
  // cannot follow — silent at both ends unless it is refused at this one.
  test("and at a barrel that re-exports it, by name or by star", () => {
    expect(refusedIn("src/barrel.ts")).toEqual(["useEffect", "useLayoutEffect"]);
    // `export *` carries the memo pair too, so the memo rule refuses the same
    // line, one diagnostic each.
    expect(drawnIn("src/everything.ts").toSorted()).toEqual([
      "error anti-slop(no-manual-memoization)",
      "error anti-slop(no-unnamed-effects)",
    ]);
  });

  // No wrapper sits on a line that hands the module on whole and no effect
  // waits to move, so each rule says the one thing that line can change.
  test.each(["src/everything.ts", "src/default-barrel.ts", "src/routes/everything.ts"])(
    "and %s, which hands on the whole module, is told to re-export by name",
    (path) => {
      expect(reportedIn(path).length).toBeGreaterThan(0);
      expect(adviceIn(path).every((advice) => advice.includes(BY_NAME))).toBe(true);
    },
  );

  // The one use of these names that survives the pick they lost to: a signature
  // borrowing the type without reaching the value. The plugin rule can tell,
  // which is half of why the positional bans are carried there.
  test("while a type-only import of one is not an effect at all", () => {
    expect(drawnIn("src/typed.ts")).toEqual([]);
  });
});

describe("a route's data", () => {
  test("comes through the loader, so the raw pair is refused there", () => {
    expect(refusedIn("src/routes/index.ts")).toContain("useQuery");
    expect(refusedIn("src/routes/index.ts")).toContain("useInfiniteQuery");
    expect(saidIn("src/routes/index.ts", LOADER)).toBe(true);
  });

  test("while the suspense pair the pattern names stays legal", () => {
    expect(refusedIn("src/routes/index.ts")).not.toContain("useSuspenseQuery");
    expect(refusedIn("src/routes/index.ts")).not.toContain("useSuspenseInfiniteQuery");
  });

  // A rule scoped by a block still has to hold against the spellings that reach
  // the value without importing its name, inside the files it is scoped to.
  test("through a barrel inside the routes, and through a dynamic import", () => {
    expect(refusedIn("src/routes/queries.ts")).toEqual(["useInfiniteQuery", "useQuery"]);
    expect(refusedIn("src/routes/deferred.ts")).toEqual(["useQuery"]);
  });

  test("is a route's, not every component's: fetching on interaction is what raw useQuery is for", () => {
    expect(refusedIn("src/widget.ts")).toEqual([]);
  });

  // A hook colocated under `routes/` is a hook: it is where an effect belongs
  // and where data fetched on interaction is fetched. The `hooks/` block is last
  // for this, and the inverted nesting is the same answer for the same reason —
  // the innermost grant is not what decides it, the block order is, and a
  // directory called `routes` under `hooks/` is still a hook's.
  test.each(["src/routes/dashboard/hooks/use-filters.ts", "src/hooks/routes/use-nested.ts"])(
    "and %s is a hook, whichever directory sits inside the other",
    (path) => {
      expect(refusedIn(path)).toEqual(["useCallback", "useMemo"]);
    },
  );
});

describe("a case's setup", () => {
  test("is the case's own, so the per-case hooks are refused", () => {
    expect(refusedIn("case.test.ts")).toEqual(["afterEach", "beforeEach"]);
    expect(adviceIn("case.test.ts")).toContain(CASE_SETUP);
  });

  test("while the once-per-file pair stays legal, which is what a shared resource has", () => {
    expect(refusedIn("case.test.ts")).not.toContain("beforeAll");
    expect(refusedIn("case.test.ts")).not.toContain("afterAll");
  });
});

describe("a page a spec opens", () => {
  // The one name of that module the sweep replaces. What the ban buys is that
  // the three invariants are a property of visiting a page at all, rather than
  // assertions every spec has to remember — so the spec that forgot the import
  // is exactly the spec they would be missing from.
  test("is swept, so Playwright's own `test` is refused in a spec", () => {
    expect(refusedIn("e2e/home.spec.ts")).toEqual(["test"]);
    expect(adviceIn("e2e/home.spec.ts")).toContain(SWEEP);
  });

  // Renamed is the spelling the fixture module itself uses, and a namespace
  // import names no specifier at all — one edit away from a rule that reads
  // only the import statement.
  test.each(["e2e/renamed.spec.ts", "e2e/namespaced.spec.ts"])(
    "including in %s, which reaches the name without importing it plainly",
    (path) => {
      expect(saidIn(path, SWEEP)).toBe(true);
    },
  );

  // The ban holds in every file, which is why it is carried as a list entry: a
  // fixture module beside the specs is where an unswept `test` would be wrapped
  // once and inherited by every spec that imports it.
  test("and in a helper beside the specs, which is not a spec file at all", () => {
    expect(refusedIn("e2e/fixtures.ts")).toEqual(["test"]);
  });

  // What is banned is the name, not the module: the assertion library is
  // Playwright's and so is the config's own builder.
  test.each(["e2e/asserting.spec.ts", "playwright.config.ts"])(
    "while %s keeps the rest of the module",
    (path) => {
      expect(drawnIn(path)).toEqual([]);
    },
  );
});

describe("how far a property searches", () => {
  // The dial is the house budget's, so the call every property goes through has
  // to be the one that reads it. A test calling `fc.assert` runs the number its
  // author typed, whatever the run asked for — which is the state the fleet was
  // in when this entry was written.
  test("is the run's to decide, so fast-check's own `assert` is refused", () => {
    expect(refusedIn("src/domain/total.property.test.ts")).toEqual(["assert"]);
    expect(adviceIn("src/domain/total.property.test.ts")).toContain(BUDGET);
  });

  // The spelling the fleet actually writes, and the reason the entry names the
  // default export as well: `fc.assert` off a default import reaches the same
  // call without ever naming it, and an entry listing only `assert` would have
  // been a ban on one file in thirteen.
  test.each(["src/domain/rounding.property.test.ts", "src/domain/money.property.test.ts"])(
    "including %s, which reaches the call without importing its name",
    (path) => {
      expect(saidIn(path, BUDGET)).toBe(true);
    },
  );

  // What is banned is the call, not the library: the generators are the whole
  // point of the dependency and come in by name.
  test("while the generators are untouched, which is what the module is for", () => {
    expect(drawnIn("src/domain/generators.ts")).toEqual([]);
  });

  // The ban holds in every file, which is why it is carried as a list entry: a
  // helper beside the suite is where an unbudgeted `assert` would be wrapped
  // once and called by every property in the repo.
  test("and it holds outside a test file, where a wrapper would otherwise sit", () => {
    expect(refusedIn("src/domain/legacy-runner.ts")).toEqual(["assert"]);
  });
});

describe("a type assertion", () => {
  test("is refused in source, where an annotation makes the same claim and is checked", () => {
    expect(drawnIn("src/asserting.ts")).toEqual(["error typescript(consistent-type-assertions)"]);
  });

  // `never` is the only setting that refuses assertions at all, and a base that
  // took `as const` with them would be banning the narrowing rather than the
  // override — every literal table in the fleet. Graded by WHICH line drew the
  // one diagnostic, so that a rule reporting the `as const` two lines down
  // instead is a failure rather than the same count.
  test("but `as const` and `satisfies` are not assertions in that sense", () => {
    expect(reportedIn("src/asserting.ts").map(({ line }) => line)).toEqual([ASSERTED_AT]);
  });

  test("and a suite asserts about values nothing typed, including from its helpers", () => {
    expect(drawnIn("case.test.ts").filter((each) => each.includes("consistent-type"))).toEqual([]);
    expect(drawnIn("tests/harness.ts")).toEqual([]);
  });
});

describe("a re-throw that drops its cause", () => {
  // Not stated in the base's own rules: `suspicious` carries it, and the base
  // restating a tier rule it agrees with is a precedent with no stopping point.
  // What the case is for is that the ban is live at all — the tier is the
  // carrier, so the tier is what has to be shown carrying it.
  test("is refused through the tier that carries it, unstated by the base", () => {
    expect(drawnIn("src/rethrow.ts")).toEqual(["error eslint(preserve-caught-error)"]);
  });
});

describe("a perf hint", () => {
  // The one tier deliberately left advisory while `no-console` and
  // `prefer-nullish-coalescing` were promoted out of it, so the exception is
  // graded rather than only argued: a perf rule's advice is a claim about
  // shared state and input size it cannot see, and at `error` it would be
  // answered by disables carrying a measurement nobody took. Graded by the
  // severity, since that is the entire content of the decision.
  test("advises rather than denies, which is the whole of why the tier stayed", () => {
    expect(drawnIn("src/first.ts")).toEqual(["warning unicorn(prefer-array-find)"]);
  });
});

describe("a console call", () => {
  // Promoted from `warn` for the reason the warn tier carries generally: it
  // could not fail a build, so every one of them was a line in a report. The
  // base states it once, at the top level, and no block raises it further for
  // server code, so a source file anywhere is the case. Graded by the severity.
  test("denies in ordinary source, with no server directory needed", () => {
    expect(drawnIn("src/logging.ts")).toEqual(["error eslint(no-console)"]);
  });
});

describe("a dependency list", () => {
  // `warn` cannot fail a build — oxlint exits 0 with warnings outstanding and
  // no `--max-warnings` is passed anywhere — so a dependency the compiler
  // infers differently from the one written was a line in a report nobody was
  // required to drive to zero. Graded by the severity, which is the whole diff.
  //
  // Both rules deny it, which is the one place the base carries two errors over
  // one line deliberately: the case above pins what each of them reaches that
  // the other does not.
  test("is a gate rather than a report, now that it denies", () => {
    expect(drawnIn("src/hooks/use-rows.tsx").toSorted()).toEqual([
      "error react(exhaustive-effect-dependencies)",
      "error react-hooks(exhaustive-deps)",
    ]);
  });
});

describe("a loose comparison", () => {
  test("is refused, because the strict one makes the same claim and checks it", () => {
    expect(drawnIn("src/nullish.ts")).toEqual(["error eslint(eqeqeq)"]);
  });

  // `{ "null": "ignore" }` is the whole of the exception, and the default is
  // `always` — which would refuse the nullish check on the line above too.
  // Graded by WHICH line drew the one diagnostic, so a rule that took both is a
  // failure rather than the same count.
  test("except against `null`, which is the one comparison it cannot restate", () => {
    expect(reportedIn("src/nullish.ts").map(({ line }) => line)).toEqual([LOOSE_AT]);
  });
});
