import { describe, expect, test } from "bun:test";

import { reportsFor } from "./lint-fixture.ts";

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
    // The one place this port deliberately answers differently from upstream:
    // an anonymous target naming exactly the keys of the literal under it
    // discards nothing, and upstream's only escapes from reporting it are
    // deleting the annotation or naming a type for it. Both cases below are
    // `1` upstream.
    [`${PRELUDE} const commands: { start: Command } = { start: startCommand };`, 0],
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
    [`${PRELUDE} function create(): { start: Command } { return { start: startCommand }; }`, 0],
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
