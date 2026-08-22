import { expect } from "bun:test";

/**
 * bun types its asymmetric matchers as `any`, so every `toEqual([...])` built
 * from one is an `any[]` and the unsafe-argument rule fires on the assertion
 * rather than on anything unsafe. The cast is the whole of the fix, in one
 * place, rather than a rule switched off across every suite.
 */
export function containing(text: string): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- nothing here can check it: bun types the matcher as `any`, and the object it answers is a matcher rather than the string it stands in for, so no runtime check would be true of it
  return expect.stringContaining(text) as string;
}
