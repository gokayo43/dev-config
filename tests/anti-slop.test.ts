import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { materialise, type Tree } from "./tree.ts";

const REPO = dirname(import.meta.dir);
const OXLINT = join(REPO, "node_modules/.bin/oxlint");
const PLUGIN = join(REPO, "anti-slop/index.js");
const BASE = join(REPO, "oxlint.base.json");

/**
 * A fixture is linted by the same binary CI runs, in a tree of its own: the
 * rules here are a plugin oxlint loads and drives, so nothing short of running
 * it says whether a rule fires. Type-aware checking is off because a fixture
 * tree has no tsconfig — every rule in this plugin is syntactic, and the ones
 * that are not live in `oxlint.base.json` as oxlint's own.
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

async function violations(rule: string, source: string): Promise<string[]> {
  return await oxlint({ ".oxlintrc.json": alone(rule), "fixture.ts": source });
}

interface Fixtures {
  /** What the rule exists to reject. */
  readonly violating: string;
  /** The same intent written the way the rule asks for, including its sanctioned exceptions. */
  readonly clean: string;
}

const FIXTURES = {
  "no-chained-type-assertions": {
    violating: `interface User {
  readonly id: string;
}
declare const input: unknown;
export const user = input as object as User;
`,
    clean: `interface User {
  readonly id: string;
}
declare function parseUser(value: unknown): User;
declare const input: unknown;
export const user = parseUser(input);
export const ids = ["a", "b"] as const;
`,
  },
  "no-known-value-widening": {
    violating: `type Handler = () => void;
declare const startHandler: Handler;
export const handlers: Record<string, Handler> = { start: startHandler };
`,
    clean: `type Handler = () => void;
declare const startHandler: Handler;
export const handlers = { start: startHandler } satisfies Record<string, Handler>;
`,
  },
  "no-object-parameters": {
    violating: `export function save(value: object): void {
  void value;
}
`,
    clean: `interface Payload {
  readonly id: string;
}
export function save(value: Payload): void {
  void value;
}
`,
  },
  "no-runtime-typeof": {
    violating: `declare function useName(name: string): void;
export function apply(input: string | number): void {
  if (typeof input === "string") useName(input);
}
`,
    clean: `declare function useName(name: string): void;
export function apply(name: string): void {
  useName(name);
}
`,
  },
  "no-shape-in-symbol-names": {
    violating: `export interface UserShape {
  readonly id: string;
}
`,
    clean: `export interface User {
  readonly id: string;
}
`,
  },
  "no-unknown-parameters": {
    violating: `export function handle(input: unknown): void {
  void input;
}
`,
    clean: `interface Payload {
  readonly id: string;
}
export function handle(input: Payload): void {
  void input;
}
export function wrap(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}
`,
  },
  "no-unknown-type-aliases": {
    violating: `export type Payload = unknown;
`,
    clean: `export type Payload = { readonly id: string };
`,
  },
  "no-unsafe-dictionary-type": {
    violating: `export type Bag = Record<string, unknown>;
`,
    clean: `export type Bag = Record<string, string>;
`,
  },
  "no-widen-then-assert": {
    violating: `interface User {
  readonly id: string;
}
export function widen(user: User): User {
  const wide: unknown = user;
  return wide as User;
}
`,
    clean: `interface User {
  readonly id: string;
}
export function widen(user: User): User {
  return user;
}
`,
  },
} satisfies Record<string, Fixtures>;

describe("anti-slop rules", () => {
  for (const [rule, { violating, clean }] of Object.entries(FIXTURES)) {
    describe(rule, () => {
      test("rejects the violating tree", async () => {
        const reported = await violations(rule, violating);
        expect(reported).not.toEqual([]);
        for (const line of reported) expect(line).toContain(`anti-slop(${rule})`);
      });

      test("passes the clean tree", async () => {
        expect(await violations(rule, clean)).toEqual([]);
      });
    });
  }

  // A rule that is not in the base is a rule no repo runs — the fixtures above
  // enable it by name themselves and would pass either way.
  test("the base enables every rule the plugin defines", async () => {
    const wired = await oxlint({
      ".oxlintrc.json": JSON.stringify({ extends: [BASE], options: { typeAware: false } }),
      ...Object.fromEntries(
        Object.entries(FIXTURES).map(([rule, { violating }]) => [`${rule}.ts`, violating]),
      ),
    });
    for (const rule of Object.keys(FIXTURES)) {
      expect(wired.join("\n")).toContain(`anti-slop(${rule})`);
    }
  });
});
