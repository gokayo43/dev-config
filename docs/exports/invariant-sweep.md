# The invariant sweep

`@gokayo43/dev-config/invariant-sweep.ts` exports one thing: `test`, which is
`@playwright/test`'s own `test` with the `page` fixture replaced by a watched
one. A repo swaps its import and every spec it already has is swept:

```ts
import { test } from "@gokayo43/dev-config/invariant-sweep.ts";
import { expect } from "@playwright/test";

test("the pricing page loads", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading")).toBeVisible();
});
```

Three invariants, on every page the test visits:

- no `console.error`,
- no uncaught error in the page,
- `documentElement.scrollWidth` no wider than its `clientWidth`.

They are invariants and not assertions because no single spec owns them. A flow
test knows what it came to click; nobody's job is to notice that the checkout
page has been logging a failed request for three weeks. Written as assertions
they would have to be repeated in every spec, and would be missing from the one
that mattered.

## What "every page" means

The word is the whole claim, so it is worth being precise about how it is kept.

The measuring runs **in the page**, installed by a Playwright init script that
runs in every document before anything else, and reports back through an exposed
binding. It checks on `load`, again when `document.fonts` settles, and on the
frame after any mutation of the document — which is what covers a
client-rendered route change that fires no `load` at all.

That covers three cases a simpler design would quietly miss:

| The page                                      | A check after each `goto` | A check at the end of the test | This |
| --------------------------------------------- | ------------------------- | ------------------------------ | ---- |
| navigated to by clicking a link               | missed                    | seen if it is the last one     | seen |
| the test navigated away from                  | seen                      | missed                         | seen |
| that only overflows after it finished loading | missed                    | seen if it is the last one     | seen |

There is also nothing to race. A check run from the test process is a
`page.evaluate`, and a spec that navigates again immediately destroys the
execution context mid-measurement — the honest handling of which is to swallow
the rejection, turning "every page" into "every page the spec was slow enough to
let us look at", silently.

The fixture's teardown waits two animation frames before it asserts, so a spec
that ends the instant `goto` resolves is not asserted against a report that had
not arrived yet.

## The allowlist

```ts
// playwright.config.ts
export default defineConfig({
  use: {
    sweepAllowlist: {
      "/embed\\.js$": "the vendor's embed logs a failed beacon on every load; not ours to fix",
    },
  },
});
```

The key is a **regular expression** tested against the URL the violation came
_from_ — the script's URL for a console error, the page's for everything else.
The source rather than the page is what lets one entry cover a third-party embed
wherever it is carried, instead of one entry per page carrying it. A literal URL
works as a pattern; `.*` is there when a pattern is wanted.

The value is the reason, and it is the half a reviewer reads. It is required by
the type, so an entry can be wrong but never unexplained.

A key that is not a valid pattern fails the test naming the key and the option,
rather than surfacing as a bare `SyntaxError` out of a fixture nobody knew was
compiling one.

Being a Playwright option, it can be set once in the config, narrowed per file or
per test with `test.use({ sweepAllowlist })`, and read back out of the trace.

## Why a stale entry does not fail

Everywhere else in this repo a table of exceptions drains itself: an entry that
no longer excuses anything is a failure — that is what
[the response-schema gate](response-schema.md) does, and what CONTEXT.md calls a
ratchet.

Not here, and the difference is worth naming rather than being an oversight. A
ratchet can drain itself only when its whole population is in front of it at
once: the response-schema gate sees every route the app serves in one call, so
"this skip matches nothing" is a fact about the app. The allowlist is consulted
per test run, and a run that did not visit the page carrying the embed did not
use its entry — which is normal, not rot. Failing on it would mean every spec
had to visit every allowlisted page.

## What it does not see

- **An iframe's own overflow.** The check runs in the top frame only: an embed
  scrolling sideways inside its own box is the embed's business, and its
  `documentElement` is not the page.
- **`console.warn`, and any other level.** Errors only.
- **A page that only overflows under an interaction the spec never performs.**
  That is the spec's own assertion to make; this is a floor under what every
  spec already does.
