import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { materialise, type Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);
const OXLINT = join(REPO, "node_modules/.bin/oxlint");
const PLUGIN = join(REPO, "anti-slop/index.js");
const BASE = join(REPO, "oxlint.base.json");

/**
 * A case is linted by the same binary CI runs, in a tree of its own: the rules
 * here are a plugin oxlint loads and drives, so nothing short of running it
 * says whether a rule fires. Type-aware checking is off because a fixture tree
 * has no tsconfig — every rule in this plugin is syntactic, and the ones that
 * are not live in `oxlint.base.json` as oxlint's own.
 *
 * One run per block rather than per case: a case is a file in the tree, and
 * grouping the diagnostics by file is what puts each one back with its case.
 * Nine spawns instead of a hundred, with no case able to see another's.
 */
async function oxlint(tree: Tree): Promise<string[]> {
  const root = await materialise(tree);
  const proc = Bun.spawn([OXLINT, "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output
    .split("\n")
    .filter((line) => /^\S+:\d+:\d+: (error|warning)/.test(line))
    .map((line) => line.trim());
}

/** The rule under test and nothing else, so a case cannot pass on another rule's diagnostic. */
function alone(rule: string): string {
  return JSON.stringify({
    plugins: [],
    categories: { correctness: "off" },
    jsPlugins: [{ name: "anti-slop", specifier: PLUGIN }],
    rules: { [`anti-slop/${rule}`]: "error" },
  });
}

/** Where a diagnostic sits, so a file's diagnostics read in source order whatever order they arrived in. */
function position(line: string): [number, number] {
  const [, at = "0", column = "0"] = line.split(":");
  return [Number(at), Number(column)];
}

const runs = new Map<string, Promise<readonly (readonly string[])[]>>();

/**
 * Every case in one block, lit by one oxlint run and handed back per case.
 * Memoised on the key so the block's cases share the run rather than repeating
 * it, and started by whichever case is executed first.
 */
async function reportsFor(
  key: string,
  rule: string,
  sources: readonly string[],
): Promise<readonly (readonly string[])[]> {
  const started =
    runs.get(key) ??
    (async () => {
      const files = sources.map((_, index) => `case-${index}.ts`);
      const reported = await oxlint({
        ".oxlintrc.json": alone(rule),
        ...Object.fromEntries(files.map((file, index) => [file, sources[index] ?? ""])),
      });
      const byFile = new Map<string, string[]>();
      for (const line of reported) {
        const [path = ""] = line.split(":");
        const name = path.slice(path.lastIndexOf("/") + 1);
        byFile.set(name, [...(byFile.get(name) ?? []), line]);
      }
      return files.map((file) =>
        (byFile.get(file) ?? []).toSorted((left, right) => {
          const [leftAt, leftColumn] = position(left);
          const [rightAt, rightColumn] = position(right);
          return leftAt - rightAt || leftColumn - rightColumn;
        }),
      );
    })();
  runs.set(key, started);
  return await started;
}

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
  ],

  "no-widen-then-assert": [
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

/** The case a rule exists to reject, which is what the base has to be wired to catch. */
function violating(list: readonly Case[]): string {
  const first = list.find(({ reports }) => reports.length > 0);
  if (first === undefined) throw new Error("a rule with no violating case is a rule with no suite");
  return first.source;
}

describe("anti-slop rules", () => {
  for (const [rule, list] of Object.entries(HOUSE)) cases(rule, list);

  // A rule that is not in the base is a rule no repo runs — the cases above
  // enable it by name themselves and would pass either way.
  test("the base enables every rule the plugin defines", async () => {
    const wired = await oxlint({
      ".oxlintrc.json": JSON.stringify({ extends: [BASE], options: { typeAware: false } }),
      ...Object.fromEntries(
        Object.entries(HOUSE).map(([rule, list]) => [`${rule}.ts`, violating(list)]),
      ),
    });
    for (const rule of Object.keys(HOUSE)) {
      expect(wired.join("\n")).toContain(`anti-slop(${rule})`);
    }
  });
});

/**
 * Upstream's own fixtures for the three rules it ships tests for, run against
 * this port as a differential oracle: upstream is the implementation these
 * rules were ported from, so its verdicts are the contract the port has to
 * meet. Copied from dmmulroy/anti-slop at commit abaeb63,
 * `src/rules/*.test.ts`, with the counts it declares.
 */
describe("upstream's fixtures, against this port", () => {
  const PRELUDE = "type Command = () => void; const startCommand = () => {};";

  /** A case as upstream writes one: the source, and how many diagnostics it must draw. */
  function conformance(rule: string, sources: readonly [string, number][]): void {
    describe(rule, () => {
      const codes = sources.map(([code]) => code);
      for (const [index, [code, errors]] of sources.entries()) {
        test(`${errors === 0 ? "valid" : `${errors} error(s)`}: ${code}`, async () => {
          const reported = (await reportsFor(`upstream/${rule}`, rule, codes))[index] ?? [];
          expect(reported).toHaveLength(errors);
        });
      }
    });
  }

  conformance("no-object-parameters", [
    ["interface Owner { readonly id: string } function f(value: Owner) {}", 0],
    ["function f<Value>(value: Value) {}", 0],
    ["function f<Value extends object>(value: Value) {}", 0],
    ["function f<Value extends Owner, Owner extends { readonly id: string }>(value: Value) {}", 0],
    ["type Owner = { readonly id: string }; function f<Value extends Owner>(value: Value) {}", 0],
    ["function f(value: object) {}", 1],
    ["type Alias = object; function f(value: Alias) {}", 1],
    ["type Alias = (object); function f(value: Alias) {}", 1],
  ]);

  conformance("no-known-value-widening", [
    [`${PRELUDE} const commands: Record<string, Command> = {};`, 0],
    [`${PRELUDE} type Index<T> = Record<string, T>; const commands: Index<Command> = {};`, 0],
    [`${PRELUDE} class Registry { commands: Record<string, Command> = {}; }`, 0],
    [`${PRELUDE} class Registry { accessor commands: Record<string, Command> = {}; }`, 0],
    [`${PRELUDE} let commands: Record<string, Command>; commands = {};`, 0],
    [`${PRELUDE} function create(): Record<string, Command> { return {}; }`, 0],
    [`${PRELUDE} const create = (): Record<string, Command> => ({});`, 0],
    [`${PRELUDE} const commands = {} as Record<string, Command>;`, 0],
    [`${PRELUDE} const commands = <Record<string, Command>>{};`, 0],
    [`${PRELUDE} const commands = { start: startCommand };`, 0],
    [`${PRELUDE} const commands = { start: startCommand } as const;`, 0],
    [`${PRELUDE} const commands = { start: startCommand } satisfies Record<string, Command>;`, 0],
    [
      `${PRELUDE} type Commands = Record<string, Command>; const commands = { start: startCommand } as const satisfies Commands;`,
      0,
    ],
    [
      `${PRELUDE} interface Commands { readonly start: Command } const commands: Commands = { start: startCommand };`,
      0,
    ],
    [
      `${PRELUDE} type Commands = { readonly start: Command }; const commands: Commands = { start: startCommand };`,
      0,
    ],
    [
      `${PRELUDE} type PermissionLevels = { readonly [Level in Permission]: number }; const levels: PermissionLevels = { admin: 1 };`,
      0,
    ],
    [
      `${PRELUDE} type Index<T> = Record<string, T>; type CommandsByName = Index<Command>; const commands: CommandsByName = { start: startCommand };`,
      0,
    ],
    [`${PRELUDE} function create() { return { start: startCommand }; }`, 0],
    [
      `${PRELUDE} interface Commands { readonly start: Command } function create(): Commands { return { start: startCommand }; }`,
      0,
    ],
    [
      `${PRELUDE} declare function make(): Record<string, Command>; const commands: Record<string, Command> = make();`,
      0,
    ],
    [
      `${PRELUDE} import { Commands } from './types'; const commands: Commands = { start: startCommand };`,
      0,
    ],
    ["const value: unknown = {};", 1],
    ["const value: object = {};", 1],
    ["let value: unknown; value = {};", 1],
    ["function create(): unknown { return {}; }", 1],
    [`${PRELUDE} const commands: Record<string, Command> = { start: startCommand };`, 1],
    [`${PRELUDE} const commands: { [key: string]: Command } = { start: startCommand };`, 1],
    [`${PRELUDE} const commands: { [K in string]: Command } = { start: startCommand };`, 1],
    [`${PRELUDE} const commands: { start: Command } = { start: startCommand };`, 1],
    [`${PRELUDE} const commands = { start: startCommand } as Record<string, Command>;`, 1],
    [
      `${PRELUDE} const commands = ({ start: startCommand } as Record<string, Command>) as object;`,
      1,
    ],
    [
      `${PRELUDE} class Registry { commands: Record<string, Command> = { start: startCommand }; }`,
      1,
    ],
    [`${PRELUDE} let commands: Record<string, Command>; commands = { start: startCommand };`, 1],
    [
      `${PRELUDE} function create(): Record<string, Command> { return { start: startCommand }; }`,
      1,
    ],
    [`${PRELUDE} function create(): { start: Command } { return { start: startCommand }; }`, 1],
    [
      `${PRELUDE} const source = { start: startCommand }; const commands: Record<string, Command> = source;`,
      1,
    ],
    [
      `${PRELUDE} type Index<T> = Record<string, T>; const commands: Index<Command> = { start: startCommand };`,
      1,
    ],
    [
      `${PRELUDE} type Index<T = Command> = Record<string, T>; const commands: Index = { start: startCommand };`,
      1,
    ],
    ["const value: unknown = 1;", 1],
    ["const value: object = [];", 1],
  ]);

  conformance("no-unsafe-dictionary-type", [
    ["type Commands = Record<string, Command>;", 0],
    ["type Metadata = Record<PropertyKey, JsonValue>;", 0],
    ["type PermissionLevels = Record<Permission, number>;", 0],
    ["type Indexed = { [key: string]: Command };", 0],
    [
      "type CompatibleIndexes = { [index: number]: Command; [key: string]: Command | OtherCommand };",
      0,
    ],
    ["type Exhaustive = { [K in Permission]: number };", 0],
    ["type Allowed = Record<string, { payload: unknown }>;", 0],
    ["type AlsoAllowed = Record<string, Result<Data, unknown>>;", 0],
    [
      "type Index<T> = Record<string, T>; type EntityIndex<T extends Entity> = Record<string, T>;",
      0,
    ],
    ["type Safe = Index<Command>; type Index<T> = Record<string, T>;", 0],
    [
      "type A = Map<string, unknown>; type B = ReadonlyMap<string, unknown>; type C = WeakMap<object, unknown>;",
      0,
    ],
    ["import { Record } from './local'; type A = Record<string, unknown>;", 0],
    ["type Record<K, V> = { key: K; value: V }; type A = Record<string, unknown>;", 0],
    ["type Readonly<T> = { value: T }; type A = Record<string, Readonly<unknown>>;", 0],
    ["type NonNullable<T> = { value: T }; type A = Record<string, NonNullable<unknown>>;", 0],
    [
      "type Value<T> = T; type Index<T = Command, U = Value<T>> = Record<string, U>; type A = Index;",
      0,
    ],
    ["interface Owner { readonly id: string } type A = Record<string, unknown & Owner>;", 0],
    [
      "interface Owner { readonly id: string } interface Child extends Owner {} type A = Record<string, Child>;",
      0,
    ],
    [
      "interface Owner { readonly id: string } interface Child extends Owner { readonly __brand?: never } type A = Record<string, Child>;",
      0,
    ],
    [
      "interface Escape {} interface Escape { readonly id: string } type A = Record<string, Escape>;",
      0,
    ],
    [
      "interface Escape { readonly id: string } interface Escape {} type A = Record<string, Escape>;",
      0,
    ],
    ["interface Owner { readonly id: string } type A = Record<string, object & Owner>;", 0],
    [
      "type Wrap<T> = { readonly wrapped: T }; type Inner<T, U> = { readonly value: T } & Wrap<U>; type Outer<T, U> = Record<string, Inner<T, U>>; declare function f<T, U>(): Outer<T, U>;",
      0,
    ],
    ["type A = Record<string, unknown>;", 1],
    ["type A = { [key: string]: any };", 1],
    ["type A = { [index: number]: Command; [key: string]: unknown | Command };", 1],
    ["type A = { [K in PropertyKey]: object };", 1],
    ["type A = { [K in PropertyKey]: NonNullable<unknown> };", 1],
    ["type A = { [key: string]: NonNullable<unknown> };", 1],
    ["type A = Record<string, {}>;", 1],
    ["interface Escape {} type A = Record<string, Escape>;", 1],
    ["interface Escape { readonly __brand?: never } type A = Record<string, Escape>;", 1],
    ["type Escape = { readonly __brand?: never }; type A = Record<string, Escape>;", 1],
    ["type A = Record<string, { readonly __brand?: never }>;", 1],
    ["type A = Record<string, string | unknown>;", 1],
    ["interface Escape {} type A = Record<string, string | Escape>;", 1],
    ["type A = Record<string, unknown & {}>;", 1],
    ["interface Owner { readonly id: string } type A = Record<string, any & Owner>;", 1],
    ["type Escape = unknown; type A = Record<string, Escape>;", 1],
    ["type Dict = Record<string, unknown>;", 1],
    ["type A = Readonly<Partial<Required<(Record<string, unknown>)>>>;", 1],
    ["type A = { readonly [key: string]: unknown };", 1],
    ["type A = { readonly [K in string]: unknown };", 1],
    ["type Source = Record<string, unknown>; type A = Pick<Source, string>;", 2],
    ["type Source = Record<string, unknown>; type A = Omit<Source, never>;", 2],
    ["type Index<T> = Record<string, T>; type A = Index<unknown>;", 1],
    ["interface A { [key: string]: unknown }", 1],
    ["type A = Readonly<Record<string, unknown>>;", 1],
    ["type A = Record<string, Readonly<unknown>>;", 1],
    ["type A = Record<string, Partial<unknown>>;", 1],
    ["type A = Record<string, Required<unknown>>;", 1],
    ["type Escape = Readonly<unknown>; type A = Record<string, Escape>;", 1],
    ["type Wrapped<T> = Readonly<T>; type A = Record<string, Wrapped<unknown>>;", 1],
    ["type A = Record<string, NonNullable<unknown>>;", 1],
    ["type Escape = NonNullable<unknown>; type A = Record<string, Escape>;", 1],
    ["type Unsafe = Record<string, unknown>; const x: Unsafe = {}; const y: Unsafe = {};", 1],
    ["type Unsafe = Record<string, unknown>; type AlsoUnsafe = Unsafe; const x: Unsafe = {};", 2],
    ["type Index<T = unknown> = Record<string, T>; type A = Index;", 1],
    ["type Index<T, U = T> = Record<string, U>; type A = Index<string, unknown>;", 1],
    ["type Index<T, U = T> = Record<string, U>; type A = Index<unknown>;", 1],
    [
      "type Value<T> = T; type Index<T, U = Value<T>> = Record<string, U>; type A = Index<unknown>;",
      1,
    ],
    [
      "type Marker<T> = { readonly __brand?: never }; type Index<T, U = Marker<T>> = Record<string, U>; type A = Index<Item>;",
      1,
    ],
  ]);
});
