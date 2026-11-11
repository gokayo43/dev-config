# Narrowing helpers

`@gokayo43/dev-config/narrowing` exports four calls that hand back a value the
compiler could not prove present, or throw a message that says what was
expected and what was found.

```ts
import { must, nth, only, rejectionOf } from "@gokayo43/dev-config/narrowing";

expect(only(rows).sku).toBe("A");
expect(nth(rows, 2).deletedAt).toBeUndefined();
expect(must(order.shippedAt)).toBeInstanceOf(Date);
expect((await rejectionOf(call(), TRPCError)).code).toBe("GATEWAY_TIMEOUT");
```

| Call                          | Returns                                                       | Throws                                                                                                         |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `only(list)`                  | the element of a one-element list                             | on any other length, naming the length                                                                         |
| `nth(list, index)`            | the element at `index`, `undefined` included where it is held | where the list holds no element there, naming index and length                                                 |
| `must(value)`                 | the value, typed without `null` and `undefined`               | on `null` or `undefined`, naming which                                                                         |
| `rejectionOf(promise, Class)` | a promise of the rejection, typed as an instance of `Class`   | rejects on a resolution or on any other rejection, naming what it found and keeping a rejection as the `cause` |

## Why a call and not an operator

Under `noUncheckedIndexedAccess`, `rows[0]` is `Row | undefined`, and the three
spellings that silence the compiler each lose something a case needs:

- `rows[0]?.sku` inside `expect` turns an absence assertion green on an empty
  list: `.toBeUndefined()`, `.not.toBe(…)`, `.not.toHaveProperty(…)` and
  `.toBeFalsy()` all pass when nothing was there to read.
- `rows[0]!` fails only where a dereference follows it. Passed on as an
  argument, spread or returned, `undefined` travels on silently, and
  `typescript/no-non-null-assertion` refuses it anyway.
- `(raised as TypeError).code` claims a class nothing checked, which
  `typescript/consistent-type-assertions` refuses in source and
  `typescript/no-unsafe-type-assertion` refuses in a suite.

`expect(rows).toMatchObject([{ sku: "A" }])` stays the better form where the
count is part of the claim.

## Where it runs

Nothing here imports a test runner, so a `bun test` case, a Playwright spec and
a script take the same module. Like [the invariant sweep](invariant-sweep.md),
and for the same reason, it ships built: a Playwright spec runs under node, and
node strips no types under `node_modules` (`tsdown.config.ts`).
