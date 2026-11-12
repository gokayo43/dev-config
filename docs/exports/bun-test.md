# Awaitable `.resolves` and `.rejects`

`@gokayo43/dev-config/bun-test` is a type declaration that types every matcher
reached through `.resolves` or `.rejects` as returning `Promise<void>`. A repo
names it in its own `tsconfig.json`, beside `bun`:

```jsonc
{
  "compilerOptions": {
    "types": ["bun", "@gokayo43/dev-config/bun-test"],
  },
}
```

It goes in `types` because an entry there is loaded whatever the repo's
`include` says, while an `include` entry into `node_modules` is dropped by the
`exclude: ["node_modules"]` most repos write. Setting `types` at all stops
TypeScript loading every `@types` package by default, so the list names each one
the repo uses, `bun` among them.

## What it changes

bun-types up to 1.4.4 types `expect(p).resolves.toBe(1)` as `void`, while Bun's
docs say to `await` it and its runtime returns a promise there. So
`typescript/await-thenable` refused the await every case owes, and
`typescript/no-floating-promises` could not see a missing one. With the
declaration:

| Line                                              | Without          | With                   |
| ------------------------------------------------- | ---------------- | ---------------------- |
| `await expect(p).resolves.toBe(1)`                | `await-thenable` | nothing                |
| `await expect(p).rejects.toThrow("x")`            | `await-thenable` | nothing                |
| `expect(p).resolves.toBe(1)`, not awaited         | nothing          | `no-floating-promises` |
| `await expect(1).toBe(1)`                         | `await-thenable` | `await-thenable`       |
| `await expect(p).resolves`, no matcher called     | `await-thenable` | `await-thenable`       |
| `expect(Promise.resolve(1)).resolves.toBe("one")` | a type error     | a type error           |

So `typescript/await-thenable` stays on in suites and still catches a pointless
await. Measured on a 628-file suite with no un-awaited chain: all 183
`.resolves` and `.rejects` findings of `await-thenable` went, and nothing new
appeared.

## When it goes

At the first bun-types release that types these chains as awaitable itself,
which is the `AsyncMatchers` of oven-sh/bun#44833 (on Bun's canary since
2026-10-31). The declaration only intersects with what bun-types declares, and on
2026-11-11 a probe type-checked it over bun-types `1.4.4-canary.20261111T140945`,
which carries `AsyncMatchers`, with `skipLibCheck` on and off. No suite here
holds that: the suite runs against the pinned `@types/bun` alone, so check it
again when the fleet's bun-types moves.

`tests/declarations.test.ts` grades the "With" column, and the "Without" column
for the two awaited chains. The other "Without" cells were measured on
2026-11-11 against `@types/bun` 1.4.0 with oxlint 1.80.0 and oxlint-tsgolint
7.0.2001, and Bun 1.4.4's `bun check`, and no suite holds them.
