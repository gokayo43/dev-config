// bun-types types every matcher reached through `.resolves` and `.rejects` as
// returning `void`, while Bun's docs say to `await` it and its runtime returns
// a promise there. This types those chains as `Promise<void>`, so
// `typescript/await-thenable` accepts the await and
// `typescript/no-floating-promises` reports a missing one. Delete it at the
// first bun-types release that types them as awaitable itself, which is the
// `AsyncMatchers` of oven-sh/bun#44833.
//
// Three shapes that look simpler do not hold. Replacing `resolves` and
// `rejects` outright conflicts (TS2430) with the bun-types that carry
// `AsyncMatchers`, so the settled matchers are intersected with bun-types' own
// and come first, winning overload resolution. Mapping `resolves` and `rejects`
// inside themselves is circular (TS2615). Reading only a matcher's last
// overload takes bun-types' `<X = T>(expected: NoInfer<X>)` escape hatch, whose
// `X` erases to `unknown` and accepts any argument; so a matcher keeps both its
// signatures unless the second only widens the first.
import type { MatchersBuiltin } from "bun:test";

type Settled<F> = F extends {
  (...args: infer First): void;
  (...args: infer Second): void;
}
  ? First extends Second
    ? (...args: First) => Promise<void>
    : { (...args: First): Promise<void>; (...args: Second): Promise<void> }
  : F;

type SettledMatchers<M> = {
  [K in keyof M as K extends "resolves" | "rejects" ? never : K]: K extends "not"
    ? SettledMatchers<M[K]>
    : Settled<M[K]>;
};

declare module "bun:test" {
  interface Matchers<T> {
    resolves: SettledMatchers<Matchers<Awaited<T>>> & MatchersBuiltin<T>["resolves"];
    rejects: SettledMatchers<Matchers> & MatchersBuiltin<T>["rejects"];
  }
}
