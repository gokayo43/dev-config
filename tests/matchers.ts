import { expect } from "bun:test";

/**
 * bun types its asymmetric matchers as `any`, so every `toEqual([...])` built
 * from one is an `any[]` and the unsafe-argument rule fires on the assertion
 * rather than on anything unsafe. The cast is the whole of the fix, in one
 * place, rather than a rule switched off across every suite.
 */
export function containing(text: string): string {
  return expect.stringContaining(text) as string;
}
