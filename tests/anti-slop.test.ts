import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { oxlint, reportsFor } from "./lint-fixture.ts";
import type { Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);
const BASE = join(REPO, "oxlint.base.json");

/**
 * What every case here is read through, so it is worth one case of its own: a
 * rule that throws and a config oxlint refuses both produce a run with no
 * diagnostics, which is what most of the cases below assert.
 */
describe("the harness", () => {
  const THROWING = `const rule = { create() { return { Program() { throw new Error("thrown"); } }; } };
export default { meta: { name: "anti-slop" }, rules: { "no-runtime-typeof": rule } };
`;

  /** What a run was refused with, or the fact that it was not refused at all. */
  async function refusal(tree: Tree): Promise<string> {
    return await oxlint(tree).then(
      () => "the run was accepted",
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );
  }

  test("a plugin whose rule throws is a failure, not a clean tree", async () => {
    const wired = JSON.stringify({
      plugins: [],
      categories: { correctness: "off" },
      jsPlugins: [{ name: "anti-slop", specifier: "./throws.js" }],
      rules: { "anti-slop/no-runtime-typeof": "error" },
    });

    expect(
      await refusal({
        ".oxlintrc.json": wired,
        "throws.js": THROWING,
        "case.ts": "export const one = 1;\n",
      }),
    ).toContain("Error running JS plugin");
  });

  test("a config oxlint will not read is a failure, not a clean tree", async () => {
    expect(
      await refusal({ ".oxlintrc.json": "{ not json", "case.ts": "export const one = 1;\n" }),
    ).toContain("oxlint exited");
  });
});

interface Case {
  /** The wrong implementation this case would catch — not a restatement of the source. */
  readonly name: string;
  readonly source: string;
  /**
   * One fragment per diagnostic the rule must produce, in source order. An
   * empty list is the assertion that the tree is clean, which is half of what
   * every rule here has to get right.
   */
  readonly reports: readonly string[];
}

/** Runs a rule's cases, each against the diagnostics of its own file. */
function cases(rule: string, list: readonly Case[]): void {
  describe(rule, () => {
    const sources = list.map(({ source }) => source);
    for (const [index, each] of list.entries()) {
      test(each.name, async () => {
        const reported = (await reportsFor(rule, rule, sources))[index] ?? [];
        expect(reported).toHaveLength(each.reports.length);
        for (const [at, fragment] of each.reports.entries()) {
          expect(reported[at]).toContain(`anti-slop(${rule})`);
          expect(reported[at]).toContain(fragment);
        }
      });
    }
  });
}

const USER = `interface User {
  readonly id: string;
}
declare const input: unknown;
declare const user: User;
`;

const HANDLER = `type Handler = () => void;
declare const startHandler: Handler;
`;

/**
 * A chain of union aliases, which is the shape resolution used to be
 * exponential over: every level asks the same question of two members. Twenty-six
 * levels took twenty-six seconds, against a fifth of a second from `tsc` — so
 * the case has no bound of its own to assert, because a suite that cannot finish
 * inside its timeout is how the regression announces itself.
 */
const UNION_CHAIN = Array.from({ length: 26 }, (_, level) =>
  level === 0 ? "type L0 = string;" : `type L${level} = L${level - 1} | L${level - 1};`,
).join("\n");

const HOUSE = {
  "no-chained-type-assertions": [
    {
      name: "a chain that fabricates the target type is refused",
      source: `${USER}export const one = input as object as User;`,
      reports: ["6:20"],
    },
    {
      name: "one assertion is not a chain — the rule counts links, not assertions",
      source: `${USER}export const one = input as User;`,
      reports: [],
    },
    {
      name: "a const-only chain is the sanctioned one",
      source: `export const ids = ["a", "b"] as const;
export const settings = { retries: 2 } as const;`,
      reports: [],
    },
    {
      name: "parentheses between the links do not hide the chain",
      source: `${USER}export const one = (input as object) as User;`,
      reports: ["6:20"],
    },
    {
      name: "a three-link chain is one diagnostic, at the outermost link",
      source: `${USER}export const one = input as object as Record<string, string> as User;`,
      reports: ["6:20"],
    },
    {
      name: "a const assertion beside a real one is still fabrication",
      source: `${USER}export const one = input as const as User;`,
      reports: ["6:20"],
    },
    {
      name: "an angle-bracket assertion is the same assertion",
      source: `${USER}export const one = <User>(<object>input);`,
      reports: ["6:20"],
    },
  ],

  "no-known-value-widening": [
    {
      name: "a known object flowing into an open dictionary loses its keys",
      source: `${HANDLER}export const handlers: Record<string, Handler> = { start: startHandler };`,
      reports: ["open dictionary"],
    },
    {
      name: "`satisfies` is the escape the diagnostic offers",
      source: `${HANDLER}export const handlers = { start: startHandler } satisfies Record<string, Handler>;`,
      reports: [],
    },
    {
      name: "an empty object into a dictionary is an accumulator, not a discarded shape",
      source: `${HANDLER}export const handlers: Record<string, Handler> = {};`,
      reports: [],
    },
    {
      name: "evidence is followed through a const binding, not only read off the initializer",
      source: `${HANDLER}const source = { start: startHandler };
export const handlers: Record<string, Handler> = source;`,
      reports: ["open dictionary"],
    },
    {
      name: "a value out of a call carries no syntactic evidence to discard",
      source: `${HANDLER}declare function make(): Record<string, Handler>;
export const handlers: Record<string, Handler> = make();`,
      reports: [],
    },
    {
      name: "a named alias is the owner contract the rule asks for, not a widening",
      source: `${HANDLER}type Handlers = Record<string, Handler>;
export const handlers: Handlers = { start: startHandler };`,
      reports: [],
    },
    {
      name: "a generic alias is still the container it stands for — the substitution is walked",
      source: `${HANDLER}type Index<T> = Record<string, T>;
export const handlers: Index<Handler> = { start: startHandler };`,
      reports: ["generic container"],
    },
    {
      name: "a locally declared Record is not the built-in one",
      source: `${HANDLER}type Record<K, V> = { readonly key: K; readonly value: V };
export const handlers: Record<string, Handler> = { key: "start", value: startHandler };`,
      reports: [],
    },
    {
      name: "the subject names the function whose return type discards the evidence",
      source: `${HANDLER}export function create(): unknown {
  return { start: startHandler };
}`,
      reports: ["return value of `create`"],
    },
    {
      name: "an assertion to a broad type widens as surely as an annotation",
      source: `${HANDLER}export const handlers = { start: startHandler } as Record<string, Handler>;`,
      reports: ["open dictionary"],
    },
    {
      // Upstream reports this, and the only escapes it leaves are deleting the
      // annotation or inventing a name for a two-field return. An explicit
      // return type over the literal it stands on is what makes the signature
      // the contract instead of the body, which is what this repo asks for.
      name: "an anonymous target naming exactly the keys written under it discards nothing",
      source: `export function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const restore = (): void => {};
  return { lines, restore };
}`,
      reports: [],
    },
    {
      name: "an anonymous target the value has a key beyond is still a loss",
      source: `export const settings: { retries: number } = { retries: 2, verbose: true };`,
      reports: ["anonymous object"],
    },
  ],

  "no-object-parameters": [
    {
      name: "the broad object type on an input",
      source: `export function save(value: object): void {
  void value;
}`,
      reports: ["Parameter `value`"],
    },
    {
      name: "an owner type is what the diagnostic asks for",
      source: `interface Payload {
  readonly id: string;
}
export function save(value: Payload): void {
  void value;
}`,
      reports: [],
    },
    {
      name: "an alias to object is the same input wearing a name",
      source: `type Anything = object;
export function save(value: Anything): void {
  void value;
}`,
      reports: ["Parameter `value`"],
    },
    {
      name: "a type parameter constrained by object is not the object type",
      source: `export function save<Value extends object>(value: Value): void {
  void value;
}`,
      reports: [],
    },
    {
      name: "a union that admits object still admits it",
      source: `export function save(value: object | string): void {
  void value;
}`,
      reports: ["Parameter `value`"],
    },
    {
      name: "a constructor's parameter property carries an annotation too",
      source: `export class Store {
  constructor(private readonly value: object) {}
}`,
      reports: ["value"],
    },
    {
      name: "a default value does not hide the annotation it defaults",
      source: `export function save(value: object = {}): void {
  void value;
}`,
      reports: ["value"],
    },
  ],

  "no-runtime-typeof": [
    {
      name: "a typeof narrowing an input instead of decoding it",
      source: `declare function useName(name: string): void;
export function apply(input: string | number): void {
  if (typeof input === "string") useName(input);
}`,
      reports: ["3:7"],
    },
    {
      name: "a decoded input needs no narrowing",
      source: `declare function useName(name: string): void;
export function apply(name: string): void {
  useName(name);
}`,
      reports: [],
    },
    {
      name: "a typeof in type position is not a runtime check",
      source: `declare const settings: { readonly retries: number };
export type Settings = typeof settings;`,
      reports: [],
    },
  ],

  "no-shape-in-symbol-names": [
    {
      name: "a type named for the word",
      source: `export interface UserShape {
  readonly id: string;
}`,
      reports: ["UserShape"],
    },
    {
      name: "the thing named by what it is",
      source: `export interface User {
  readonly id: string;
}`,
      reports: [],
    },
    {
      name: "the word as data is not a symbol name",
      source: `export const message = "the shape of the payload";`,
      reports: [],
    },
    {
      name: "case does not change what a name says",
      source: `export const SHAPE_OF_IT = 1;`,
      reports: ["SHAPE_OF_IT"],
    },
    {
      name: "a property key is a name someone reads too",
      source: `export const payload = { shapeOf: 1 };`,
      reports: ["shapeOf"],
    },
    {
      // zod's `.shape` is its documented API and `shapeRendering` is an SVG
      // attribute. Upstream refuses both, and at `error` fleet-wide the only
      // remedy is a disable per site — for a name the repo never chose.
      name: "a property read on a value the file does not own is not the file's name",
      source: `import { schema, svg } from "./foreign.ts";

export function apply(): string[] {
  svg.style.shapeRendering = "crispEdges";
  return Object.keys(schema.shape);
}`,
      reports: [],
    },
    {
      name: "an imported name is named once, where it is bound",
      source: `import { shapeIt } from "./foreign.ts";

export const run = shapeIt;`,
      reports: ["shapeIt"],
    },
    {
      // The property is the foreign one; the binding beside it is the name this
      // file chose, and `const { shape: identity }` is the fix available to it.
      name: "a name bound out of a foreign property is still a name the file chose",
      source: `import { schema } from "./foreign.ts";

export function read(): unknown {
  const { shape } = schema;
  return shape;
}`,
      reports: ["shape"],
    },
  ],

  "no-unknown-parameters": [
    {
      name: "an unknown input with no contract",
      source: `export function handle(input: unknown): void {
  void input;
}`,
      reports: ["Parameter `input`"],
    },
    {
      name: "`cause` is the one convention that keeps unknown",
      source: `export function wrap(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}`,
      reports: [],
    },
    {
      name: "a parameter property is a parameter",
      source: `export class Store {
  constructor(private readonly value: unknown) {}
}`,
      reports: ["value"],
    },
    {
      name: "a defaulted `cause` is still the convention — the name is read through the pattern",
      source: `export function wrap(message: string, cause: unknown = undefined): Error {
  return new Error(message, { cause });
}`,
      reports: [],
    },
    {
      name: "a decoded input is what the diagnostic asks for",
      source: `interface Payload {
  readonly id: string;
}
export function handle(input: Payload): void {
  void input;
}`,
      reports: [],
    },
    {
      // Not a type TypeScript accepts (TS2456), and every rule here runs on the
      // pre-commit hook, where a file is halfway through being written. The
      // wrong implementation restarts resolution for each union member with no
      // memory of the aliases already entered, so this one never terminates.
      name: "an alias that names itself through a union does not run forever",
      source: `type Selfish = Selfish | unknown;
export function f(x: Selfish): void {
  void x;
}`,
      reports: ["Parameter `x`"],
    },
    {
      // `Reversed<unknown, string>` applies `Handler<string, unknown>`, whose
      // body is its own `Output` — `unknown`. The wrong implementation binds an
      // inner alias's parameters against the map it is still building, so
      // `Output` reads back the value just written for `Input`.
      name: "an inner alias applied under permuted parameters of the same names",
      source: `type Handler<Input, Output> = Output;
type Reversed<Input, Output> = Handler<Output, Input>;
export function f(x: Reversed<unknown, string>): void {
  void x;
}`,
      reports: ["Parameter `x`"],
    },
  ],

  "no-unknown-type-aliases": [
    {
      name: "an alias that only renames unknown",
      source: `export type Payload = unknown;`,
      reports: ["Payload"],
    },
    {
      name: "an alias that names a shape",
      source: `export type Payload = { readonly id: string };`,
      reports: [],
    },
    {
      name: "every alias in a chain that ends at unknown, not only the last",
      source: `type Anything = unknown;
export type Payload = Anything;`,
      reports: ["Anything", "Payload"],
    },
    {
      name: "an alias that refers to itself resolves to nothing rather than looping",
      source: `export type Payload = Payload;`,
      reports: [],
    },
    {
      // A type parameter may be named for a generic type in scope, and binding
      // it to an applied reference to that type is what the wrong
      // implementation follows forever: the parameter's own name looks up its
      // own value on every pass. The plugin threw a RangeError here, and oxlint
      // drops all nine rules for a file whose plugin threw.
      name: "a type parameter named for a generic alias resolves rather than looping",
      source: `type Box<T> = { readonly v: T };
type Unwrap<Box> = Box;
export type Payload = Unwrap<Box<number>>;`,
      reports: [],
    },
    {
      name: "an alias to a named type is not unknown",
      source: `interface User {
  readonly id: string;
}
export type Payload = User;`,
      reports: [],
    },
  ],

  "no-unsafe-dictionary-type": [
    {
      name: "the bag with no keys and no value contract",
      source: `export type Bag = Record<string, unknown>;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "a dictionary with a real value type",
      source: `export type Bag = Record<string, string>;`,
      reports: [],
    },
    {
      name: "an alias standing in for the value type is followed to what it is",
      source: `type Value = unknown;
export type Bag = Record<string, Value>;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "an empty interface is the escape hatch spelled as a name",
      source: `interface Empty {}
export type Bag = Record<string, Empty>;`,
      reports: ["empty-object escape hatch"],
    },
    {
      name: "a locally declared Record is not the built-in one",
      source: `type Record<K, V> = { readonly key: K; readonly value: V };
export type Bag = Record<string, unknown>;`,
      reports: [],
    },
    {
      name: "an imported Record is not the built-in one either",
      source: `import type { Record } from "./local.ts";

export type Bag = Record<string, unknown>;`,
      reports: [],
    },
    {
      name: "a type parameter's default carries the escape hatch into the body",
      source: `type Index<T = unknown> = Record<string, T>;
export type Bag = Index;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "a transparent wrapper does not launder the value type",
      source: `export type Bag = Record<string, Readonly<unknown>>;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "one diagnostic for one dictionary, at the outermost type that is it",
      source: `export type Bag = Readonly<Record<string, unknown>>;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "an index signature on an interface is a dictionary too",
      source: `export interface Bag {
  [key: string]: unknown;
}`,
      reports: ["unknown escape hatch"],
    },
    {
      // `Outer<string, unknown>` applies `Inner<unknown, string>`, so the value
      // type is `string` and there is nothing to refuse. The wrong
      // implementation reads `B` back as whatever `A` was just bound to, and
      // both directions of that mistake are silent — this one refuses valid
      // code, the next one waves the escape hatch through.
      name: "an inner alias applied under permuted parameters of the same names",
      source: `type Inner<A, B> = Record<string, B>;
type Outer<A, B> = Inner<B, A>;
export declare const table: Outer<string, unknown>;`,
      reports: [],
    },
    {
      name: "the permuted application that really does carry the escape hatch",
      source: `type Inner<A, B> = Record<string, B>;
type Outer<A, B> = Inner<B, A>;
export declare const table: Outer<unknown, string>;`,
      reports: ["unknown escape hatch"],
    },
    {
      // A parameter is only a cycle inside the alias frame that bound it. The
      // wrong implementation here is the tempting one-line guard: fold the
      // parameter name into the set of aliases already entered, and a parameter
      // named for an outer alias stops resolving — silently, on valid code.
      name: "a parameter named for an alias already entered still resolves",
      source: `type Box<T> = Inner<T>;
type Inner<Box> = Box;
export declare const table: Record<string, Box<unknown>>;`,
      reports: ["unknown escape hatch"],
    },
    {
      name: "a union alias chain is answered once per level, not once per branch",
      source: `${UNION_CHAIN}
export type Bag = Record<string, L25>;`,
      reports: [],
    },
    {
      name: "and the same shape carrying a real value type is left alone",
      source: `type Box<T> = Inner<T>;
type Inner<Box> = Box;
export declare const table: Record<string, Box<string>>;`,
      reports: [],
    },
  ],

  "no-widen-then-assert": [
    {
      // The two rules held two lists of what counts as a known value and only
      // one of them had `UnaryExpression` in it, so this laundering was caught
      // when the literal was `1` and silent when it was `-1`.
      name: "an operator over a literal is as known as the literal",
      source: `export function round(): number {
  const wide: unknown = -1;
  return wide as number;
}`,
      reports: ["3:10"],
    },
    {
      name: "a widened const asserted back to what it was",
      source: `${USER}export function round(value: User): User {
  const wide: unknown = value;
  return wide as User;
}`,
      reports: ["8:10"],
    },
    {
      name: "the value carried through keeps its type and needs no assertion",
      source: `${USER}export function round(value: User): User {
  return value;
}`,
      reports: [],
    },
    {
      name: "an assertion back to a broad type narrows nothing",
      source: `${USER}export function round(value: User): unknown {
  const wide: unknown = value;
  return wide as unknown;
}`,
      reports: [],
    },
    {
      name: "an assertion to a non-object does not narrow an object binding",
      source: `${USER}export function round(value: User): string {
  const wide: object = value;
  return wide as string;
}`,
      reports: [],
    },
    {
      name: "a reassignable binding is not evidence anything erased",
      source: `${USER}export function round(value: User): User {
  let wide: unknown = value;
  wide = value;
  return wide as User;
}`,
      reports: [],
    },
    {
      name: "the widening written as an assertion rather than an annotation",
      source: `${USER}export function round(value: User): User {
  const wide = value as unknown;
  return wide as User;
}`,
      reports: ["8:10"],
    },
    {
      name: "an assertion in another function is not this binding's",
      source: `${USER}export function round(value: User): () => User {
  const wide: unknown = value;
  void wide;
  return () => value as User;
}`,
      reports: [],
    },
    {
      name: "the binding resolved is the one in scope, not the one with the name",
      source: `${USER}export function carry(value: User): User {
  const wide = value;
  return wide as User;
}
export function round(value: User): User {
  const wide: unknown = value;
  return wide as User;
}`,
      reports: ["12:10"],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** A stand-in every case below reaches for, so the cases differ by what they do with it. */
const SENT = `import { expect, mock, test } from "bun:test";
const send = mock(() => 1);
`;
/**
 * The four rules the base enables only over test files, because every one of
 * them is ordinary code anywhere else: a source file counts calls, sleeps,
 * reads a `.mock` property off something of its own and passes a function to
 * `expect` in a helper, and none of that is a smell until it is a test's whole
 * evidence.
 */
const IN_TESTS = {
  "no-call-count-assertions": [
    {
      name: "the count matcher is refused",
      source: `${SENT}test("sends", () => {
  expect(send).toHaveBeenCalledTimes(1);
});`,
      reports: ["4:16"],
    },
    {
      name: "the order matchers go with it — a rule that knew only the count would leave them",
      source: `${SENT}test("sends", () => {
  expect(send).toHaveBeenNthCalledWith(1, "a");
  expect(send).toHaveBeenLastCalledWith("a");
  expect(send).toHaveBeenCalledOnce();
});`,
      reports: ["4:16", "5:16", "6:16"],
    },
    {
      name: "the same assertion counted by hand rather than by matcher",
      source: `${SENT}test("sends", () => {
  expect(send.mock.calls.length).toBe(1);
});`,
      reports: ["4:10"],
    },
    {
      name: "a length that is not a call log's — the chain is read whole, not for the word `calls`",
      source: `${SENT}test("sends", () => {
  const written = { calls: ["a"] };
  expect(written.calls.length).toBe(1);
  expect(send.mock.results.length).toBe(1);
});`,
      reports: [],
    },
    {
      name: "the matchers that grade the result are the ones a test is for",
      source: `${SENT}test("sends", () => {
  expect(send()).toBe(1);
  expect([send()]).toHaveLength(1);
});`,
      reports: [],
    },
  ],
  "no-mock-assertions": [
    {
      name: "a stand-in handed to expect is refused",
      source: `${SENT}test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: ["4:10"],
    },
    {
      name: "what calling it produced is not the stand-in — the rule reads the argument, not the name in it",
      source: `${SENT}test("sends", () => {
  expect(send()).toBe(1);
});`,
      reports: [],
    },
    {
      name: "a spy built inside the call is the same object",
      source: `import { expect, spyOn, test } from "bun:test";
test("sends", () => {
  expect(spyOn(console, "log")).toBeDefined();
});`,
      reports: ["3:10"],
    },
    {
      name: "the other two runners spell it their own way",
      source: `import { expect, test } from "bun:test";
declare const jest: { fn: () => () => void };
declare const vi: { fn: () => () => void };
const first = jest.fn();
const second = vi.fn();
test("sends", () => {
  expect(first).toBeDefined();
  expect(second).toBeDefined();
});`,
      reports: ["7:10", "8:10"],
    },
    {
      name: "a name the test writes to later is not the call at its declaration",
      source: `import { expect, mock, test } from "bun:test";
let send = mock(() => 1);
send = () => 2;
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "a plain function is not a stand-in",
      source: `import { expect, test } from "bun:test";
const send = () => 1;
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "the binding resolved is the one in scope, not the one with the name",
      source: `${SENT}test("sends", () => {
  const send = () => 1;
  expect(send).toBeDefined();
});
test("sends again", () => {
  expect(send).toBeDefined();
});`,
      reports: ["8:10"],
    },
  ],
  "no-local-module-mocks": [
    {
      name: "a module of ours replaced wholesale is refused",
      source: `import { mock } from "bun:test";
mock.module("./service.ts", () => ({ run: () => 1 }));`,
      reports: ["2:1"],
    },
    {
      name: "a parent-relative specifier is ours as much as a sibling",
      source: `import { mock } from "bun:test";
mock.module("../db/client.ts", () => ({ query: () => [] }));`,
      reports: ["2:1"],
    },
    {
      name: "a package is the true external boundary a fake belongs at",
      source: `import { mock } from "bun:test";
mock.module("node:fs/promises", () => ({ readFile: () => "" }));
mock.module("stripe", () => ({ charge: () => 1 }));`,
      reports: [],
    },
    {
      name: "a spy over a module of ours is the same move under another name",
      source: `import { spyOn } from "bun:test";
import * as service from "./service.ts";
spyOn(service, "run");`,
      reports: ["3:1"],
    },
    {
      name: "a spy over a package's namespace stays at the boundary",
      source: `import { spyOn } from "bun:test";
import * as fs from "node:fs";
spyOn(fs, "readFileSync");`,
      reports: [],
    },
    {
      name: "a spy over a global is not a module at all",
      source: `import { spyOn } from "bun:test";
spyOn(console, "log");`,
      reports: [],
    },
  ],
  "no-real-timers": [
    {
      name: "the timer globals are refused",
      source: `import { test } from "bun:test";
test("waits", () => {
  setTimeout(() => undefined, 10);
  setInterval(() => undefined, 10);
  setImmediate(() => undefined);
});`,
      reports: ["3:3", "4:3", "5:3"],
    },
    {
      name: "the sleeping promise is the timer written longhand",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});`,
      reports: ["3:34"],
    },
    {
      name: "Bun's sleeps are members of a global rather than globals",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await Bun.sleep(5);
  Bun.sleepSync(5);
});`,
      reports: ["3:9", "4:3"],
    },
    {
      name: "a property that shares the name is not the global",
      source: `import { expect, test } from "bun:test";
const clock = { setTimeout: (at: number) => at };
test("waits", () => {
  expect(clock.setTimeout(5)).toBe(5);
});`,
      reports: [],
    },
    {
      name: "a name the file declares itself is a different function",
      source: `import { test } from "bun:test";
function setTimeout(run: () => void): void {
  run();
}
test("waits", () => {
  setTimeout(() => undefined);
});`,
      reports: [],
    },
    {
      name: "Bun's other members spend no time",
      source: `import { expect, test } from "bun:test";
test("reads", async () => {
  expect(await Bun.file("package.json").text()).toContain("name");
});`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** The case a rule exists to reject, which is what the base has to be wired to catch. */
function violating(list: readonly Case[]): string {
  const first = list.find(({ reports }) => reports.length > 0);
  if (first === undefined) throw new Error("a rule with no violating case is a rule with no suite");
  return first.source;
}

/** Every rule's violating case, in a file named the way the base decides what it grades. */
function underBase(suffix: string, rules: Record<string, readonly Case[]>): Tree {
  return {
    ".oxlintrc.json": JSON.stringify({ extends: [BASE], options: { typeAware: false } }),
    ...Object.fromEntries(
      Object.entries(rules).map(([rule, list]) => [`${rule}${suffix}`, violating(list)]),
    ),
  };
}

describe("anti-slop rules", () => {
  for (const [rule, list] of Object.entries({ ...HOUSE, ...IN_TESTS })) cases(rule, list);

  // A rule that is not in the base is a rule no repo runs — the cases above
  // enable it by name themselves and would pass either way.
  test("the base enables every rule the plugin defines", async () => {
    const wired = [
      ...(await oxlint(underBase(".ts", HOUSE))),
      ...(await oxlint(underBase(".test.ts", IN_TESTS))),
    ].join("\n");
    for (const rule of [...Object.keys(HOUSE), ...Object.keys(IN_TESTS)]) {
      expect(wired).toContain(`anti-slop(${rule})`);
    }
  });

  // The other half of scoping one to a test file: counting calls, sleeping and
  // reaching into a module are what a source file does all day, and a rule that
  // fired on them everywhere would be one every repo turned off.
  test("the test-only rules say nothing about a file that is not a test", async () => {
    const wired = (await oxlint(underBase(".ts", IN_TESTS))).join("\n");
    for (const rule of Object.keys(IN_TESTS)) {
      expect(wired).not.toContain(`anti-slop(${rule})`);
    }
  });
});
