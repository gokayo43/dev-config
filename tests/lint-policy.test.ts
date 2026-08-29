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
const MEMOISATION =
  "React Compiler owns memoisation — delete the wrapper and use the value directly.";
const CASE_SETUP =
  "Set a case up with a call it makes itself, and tear it down with `await using` — " +
  "beforeAll/afterAll stay for shared immutable resources.";

/** And what each plugin rule says, which is the rule's own. */
const NAMED_HOOK = "Move this effect into a named hook under `hooks/`";
const LOADER = "A route's data is the loader's";

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

/**
 * One case per judgement the React Compiler makes, keyed by the rule
 * `eslint-plugin-react-hooks` splits that judgement out as. oxlint ports the
 * compiler rather than the rules, so every one of them arrives under
 * `react/react-compiler` and says which it was in the prefix on its message —
 * which is the fact this table exists to hold. A judgement the port stopped
 * carrying would otherwise leave the one rule name in the base switched on and
 * answering for nothing.
 *
 * Source and expectation sit in one entry so that a case cannot be half
 * written: a fixture with no prefix to match would be a file in the tree that
 * nothing reads, and a prefix with no fixture an assertion nothing runs.
 */
const COMPILER = {
  purity: {
    prefix: "Purity:",
    source: `export function Panel(props: { readonly n: number }) {
  const roll = Math.random();
  return <p data-n={props.n}>{roll}</p>;
}
`,
  },
  immutability: {
    prefix: "Immutability:",
    source: `export function Config(props: { readonly cfg: { a: number } }) {
  props.cfg.a = 3;
  return <p>{props.cfg.a}</p>;
}
`,
  },
  "set-state-in-render": {
    prefix: "RenderSetState:",
    source: `import { useState } from "react";
export function Counter(props: { readonly n: number }) {
  const [v, setV] = useState(0);
  setV(props.n);
  return <p>{v}</p>;
}
`,
  },
  "set-state-in-effect": {
    prefix: "EffectSetState:",
    source: `import { useEffect, useState } from "react";
export function useMirror(n: number) {
  const [v, setV] = useState(0);
  useEffect(() => {
    setV(n);
  });
  return v;
}
`,
  },
  refs: {
    prefix: "Refs:",
    source: `import { useRef } from "react";
export function Focus() {
  const box = useRef<HTMLInputElement>(null);
  return <input ref={box} data-had={String(box.current)} />;
}
`,
  },
  globals: {
    prefix: "Globals:",
    source: `let seen = 0;
export function Seen(props: { readonly n: number }) {
  seen += props.n;
  return <p>{seen}</p>;
}
`,
  },
  "static-components": {
    prefix: "StaticComponents:",
    source: `export function Outer(props: { readonly n: number }) {
  function Inner() {
    return <span>{props.n}</span>;
  }
  return (
    <div>
      <Inner />
    </div>
  );
}
`,
  },
  "error-boundaries": {
    prefix: "ErrorBoundaries:",
    source: `export function Guarded(props: { readonly n: number }) {
  try {
    return <p>{props.n}</p>;
  } catch {
    return <p>failed</p>;
  }
}
`,
  },
  "use-memo": {
    prefix: "UseMemo:",
    source: `import { useMemo } from "react";
export function useTotal(a: number) {
  return useMemo(() => a + 1, [a + 1]);
}
`,
  },
  "void-use-memo": {
    prefix: "VoidUseMemo:",
    source: `import { useMemo } from "react";
export function useNoted(n: number) {
  useMemo(() => {
    globalThis.reportError(new Error(String(n)));
  }, [n]);
  return n;
}
`,
  },
  "preserve-manual-memoization": {
    prefix: "PreserveManualMemo:",
    source: `import { useMemo } from "react";
export function useMaybe(a: number, on: boolean) {
  return on ? useMemo(() => a, [a]) : 0;
}
`,
  },
  hooks: {
    prefix: "Hooks:",
    source: `import { useState } from "react";
export function Cond(props: { readonly on: boolean }) {
  if (props.on) {
    const [v] = useState(0);
    return <p>{v}</p>;
  }
  return <p>off</p>;
}
`,
  },
  "capitalized-calls": {
    prefix: "CapitalizedCalls:",
    source: `function Helper(n: number) {
  return n + 1;
}
export function Sum(props: { readonly n: number }) {
  return <p>{Helper(props.n)}</p>;
}
`,
  },
  invariant: {
    prefix: "Invariant:",
    source: `export function Holder(props: { readonly n: number }) {
  class Box {
    readonly at = props.n;
  }
  return <p>{new Box().at}</p>;
}
`,
  },
  "unsupported-syntax": {
    prefix: "Todo:",
    source: `export function Saving(props: { readonly n: number }) {
  let done = 0;
  try {
    done = props.n;
  } finally {
    done += 1;
  }
  return <p>{done}</p>;
}
`,
  },
};

/**
 * The path each is graded at, derived from the key rather than stored beside
 * it: the tree is built by `Object.fromEntries`, where two entries naming one
 * file collapse to whichever was written last and the case for the other passes
 * on its neighbour's diagnostics. A key is unique because the object is.
 *
 * Under `hooks/`, which is where the effect and query bans say nothing — so
 * what a case draws is the compiler's judgement and not the base's opinion of
 * where an effect belongs.
 */
function compilerPath(rule: string): string {
  return `src/hooks/${rule}.tsx`;
}

/**
 * The orchestrator's probe, which is the shape that opened this: a component
 * that rolls a die during render, writes through its own props, and compares
 * loosely. Under the base as it shipped before this set it drew nothing at all.
 */
const PROBE = `export function Panel(props: { readonly cfg: { a: number }; readonly n: number }) {
  const roll = Math.random();
  props.cfg.a = 3;
  return <p data-n={props.n == 1 ? roll : 0} />;
}
`;

/** The line of `NULLISH` holding the comparison `{ "null": "ignore" }` does not forgive. */
const LOOSE_AT = 3;

/** Both halves of the `eqeqeq` pick: the nullish check it keeps, and the one it refuses. */
const NULLISH = `declare const value: string | undefined;
export const missing = value == null;
export const one = value == "1";
`;

/**
 * A hook called from a function that is neither a component nor a hook — the
 * half of the rules of hooks the compiler never reaches, because it is not a
 * component and so is not compiled.
 */
const NON_COMPONENT = `import { useState } from "react";
export function helper() {
  const [v] = useState(0);
  return v;
}
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

/** A console call in ordinary source, where the base's server override does not reach. */
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
  ...Object.fromEntries(
    Object.entries(COMPILER).map(([rule, { source }]) => [compilerPath(rule), source]),
  ),
  "src/probe.tsx": PROBE,
  "src/nullish.ts": NULLISH,
  "src/hooks/use-rows.tsx": MISSING_DEP,
  "src/hooks/non-component.ts": NON_COMPONENT,
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
  "src/typed.ts": `import type { useEffect } from "react";
import { type useLayoutEffect, useState } from "react";
export type Effect = typeof useEffect;
export type Layout = typeof useLayoutEffect;
export const held = useState;
`,
  "src/typed-memo.ts": `import type { useMemo } from "react";
export type Memo = typeof useMemo;
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
  "tests/harness.ts": ASSERTIONS,
  "src/asserting.ts": ASSERTIONS,
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

/**
 * What the compiler said about a file, as the judgement each message opens
 * with. The prefix is how one rule name answers for a dozen, so it is what a
 * case reads rather than the code every one of them shares.
 */
function judgedIn(file: string): string[] {
  return reportedIn(file)
    .filter(({ code }) => code.includes("react-compiler"))
    .map(({ severity, message }) => `${severity} ${message.split(" ")[0] ?? ""}`);
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
    expect(adviceIn("src/panel.ts")).toContain(MEMOISATION);
  });

  // The ban with no exception is the one that can be carried as a list entry,
  // and this is what "no exception" means: a hand-written memo inside a hook is
  // the same memo the compiler already inserted.
  test("and is still the compiler's inside a hook, at any depth", () => {
    expect(refusedIn("src/hooks/use-panel.ts")).toEqual(["useCallback", "useMemo"]);
    expect(refusedIn("hooks/use-root.ts")).toEqual(["useCallback", "useMemo"]);
  });

  // A rule reading only named specifiers is one spelling away from off.
  test("through a namespace import, which names no specifier at all", () => {
    expect(refusedIn("src/namespaced.ts")).toContain("useMemo, useCallback");
    expect(saidIn("src/namespaced.ts", MEMOISATION)).toBe(true);
  });

  test("while the hooks React owns outright are left alone", () => {
    expect(refusedIn("src/panel.ts")).not.toContain("useState");
  });

  // The price of the list carrier, pinned rather than left as folklore:
  // `no-restricted-imports` has no way to allow a type-only import of a name it
  // refuses. Neither of these two has a use as a type, so the cost is nothing —
  // and the day one does, this case is what says the carrier has to change.
  test("and a type-only import of one is refused too, which this carrier cannot allow", () => {
    expect(refusedIn("src/typed-memo.ts")).toEqual(["useMemo"]);
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
    // `export *` carries the memo pair too, which is the other carrier saying
    // the same thing about the same line.
    expect(refusedIn("src/everything.ts")).toContain("everything");
  });

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

describe("what the React Compiler declines to optimize", () => {
  // The shape that opened this: the base mandated the compiler in every repo
  // and then graded none of its judgements, so a component that rolls a die
  // during render and writes through its own props passed the gate clean.
  test("the probe that passed: an impure render, a props write, and a loose compare", () => {
    expect(judgedIn("src/probe.tsx")).toEqual(["error Purity:", "error Immutability:"]);
    expect(drawnIn("src/probe.tsx")).toContain("error eslint(eqeqeq)");
  });

  // A dozen-odd rule names upstream, one rule name here. Enabling that one is
  // the whole of the wiring, so what has to be graded is that it still answers
  // for each of them — a judgement oxlint's port stopped carrying would leave
  // the base switched on and silent, which is the state this set exists to end.
  //
  // Exactly one judgement per fixture, not merely the right one among several:
  // a case that tolerated extra diagnostics would pass on a rule that had begun
  // reporting the same code twice, which is the shape this base refuses
  // everywhere else.
  test.each(Object.entries(COMPILER))("%s", (rule, { prefix }) => {
    expect(judgedIn(compilerPath(rule))).toEqual([`error ${prefix}`]);
  });

  // The one judgement that is off by default, and the reason the rule is
  // configured rather than switched on: a component the compiler declined to
  // compile at all is not a violation, so without `reportAllBailouts` it draws
  // nothing and reads as optimized. Every other case in this block passes with
  // the option missing, which is what makes this the case that carries it.
  test("a component the compiler skipped is a diagnostic, not a silence", () => {
    const path = compilerPath("unsupported-syntax");
    expect(judgedIn(path)).toEqual(["error Todo:"]);
    // And it names the construct rather than only the fact, which is what makes
    // a bail-out answerable at all — the compiler's internal path to it is
    // upstream's to reword, so the case reads the syntax and not the prefix.
    expect(reportedIn(path)[0]?.message ?? "").toContain("TryStatement");
  });

  // The memo ban and the compiler's memo judgements are not the same rule
  // saying one thing twice: the ban refuses the import, and these two grade the
  // memo that survives a disable carrying its reason.
  test("and a hand-written memo is graded, not only refused", () => {
    const path = compilerPath("preserve-manual-memoization");
    expect(refusedIn(path)).toEqual(["useMemo"]);
    expect(judgedIn(path)).toEqual(["error PreserveManualMemo:"]);
  });

  // `Hooks:` and `react/rules-of-hooks` report the same conditional call at the
  // same line and column, which is the two-rules-one-line shape this base
  // argues against for the assertion rules. Both stay anyway, and this is the
  // fact that settles it: a hook called from a plain function is not a
  // component the compiler analyses at all, so the older rule reaches a caller
  // its replacement never sees. Dropping it would trade a duplicated
  // diagnostic for a missing one.
  test("and the older hooks rule reaches a caller the compiler never analyses", () => {
    expect(judgedIn("src/hooks/non-component.ts")).toEqual([]);
    expect(drawnIn("src/hooks/non-component.ts")).toEqual(["error react-hooks(rules-of-hooks)"]);
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
  // server override that already denied it is untouched — what changed is the
  // floor under every other file. Graded by the severity, which is the change.
  test("denies in ordinary source, not only under the server override", () => {
    expect(drawnIn("src/logging.ts")).toEqual(["error eslint(no-console)"]);
  });
});

describe("a dependency list", () => {
  // `warn` cannot fail a build — oxlint exits 0 with warnings outstanding and
  // no `--max-warnings` is passed anywhere — so a dependency the compiler
  // infers differently from the one written was a line in a report nobody was
  // required to drive to zero. Graded by the severity, which is the whole diff.
  test("is a gate rather than a report, now that it denies", () => {
    expect(drawnIn("src/hooks/use-rows.tsx")).toEqual(["error react-hooks(exhaustive-deps)"]);
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
