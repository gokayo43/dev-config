import { describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path";

import { readConfig, record } from "../.github/actions/_lib/gate.ts";
import { BASE, type Diagnostic, gradedByBase } from "./lint-fixture.ts";

/**
 * The React half of the base's lint policy: the React Compiler's judgements,
 * which oxlint ports as one rule per judgement, and the two older React rules
 * the base keeps beside them.
 *
 * Its own file rather than a block in `lint-policy.test.ts` because it is its
 * own subject and the largest one there — everything here is about what a
 * compiler decides about a component, and nothing here is about where a file
 * sits, which is what that suite is for.
 *
 * The config is the shipped base rather than a copy, for the reason that suite
 * gives: what is being asked is what a repo extending it inherits.
 */

/**
 * Every judgement is its own rule name, so a name the port drops is refused at
 * config-parse time — which is the failure that reached the fleet as a base no
 * consumer could load. What this table adds is the other half, which parsing
 * cannot see: a rule that survives as a name and stops reporting anything.
 *
 * One table keyed by every `react/*` rule the base states, so the key set can
 * be compared against the base's own and nothing is graded by a list written
 * twice. Each entry says which of three things its rule is:
 *
 * - `source` — a fixture, with `draws` naming every judgement it draws. The key
 *   must be among them: an entry whose fixture draws only some *other* rule
 *   would otherwise satisfy a key-set comparison while grading nothing about
 *   the rule it is named for.
 * - `undriven` — a compiler rule no shape tried here provokes, with the reason.
 * - `elsewhere` — a `react/*` rule that is not the compiler's. These report
 *   under `react-hooks(…)` rather than `react(…)`, and the cases that grade
 *   them are the two at the bottom of this file. A classification rather than
 *   an omission, so that the day the base states another one, it is a decision
 *   here instead of a rule silently read as the compiler's.
 *
 * `draws` is a list because the key names the rule a fixture is written for and
 * not a promise that it is the only one to fire: the compiler reaches one
 * construct through several judgements, and a case naming just its own rule
 * would pass while a second one appeared or vanished underneath it.
 */
type Graded =
  | { readonly source: string; readonly draws: readonly string[] }
  | { readonly undriven: string }
  | { readonly elsewhere: string };

const REACT = {
  purity: {
    draws: ["purity"],
    source: `export function Panel(props: { readonly n: number }) {
  const roll = Math.random();
  return <p data-n={props.n}>{roll}</p>;
}
`,
  },
  immutability: {
    draws: ["immutability"],
    source: `export function Config(props: { readonly cfg: { a: number } }) {
  props.cfg.a = 3;
  return <p>{props.cfg.a}</p>;
}
`,
  },
  "set-state-in-render": {
    draws: ["set-state-in-render"],
    source: `import { useState } from "react";
export function Counter(props: { readonly n: number }) {
  const [v, setV] = useState(0);
  setV(props.n);
  return <p>{v}</p>;
}
`,
  },
  "set-state-in-effect": {
    draws: ["set-state-in-effect"],
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
  "no-deriving-state-in-effects": {
    draws: ["no-deriving-state-in-effects", "set-state-in-effect"],
    source: `import { useEffect, useState } from "react";
export function useDoubled(a: number) {
  const [b, setB] = useState(0);
  useEffect(() => {
    setB(a * 2);
  }, [a]);
  return b;
}
`,
  },
  "exhaustive-effect-dependencies": {
    draws: ["exhaustive-effect-dependencies"],
    source: `import { useEffect, useState } from "react";
export function useLatest(n: number) {
  const [rows, setRows] = useState<number[]>([]);
  useEffect(() => {
    const id = setTimeout(() => setRows([n]), 0);
    return () => clearTimeout(id);
  }, []);
  return rows;
}
`,
  },
  refs: {
    draws: ["refs"],
    source: `import { useRef } from "react";
export function Focus() {
  const box = useRef<HTMLInputElement>(null);
  return <input ref={box} data-had={String(box.current)} />;
}
`,
  },
  globals: {
    draws: ["globals"],
    source: `let seen = 0;
export function Seen(props: { readonly n: number }) {
  seen += props.n;
  return <p>{seen}</p>;
}
`,
  },
  "static-components": {
    draws: ["static-components"],
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
    draws: ["error-boundaries"],
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
    draws: ["memo-dependencies", "use-memo"],
    source: `import { useMemo } from "react";
export function useTotal(a: number) {
  return useMemo(() => a + 1, [a + 1]);
}
`,
  },
  "memo-dependencies": {
    draws: ["memo-dependencies"],
    source: `import { useCallback } from "react";
export function useHandler(n: number) {
  return useCallback(() => n + 1, []);
}
`,
  },
  "void-use-memo": {
    draws: ["void-use-memo"],
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
    draws: ["preserve-manual-memoization"],
    source: `import { useMemo } from "react";
export function useMaybe(a: number, on: boolean) {
  return on ? useMemo(() => a, [a]) : 0;
}
`,
  },
  hooks: {
    draws: ["hooks"],
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
    draws: ["capitalized-calls"],
    source: `function Helper(n: number) {
  return n + 1;
}
export function Sum(props: { readonly n: number }) {
  return <p>{Helper(props.n)}</p>;
}
`,
  },
  invariant: {
    draws: ["invariant"],
    source: `export function Holder(props: { readonly n: number }) {
  class Box {
    readonly at = props.n;
  }
  return <p>{new Box().at}</p>;
}
`,
  },
  "rule-suppression": {
    draws: ["rule-suppression"],
    // The `react-hooks/` name is what this rule reads, and the case below is
    // where that is the whole point rather than an incidental spelling.
    source: `/* eslint-disable react-hooks/exhaustive-deps */
export function Panel(props: { readonly n: number }) {
  const roll = Math.random();
  return <p data-n={props.n}>{roll}</p>;
}
`,
  },
  todo: {
    draws: ["todo"],
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
  "unsupported-syntax": {
    draws: ["unsupported-syntax"],
    source: `export function Evaluated(props: { readonly src: string }) {
  const out: unknown = eval(props.src);
  return <p>{String(out)}</p>;
}
`,
  },
  "incompatible-library": {
    undriven:
      "wants an installed library whose API returns functions that cannot be memoized safely — react-hook-form's `watch`, TanStack Table's `useReactTable` — and this suite installs nothing into a fixture tree",
  },
  syntax: {
    undriven:
      "reports code the compiler could not read, which oxlint's own parser refuses first, so nothing reaches the rule",
  },
  "react-in-jsx-scope": {
    elsewhere: "the classic-runtime import rule, off in this base and reported under react-hooks",
  },
  "rules-of-hooks": { elsewhere: "graded by the uncompiled-caller case below" },
  "exhaustive-deps": { elsewhere: "graded by the uncompiled-caller case below" },
} satisfies Record<string, Graded>;

/** The rules whose judgements arrive under `react(…)` — everything but `elsewhere`. */
const COMPILER_RULES = Object.entries(REACT)
  .filter(([, graded]) => !("elsewhere" in graded))
  .map(([rule]) => rule);

/**
 * The base's own `react/*` names, read through the gates' JSONC decoder — the
 * base carries the reason for every entry as a comment, which `JSON.parse`
 * refuses. `readConfig` rather than a decode of its own: an unreadable base
 * answers with a problem instead of an empty object, and an empty object here
 * would empty the rule set and pass every case in this file.
 */
async function statedRules(): Promise<string[]> {
  const base = await readConfig(dirname(BASE), basename(BASE));
  if (base.contents === undefined) throw new Error(base.problems[0]?.message ?? "base unreadable");
  return Object.keys(record(record(base.contents)["rules"]))
    .filter((name) => name.startsWith("react/"))
    .map((name) => name.slice("react/".length))
    .toSorted();
}

/**
 * The rule names the README's judgement table documents, read out of the page
 * itself. The table is found by its heading rather than by position, and the
 * name by the backticks in the first cell — so a row reworded above the fold
 * still counts and a sentence mentioning a rule in prose does not.
 */
async function documentedRules(): Promise<string[]> {
  const page = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const section = page.slice(page.indexOf("### What the React Compiler declines to optimize"));
  const table = section.slice(0, section.indexOf("\n\n", section.indexOf("| Rule")));
  return table
    .split("\n")
    .map((line) => /^\|\s*`([a-z-]+)`\s*\|/.exec(line)?.[1])
    .filter((name) => name !== undefined)
    .toSorted();
}

/**
 * Under `hooks/`, which is where the effect and query bans say nothing — so
 * what a case draws is the compiler's judgement and not the base's opinion of
 * where an effect belongs. Derived from the key rather than stored beside it: a
 * key is unique because the object is, and two entries naming one file would
 * collapse to whichever was written last.
 */
function pathOf(rule: string): string {
  return `src/hooks/${rule}.tsx`;
}

/** A hook called from a function that is neither a component nor a hook. */
const NON_COMPONENT = `import { useState } from "react";
export function helper() {
  const [v] = useState(0);
  return v;
}
`;

/** The same uncompiled function, with an effect whose list omits what it reads. */
const NON_COMPONENT_EFFECT = `import { useEffect, useState } from "react";
export function collect(n: number) {
  const [rows, setRows] = useState<number[]>([]);
  useEffect(() => {
    setRows([n]);
  }, []);
  return rows;
}
`;

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

/**
 * The house form of a suppression: an `oxlint-disable` naming one of the rules
 * the base actually states. Its own fixture because what it proves is a
 * silence, and a silence has to be asked for somewhere.
 */
const HOUSE_SUPPRESSION = `/* oxlint-disable react/purity -- the seed is deliberately unstable here */
export function Seeded(props: { readonly n: number }) {
  const roll = Math.random();
  return <p data-n={props.n}>{roll}</p>;
}
`;

const TREE = {
  ...Object.fromEntries(
    Object.entries(REACT)
      .filter(([, graded]) => "source" in graded)
      .map(([rule, graded]) => [pathOf(rule), "source" in graded ? graded.source : ""]),
  ),
  "src/probe.tsx": PROBE,
  "src/hooks/non-component.ts": NON_COMPONENT,
  "src/hooks/non-component-effect.ts": NON_COMPONENT_EFFECT,
  "src/hooks/house-suppression.tsx": HOUSE_SUPPRESSION,
} satisfies Record<string, string>;

const REPORTED = await gradedByBase(TREE);

function reportedIn(file: string): readonly Diagnostic[] {
  return REPORTED.get(file) ?? [];
}

/** What a file drew, as the rule and the severity it drew it at. */
function drawnIn(file: string): string[] {
  return reportedIn(file).map(({ severity, code }) => `${severity} ${code}`);
}

/** The rule a diagnostic's code names, which is the part in parentheses. */
function ruleOf(code: string): string {
  return code.slice(code.indexOf("(") + 1, -1);
}

/**
 * What the compiler said about a file, as the rule each judgement arrives
 * under — the rules the base states and no other. The `react` plugin is wider
 * than the compiler's port: `no-unstable-nested-components` reports under the
 * same `react(…)` code and arrives through `correctness`, so a projection
 * reading the prefix alone would answer for rules this file is not about.
 *
 * Sorted, so that a case states which judgements a fixture drew and never the
 * order oxlint happened to walk the file in — while a rule reporting the same
 * thing twice still reaches the assertion as two entries.
 */
function judgedIn(file: string): string[] {
  return reportedIn(file)
    .filter(({ code }) => code.startsWith("react(") && COMPILER_RULES.includes(ruleOf(code)))
    .map(({ severity, code }) => `${severity} ${ruleOf(code)}`)
    .toSorted();
}

/** What one rule said about a file, as its messages — for a case reading advice. */
function saidBy(file: string, rule: string): string[] {
  return reportedIn(file)
    .filter(({ code }) => code === `react(${rule})`)
    .map(({ message }) => message);
}

describe("what the React Compiler declines to optimize", () => {
  // The shape that opened this: the base mandated the compiler in every repo
  // and then graded none of its judgements, so a component that rolls a die
  // during render and writes through its own props passed the gate clean.
  test("the probe that passed: an impure render, a props write, and a loose compare", () => {
    expect(judgedIn("src/probe.tsx")).toEqual(["error immutability", "error purity"]);
    expect(drawnIn("src/probe.tsx")).toContain("error eslint(eqeqeq)");
  });

  // Exactly the judgements named, not merely the right one among several: a
  // case that tolerated extra diagnostics would pass on a rule that had begun
  // reporting the same code twice, which is the shape this base refuses
  // everywhere else.
  const driven = Object.entries(REACT).flatMap(([rule, graded]) =>
    "source" in graded ? [[rule, graded.draws] as const] : [],
  );

  test.each(driven)("%s", (rule, draws) => {
    expect(judgedIn(pathOf(rule))).toEqual(draws.map((each) => `error ${each}`).toSorted());
  });

  // A fixture that draws some other rule would satisfy the key-set comparison
  // below while grading nothing about the rule it is filed under — which is how
  // a table this size ends up with an entry that is a name and a decoration.
  test.each(driven)("%s is graded by a fixture that draws it", (rule, draws) => {
    expect(draws).toContain(rule);
  });

  // The table is the whole of what the base states, which is the check a count
  // would replace with a number to forget. A rule added to the base with no
  // entry here fails on this line rather than shipping as a name nothing reads.
  test("and the table names every react rule the base states, and no other", async () => {
    expect(Object.keys(REACT).toSorted()).toEqual(await statedRules());
  });

  // And the README's own table is a third statement of the same set, which is
  // the shape a reader trusts most and nothing was holding. Graded by the set
  // rather than by prose: a row for a rule the base dropped is a page telling
  // someone to answer a diagnostic that can no longer fire, and a rule with no
  // row is the one a reader meets with nothing to read.
  test("and the README documents exactly the judgements, no more and no fewer", async () => {
    expect(await documentedRules()).toEqual(COMPILER_RULES.toSorted());
  });

  // The bail-out rule, and the reason the base states it rather than leaving it
  // to a category: a component the compiler declined to compile at all is not a
  // violation, so with that rule off it draws nothing and reads as optimized.
  // Named by its key in the table rather than spelled out here, because
  // `no-warning-comments` reads this file too.
  test("a component the compiler skipped is a diagnostic, not a silence", () => {
    // It names the construct rather than only the fact, which is what makes a
    // bail-out answerable at all — every other bail-out reaches the reader
    // through this same rule, so the case reads the syntax and not the name.
    expect(saidBy(pathOf("todo"), "todo").join("\n")).toContain("`try`/`finally`");
  });

  // The memo ban and the compiler's memo judgements are not the same rule
  // saying one thing twice: the ban refuses the import, and this grades the
  // memo that survives a disable carrying its reason.
  test("and a hand-written memo is graded, not only refused", () => {
    expect(drawnIn(pathOf("preserve-manual-memoization"))).toContain(
      "error eslint(no-restricted-imports)",
    );
  });
});

describe("a suppression of a React rule", () => {
  // The compiler skips a function holding one, so the suppression costs the
  // whole component its optimization — which is why upstream made this a rule
  // rather than leaving it to review.
  //
  // What the rule reads is the NAME, not the directive keyword: `eslint-disable`
  // and `oxlint-disable` both fire on a `react-hooks/*` name, and neither fires
  // on the `react/*` names this base actually states. So the house form of a
  // suppression — `oxlint-disable react/purity -- reason`, the escape hatch
  // every other rule here is answered with — is the one spelling that
  // un-optimizes a component and draws nothing at all.
  test("is caught when it names the rule upstream calls it", () => {
    expect(judgedIn(pathOf("rule-suppression"))).toEqual(["error rule-suppression"]);
  });

  test("and is not caught when it names the rule this base states", () => {
    const path = "src/hooks/house-suppression.tsx";
    expect(judgedIn(path)).toEqual([]);
    // Both halves of the silence: the suppressed judgement is gone, and nothing
    // took its place. A case asserting only the first would pass on a build that
    // had started reporting the suppression.
    expect(drawnIn(path)).toEqual([]);
  });
});

describe("the two older React rules the base keeps", () => {
  // `react/hooks` and `react/rules-of-hooks` report the same conditional call at
  // the same line and column, which is the two-rules-one-line shape this base
  // argues against for the assertion rules. Both stay anyway, and this is the
  // fact that settles it: a hook called from a plain function is not a component
  // the compiler analyses at all, so the older rule reaches a caller its
  // replacement never sees. Dropping it would trade a duplicated diagnostic for
  // a missing one.
  test("the hooks rule reaches a caller the compiler never analyses", () => {
    expect(judgedIn("src/hooks/non-component.ts")).toEqual([]);
    expect(drawnIn("src/hooks/non-component.ts")).toEqual(["error react-hooks(rules-of-hooks)"]);
  });

  // And the same settling fact for the older dependency rule.
  // `react/exhaustive-deps` is not the only thing that reports a missing effect
  // dependency — the compiler's own `exhaustive-effect-dependencies` does, on
  // the same fixture — so what keeps it is the reach rather than the judgement.
  test("and the dependency rule reaches the same uncompiled caller", () => {
    expect(judgedIn("src/hooks/non-component-effect.ts")).toEqual([]);
    // The two rules-of-hooks errors beside it are the same fact from the other
    // end: both hook calls are illegal there precisely because the function is
    // neither a component nor a hook, which is why nothing compiled it.
    expect(drawnIn("src/hooks/non-component-effect.ts").toSorted()).toEqual([
      "error react-hooks(exhaustive-deps)",
      "error react-hooks(rules-of-hooks)",
      "error react-hooks(rules-of-hooks)",
    ]);
  });
});
