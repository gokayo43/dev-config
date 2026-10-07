# The invariant sweep

`@gokayo43/dev-config/invariant-sweep` exports one thing: `test`, which is
`@playwright/test`'s own `test` with the **browser context** replaced by one
that watches every page it opens. A repo swaps its import and every spec it already has is swept:

```ts
import { test } from "@gokayo43/dev-config/invariant-sweep";
import { expect } from "@playwright/test";

test("the pricing page loads", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading")).toBeVisible();
});
```

No export here carries an extension. This one and [the route log](route-log.md)
resolve to built JavaScript under `dist/`, because the runner that imports them
is node — `tsdown.config.ts` in the package carries why, and STACK.md's shared
UI library carries the bargain a committed `dist/` is.

Four invariants, on every page the test visits in its context:

- no `console.error`,
- no uncaught error in the page,
- `documentElement.scrollWidth` no wider than its `clientWidth`,
- nothing moves that the user did not move, from the first frame the page
  paints (under "Movement nobody asked for" below).

They are invariants and not assertions because no single spec owns them. A flow
test knows what it came to click; nobody's job is to notice that the checkout
page has been logging a failed request for three weeks. Written as assertions
they would have to be repeated in every spec, and would be missing from the one
that mattered.

## What "every page" means

The word is the whole claim, so it is worth being precise about how it is kept.

The measuring runs **in the page**, installed by a Playwright init script that
runs in every document before anything else, and reports back through an exposed
binding. It checks on `load`, again when `document.fonts` settles, when any
subresource finishes loading, and on the frame after any mutation of the
document — which is what covers a client-rendered route change that fires no
`load` at all.

That covers four cases a simpler design would quietly miss:

| The page                                       | A check after each `goto` | A check at the end of the test | This                            |
| ---------------------------------------------- | ------------------------- | ------------------------------ | ------------------------------- |
| navigated to by clicking a link                | missed                    | seen if it is the last one     | seen                            |
| the test navigated away from                   | seen                      | missed                         | seen                            |
| that only overflows after it finished loading  | missed                    | seen if it is the last one     | seen                            |
| that overflows shortly after `load`, then left | missed                    | missed                         | seen, if left by a wrapped call |

Measuring in the page also leaves the measurement nothing to race. A check run
from the test process is a `page.evaluate`, and a spec that navigates again
immediately destroys the execution context mid-measurement — the honest handling
of which is to swallow the rejection, turning "every page" into "every page the
spec was slow enough to let us look at", silently. What still races a navigation
is the drain before a page goes, which the next section covers.

The fixture is the **context** and not the page for one more case, a popup: it
is a page the context opened and the spec may never name, so a `page` fixture
cannot reach it at all. The console and thrown errors are listened for on the
context too, for the same case: Playwright sends a page's events only once a
listener on that page asks for them, and a popup can log before any listener
attached as it opens has asked. A context the spec builds itself through `browser` is
another matter, under "What it does not see".

## The horizon a document is measured to

A document is drained before it goes: at the end of the test, and before any
call that replaces it — `goto`, `reload`, `goBack`, `goForward` and
`setContent`, all wrapped for this. Draining is two waits, because a document can be behind in two ways.

It may not have **measured** yet. A page that lays its overflow out on a timer
after `load` has nothing to say when `goto` resolves, and a spec that navigates
on that instant destroys the document before the layout it would have failed on
ever happens. So the drain waits for the document's own word that it has gone
quiet — 500ms without a load, a mutation or a font settling, which is
Playwright's own idea of an idle page applied to the DOM. A spec that did its
own work between two `goto`s has already spent that window and waits for
nothing.

And it may have measured without the report having **crossed**. A report leaves
on the frame after the check runs, so two animation frames follow — otherwise a
spec that ends the instant `goto` resolves would be asserted against a report
that had not arrived yet. A page that navigates on a timer destroys the context
that flush runs in; that one rejection is caught, and the verdict is given on
what was collected — letting it through would replace the list the sweep spent
the whole test building with a message about the flush.

The wait for quiet has two caps. A document that changes more often than the
quiet window never goes quiet — an animation is one — so once it has loaded and
its fonts have settled, the wait ends at most twice the quiet window, 1s, after
that: it has been measured on every one of those changes anyway. A document whose
`load` or fonts never arrive is waited on for 5s from when it started, and then
let go.

## Movement nobody asked for

The browser reports every movement of a page's content through the Layout
Instability API: a `layout-shift` entry, with the elements that moved as its
`sources`. The fourth invariant is that every entry is one the user caused. One
entry is enough to fail the test: there is no score threshold and no tolerance
for a small one. It is measured in the page, by the observer the init script
installs before anything else in the document runs, so it holds from the first
frame the page paints. The observer also asks for the entries the browser
buffered before it was registered. A shift is reported as it happens, so a page
the spec leaves by clicking a link, which nothing drains, has already said what
moved on it.

Most of what this invariant exists for happens while the page is still loading:
an image with no `width` and `height` taking its size when its bytes arrive,
data that comes back and pushes a list down, a banner inserted once a request
answers, a web font swapping in at a different size. All of that counts,
however early it lands.

The user caused a shift when the browser marks it `hadRecentInput`: a click, a
key or a tap in the 500ms before. Playwright's `fill`, `selectOption` and
`setInputFiles`, called on a page or a locator, send nothing the browser counts
as input, so the fixture marks the document as acted on from the moment each
starts until 500ms after it returns, through a mark the page itself cannot
make. Three things count as the page moving on its own:

- **Content a click asked for that arrives more than 500ms later.** A panel
  behind a slow request fails, which is what a person on a slow connection sees
  too. Show the panel's frame at the click, and fill it when the data arrives.
- **A shift `hover`, `focus()` or `dispatchEvent` causes,** or an `input` event
  the page dispatches itself. None of them is input to the browser.
- **A shift an embed's own late content causes in the page.** An embed that
  grows when its content loads pushes the page carrying it, and the browser
  says what moved, never what moved it.

Typing into an embed, a payment field in a cross-origin iframe say, is input
to the page carrying it too: a shift it causes in that page passes.

The violation names the page, the shift's score, and what moved and how far as
the browser's `sources` give it, up to three of them:

```text
layout-shift at https://app.example/pricing — score 0.0045, with no input in the 500ms before: main#content moved 60px down; reserve the space for whatever arrives late, or move it with a transform
```

The page writes everything up to the advice, and the sweep adds the advice
itself, so a long list of class names never cuts it off.

The fix is almost always room reserved before the content arrives: a
`min-height` on the slot a banner or an embed fills, `width` and `height` on an
image, a skeleton the size of what replaces it. An animation that moves an
element through `top`, `margin` or the size of a neighbour is a shift to the
browser on every frame, where `transform` is not.

### A page whose shift comes and goes

A shift the page makes for itself lands at a different moment on every load,
and on some loads not at all. On the fleet's stats site the top bar moved in 16
loads of 20, anywhere from 200ms to 415ms in (dev-config#141). A page like that
fails the sweep on the runs where it shifts and passes on the others, until the
shift is fixed or the page is allowlisted. That is the price of counting from
first paint. Counting only once a page has gone quiet would keep such a page
green, and would never see the late content above either.

What does not come and go is the verdict on a page whose shift does not: on
this sweep's own fixtures, a shift during load, a shift the user caused and a
page that never shifts each give the same verdict on 20 runs, on a quiet
renderer and on a renderer Chromium slows sixfold.

## What a page is allowed to say about itself

A page is not a trusted narrator, and every one of these invariants reaches the
sweep through something the page says: its own script reports overflow and
layout shifts, and its console and its stack name where an error came from.

The bridge takes **one string**, and a `kind` it accepts only from the two the
page measures, `overflow` and `layout-shift`. The URL is the one Playwright says
that frame is at, and a report from anything but the top frame is dropped — so a cross-origin iframe cannot
invent a violation for the page carrying it, nor choose which allowlist bucket
one lands in. The string is stripped of every control character, which is what
makes an ANSI escape inert (it needs its `ESC`) and a `::error::` workflow
command inert (it needs a line of its own). The `::error` text itself survives,
mid-sentence, where it is exactly text.

The same reasoning decides where a console error is attributed. The console
reports the _script's_ URL, and a script's URL is whatever its `//# sourceURL=`
comment claims — so an inline script of ours can wear a vendor's name and land
in the vendor's bucket. A claimed URL is therefore honoured only when a document
or script **actually loaded** from it in this page: a fact about responses the
browser received, which no page can write.

A `pageerror` arrives with no frame, so its origin is read out of the stack and
honoured on those same terms. That is what lets an embed's own thrown error be
allowlisted by the embed's address rather than by the page's.

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
_from_ — the script's URL for a console error or a thrown error, the page's for
overflow and for a layout shift. The source rather than the page is what lets
one entry cover a third-party embed's errors wherever it is carried, instead of
one entry per page carrying it.

A shift is the exception that has no source to name. The browser says what
moved, never what moved it, so a widget that resizes itself and pushes the page
down is allowed by naming the pages that carry it:

```ts
sweepAllowlist: {
  "/pricing$": "the scheduling widget sizes itself once it has loaded; its height is the vendor's",
},
```

That entry tolerates every violation on `/pricing`, its own console errors
included, as an entry for an overflowing page always has.

A key is a pattern, not a URL. A metacharacter in a URL needs its backslash:
`"https://cdn.vendor.example/embed.js?v=3"` as written does not match that
address, since `?` makes the `s` before it optional. And a key is **unanchored**:
`"/checkout"` also matches `/checkout-v2`, so write `"/checkout$"` when one page
is meant.

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

## Recording a video

Set `E2E_VIDEO=on` for the `playwright test` process and every test records a
video of each page its context opens, popups included, whatever the config's
`use.video` says. No config or spec changes:

```sh
E2E_VIDEO=on bunx playwright test --output /path/to/recordings
```

Each test gets a directory of its own under the output directory, named from its
spec file and title, holding `video.webm` for the first page it opened and
`video-1.webm`, `video-2.webm` for the next ones. `--output` defaults to
`test-results`, and Playwright **deletes** the directory it names before the run
starts, so give a recording a directory of its own. A test that fails still
leaves its video, and the sweep fails it exactly as it would without one.

The recording is Playwright's own: the switch turns the config's `video` to `on`
and keeps the rest of it, `size` included, and the context this fixture watches
is the one Playwright built from that value. Playwright's encoder caps a
recording at 1 Mbit/s, so a minute of a page that keeps moving takes at most
about 7.5 MB, and a still page far less.

Unset or blank, nothing changes: the config's `use.video`, or Playwright's
default of none, decides. Any other value, `off` included, fails the run before
a test starts, with a message naming `on` as the one value the switch takes. A
switch that read a typo as off would leave a run that was asked for a recording
green and empty.

Two things the switch does not reach:

- A spec file that calls `test.use({ video })` itself keeps its own value, since
  Playwright applies a spec's `test.use` after every fixture this package
  defines.
- A page in a context the spec builds itself through `browser` is not recorded,
  as it is not swept (dev-config#136).

A repo that declares `video` as an option again on top of this `test`, with
`test.extend({ video: [..., { option: true }] })`, fails to load: this package
already declares it as a fixture that is not an option.

## What it does not see

- **A context the spec builds itself.** A page opened through
  `browser.newPage()` or `browser.newContext()` is outside the context this
  fixture watches, so it is neither swept nor recorded (dev-config#136).
- **An iframe's own overflow, or its own layout shifts.** The checks run in the
  top frame only: an embed scrolling sideways or rearranging itself inside its
  own box is the embed's business, and its `documentElement` is not the page.
  An embed that grows and pushes the page is the page's, and is seen.
- **A shift while `fill`, `selectOption` or `setInputFiles` waits.** The mark
  covers the whole call, so a shift the page makes on its own while the action
  is still waiting for its element to become ready is excused with it.
- **A layout shift on Firefox or WebKit.** Neither has the Layout Instability
  API.
- **A second shift of exactly the same elements.** A document names a set of
  moved elements once, so a later shift that moves the same set again shows on
  the first run after the earlier one is fixed.
- **`console.warn`, and any other level.** Errors only.
- **A service worker's console errors and thrown errors.** A service worker
  belongs to no page: Playwright reports its console messages with no page
  attached, and the sweep, whose verdict is about pages, passes over them.
- **Graceful empty states**, which testing.md names alongside zero console
  errors and no layout overflow.
  They are not expressible here: what a page should show when it has no data is
  a per-page contract — a heading, a call to action, the absence of a spinner —
  and there is no property of _any_ page that says it. A repo asserts it in the
  spec that put the page in that state, which is where the contract is known.
- **Another stack's copy of a URL.** The allowlist matches text; two deployments
  of one app share every path.
- **A page that only overflows under an interaction the spec never performs.**
  That is the spec's own assertion to make; this is a floor under what every
  spec already does.
- **A change a page makes long after it went quiet, on a page the spec has
  left.** The horizon above is what "before the document is replaced" means; a
  page that has been still for half a second and then reflows a second later is
  past it. A spec that stays on the page is not: the check runs there whenever
  the page changes, however late.
- **What a document written with `document.write` does next.** The write reopens
  the document, and the observer installed before it does not survive that: the
  written markup itself is measured, and nothing appended afterwards is
  (dev-config#118).
- **What a page laid out after a navigation it performed for itself.** A
  redirect, or a link the spec clicked, replaces the document without going
  through a call the fixture can wrap, so that document is never asked to drain:
  everything it had already measured has crossed and is in the verdict, and only
  what it would have measured in its last moments is lost.
