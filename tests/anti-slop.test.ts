import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { jsonObjects, record } from "../.github/actions/_lib/gate.ts";
import antiSlop from "../anti-slop/index.js";
import { type Case, cases, oxlint, underBase } from "./lint-fixture.ts";
import type { Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);

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

  /**
   * The variables that would otherwise make this suite grade its own format.
   * oxlint answers `agent` for any of these, `github` when a runner sets
   * `GITHUB_ACTIONS`, and a graphical format when none of them is set; an empty
   * value is how it reads one as absent.
   */
  const UNSET_BY_THIS_SHELL = { AI_AGENT: "", CLAUDECODE: "", CURSOR_AGENT: "" };

  // Only the agent format reads as `file:line:column: severity`, and a harness
  // that recognised a diagnostic by that shape agreed with itself wherever it
  // was written and called every case on CI a clean tree — the whole suite
  // green on a developer's machine and refusing to run in the one place it
  // grades a pull request. The environment is put into the state CI is in here
  // rather than trusted, because the failure was invisible from anywhere else.
  test.each([
    ["a runner", { GITHUB_ACTIONS: "true" }],
    ["an ordinary terminal", {}],
  ])("a diagnostic is read the same on %s as under this shell", async (_where, chosen) => {
    const reported = await oxlint(
      {
        ".oxlintrc.json": JSON.stringify({
          plugins: [],
          categories: { correctness: "off" },
          jsPlugins: [{ name: "anti-slop", specifier: join(REPO, "anti-slop/index.js") }],
          rules: { "anti-slop/no-chained-type-assertions": "error" },
        }),
        "case.ts": `interface User {
  readonly id: string;
}
declare const input: unknown;
export const one = input as object as User;
`,
      },
      { ...UNSET_BY_THIS_SHELL, ...chosen },
    );

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("anti-slop(no-chained-type-assertions)");
    expect(reported[0]).toContain("5:20");
  });
});

const USER = `interface User {
  readonly id: string;
}
declare const input: unknown;
declare const user: User;
`;

const HANDLER = `type Handler = () => void;
declare const startHandler: Handler;
`;

const REFLECT = `declare const operation: (owner: string, key: string) => number;
declare const owner: { readonly key: string };
declare const key: string;
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
    {
      // Why this rule survived the differential against
      // `typescript/no-unsafe-type-assertion`, which refuses every other
      // violating case in this block: each link here widens, so the native
      // rule has nothing unsafe to say and `no-unnecessary-type-assertion`
      // nothing redundant. A chain up a hierarchy still discards the type it
      // started from, and this is the only rule in the base that says so.
      name: "a chain whose every link widens is refused by nothing else",
      source: `interface Admin {
  readonly id: string;
  readonly level: number;
}
interface User {
  readonly id: string;
}
declare const admin: Admin;
export const one = admin as User as object;`,
      reports: ["9:20"],
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
    {
      name: "a type parameter shadowing an alias is the parameter, not the alias",
      source: `type Value = object;
export function save<Value>(value: Value): void {
  void value;
}`,
      reports: [],
    },
  ],

  "no-reflect-apply": [
    {
      name: "a call laundered through Reflect",
      source: `${REFLECT}export const value = Reflect.apply(operation, owner, [key]);`,
      reports: ["Replace `Reflect.apply`"],
    },
    {
      name: "the computed spelling is the same call — a rule keyed to the dot is one token from off",
      source: `${REFLECT}export const value = Reflect["apply"](operation, owner, [key]);`,
      reports: ["Replace `Reflect.apply`"],
    },
    {
      name: "a function's own .apply is not Reflect's",
      source: `${REFLECT}export const value = operation.apply(owner, [key]);`,
      reports: [],
    },
    {
      name: "a file that declares its own Reflect is not reaching for the global",
      source: `const Reflect = { apply: (): number => 1 };
export const value = Reflect.apply();`,
      reports: [],
    },
    {
      name: "Reflect.get is the sibling rule's method, not this one's",
      source: `${REFLECT}export const value = Reflect.get(owner, key);`,
      reports: [],
    },
  ],

  "no-reflect-get": [
    {
      name: "a property read laundered through Reflect",
      source: `${REFLECT}export const value = Reflect.get(owner, key);`,
      reports: ["Replace `Reflect.get`"],
    },
    {
      name: "the computed spelling is the same read",
      source: `${REFLECT}export const value = Reflect["get"](owner, key);`,
      reports: ["Replace `Reflect.get`"],
    },
    {
      name: "an ordinary property read is what the rule asks for",
      source: `${REFLECT}export const value = owner.key;`,
      reports: [],
    },
    {
      name: "a parameter named Reflect is somebody else's object",
      source: `export function read(Reflect: { get(): number }): number {
  return Reflect.get();
}`,
      reports: [],
    },
    {
      name: "Reflect.set is not this rule's method",
      source: `${REFLECT}Reflect.set(owner, key, 1);`,
      reports: [],
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
    {
      name: "a type parameter shadowing an alias is the parameter, not the alias",
      source: `type Value = unknown;
export function save<Value>(value: Value): void {
  void value;
}`,
      reports: [],
    },
    {
      name: "a mapped type's key is bound where it is read",
      source: `type Key = unknown;
export type Mapped<Input> = { readonly [Key in keyof Input]: (x: Key) => void };`,
      reports: [],
    },
    {
      name: "an infer binder shadows inside the branch it is bound for",
      source: `type Item = unknown;
export type Unpacked<Input> = Input extends Promise<infer Item> ? (x: Item) => void : never;`,
      reports: [],
    },
    {
      // The wrong fix for the case above is to take every `infer` name out of
      // the whole conditional. TypeScript binds one only in the true branch, so
      // the same name elsewhere is still whatever the file declared.
      name: "and nowhere else in the conditional",
      source: `type Item = unknown;
export type Fallback<Input> = Input extends string ? never : (x: Item) => void;`,
      reports: ["Parameter `x`"],
    },
  ],

  "no-unknown-returns": [
    {
      name: "a declared unknown return is the contract this refuses",
      source: `${USER}export function load(): unknown {
  return input;
}`,
      reports: ["6:25"],
    },
    {
      name: "an inferred return type is not a declared contract",
      source: `${USER}export function load() {
  return input;
}`,
      reports: [],
    },
    {
      name: "`Promise<unknown>` is the same contract one await later",
      source: `${USER}export async function load(): Promise<unknown> {
  return input;
}`,
      reports: ["6:31"],
    },
    {
      name: "a promise of a domain type is what the rule asks for",
      source: `${USER}export async function load(): Promise<User> {
  return user;
}`,
      reports: [],
    },
    {
      name: "a union with unknown in it is unknown",
      source: `${USER}export function load(): string | unknown {
  return input;
}`,
      reports: ["6:25"],
    },
    {
      name: "an alias that only renames unknown is still unknown",
      source: `${USER}type Payload = unknown;
export function load(): Payload {
  return input;
}`,
      reports: ["7:25"],
    },
    {
      name: "a type parameter shadowing an alias is the parameter, not the alias",
      source: `${USER}type Value = unknown;
export function load<Value>(value: Value): Value {
  return value;
}`,
      reports: [],
    },
    {
      name: "a method signature declares a return contract too",
      source: `${USER}export interface Loader {
  load(): unknown;
}`,
      reports: ["7:11"],
    },
    {
      name: "a function type alias declares one as well",
      source: `${USER}export type Loader = () => unknown;`,
      reports: ["6:28"],
    },
    {
      name: "unknown behind a field is not the return contract",
      source: `${USER}export function load(): { readonly cause: unknown } {
  return { cause: input };
}`,
      reports: [],
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
    {
      name: "a type parameter shadowing an alias is the parameter, not the alias",
      source: `type Value = unknown;
export type Index<Value> = Record<string, Value>;`,
      reports: [],
    },
    {
      name: "and a mapped type's value reads the same binder",
      source: `type Value = object;
export type Mapped<Value> = { readonly [K in string]: Value };`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/**
 * Every rule the base turns on, wherever it turns it on. The scoped four are
 * enabled in an override rather than at the top level, and a check that read
 * only `rules` would call each of them a rule no repo runs.
 */
const enabled = await (async (): Promise<string[]> => {
  const base = record(
    (await jsonObjects(REPO, ["oxlint.base.json"], "JSON with comments")).read[0]?.value,
  );
  const overrides = Array.isArray(base["overrides"]) ? base["overrides"] : [];
  const blocks = [record(base["rules"]), ...overrides.map((each) => record(record(each)["rules"]))];
  return blocks
    .flatMap((block) => Object.keys(block))
    .filter((rule) => rule.startsWith("anti-slop/"))
    .map((rule) => rule.slice("anti-slop/".length))
    .toSorted((left, right) => left.localeCompare(right));
})();

describe("anti-slop rules", () => {
  for (const [rule, list] of Object.entries(HOUSE)) cases(rule, list);

  // Asked of the plugin and the config rather than of a fixture: a rule that is
  // not in the base is a rule no repo runs, and a name in the base the plugin
  // does not define is a rule nobody notices is missing. The cases above enable
  // each rule by name themselves and would pass either way.
  test("the base enables every rule the plugin defines, and no name it does not", () => {
    const defined = Object.keys(antiSlop.rules).toSorted((left, right) =>
      left.localeCompare(right),
    );
    expect(enabled).toEqual(defined);
  });

  test("and the unscoped ones fire in an ordinary source file", async () => {
    const wired = (await oxlint(underBase(".ts", HOUSE))).join("\n");
    for (const rule of Object.keys(HOUSE)) {
      expect(wired).toContain(`anti-slop(${rule})`);
    }
  });
});
