# The count budget

`@gokayo43/dev-config/count-budget` exports `test`: [the invariant sweep's](invariant-sweep.md)
own `test` with a `budget` fixture beside it. A test that asks for `budget` marks
the phases of a job, the load and then each interaction, and every phase's
counts are held exactly to the ceilings committed beside the spec. A spec that
imports this `test` is swept as well, since it is the sweep's `test` extended.

```ts
import { test } from "@gokayo43/dev-config/count-budget";

test("the tier list sorts", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/champions"));
  await budget.phase("sort", () => page.getByRole("button", { name: "Win %" }).click());
});
```

It counts and never times. A stopwatch on a shared CI box measures the
box. A count of the work the page did is the same on every run of the same page,
and it moves when the page does more work. The five counts were chosen because a
measurement on the fleet's serving box (dev-config#142) found them identical over
20 to 25 runs, quiet and with every core loaded. Style recalculations, layout
count, layout shifts, long tasks, transferred bytes and heap size varied between
identical runs, so they are not offered.

## Marking phases

`budget.phase(name, action)` waits for the page to go still, runs `action`, waits
for the page to go still again, and records what the page did between the two.
It answers whatever `action` answered. A phase's counts are that phase's alone:
whatever the load was still doing when `goto` resolved finishes inside the load,
and none of it reaches the first interaction. A phase that navigates is charged
with what the page it left did, as well as with the page it arrived on.

Anything a test does outside a phase is not counted, and the wait at the start of
the next phase keeps its tail out of that phase too. Each name is used once per
test. A test that asks for `budget` and marks no phase fails.

**Still** means two idle rounds in a row in which nothing moved. A round is one
`requestIdleCallback` followed by a frame. Nothing moved means no React commit,
no mutation record and no request started or finished, with no request in flight.
A round whose idle callback had to be forced after 100ms found the page busy, and
counts as one in which it moved. Network idle is not still: under load, a page's
hydration can run on well past the last response.

The fixture emulates `prefers-reduced-motion: reduce` on the test's page, because
an animation driven from script never lets a page go still. A page that animates
under reduced motion anyway is refused, as below.

## The counts

| Count             | What it counts                                                                     | What it is blind to                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reactCommits`    | commits React made, through the DevTools global hook's `onCommitFiberRoot`         | how many components a commit rendered; work outside React; React in an iframe                                                                                                    |
| `mutationRecords` | records a `MutationObserver` on the document delivered: nodes, attributes and text | how much one record changed (one `append` of a fragment of a thousand rows is one record); work that changes no DOM, such as layout, canvas or computation; an iframe's document |
| `requests`        | requests the page made, every frame's, stubbed ones included                       | their size, their timing and what they were for                                                                                                                                  |
| `bodyBytes`       | decoded body bytes of every response, stubbed ones included                        | compression, since the bytes are counted after decoding; headers; a WebSocket                                                                                                    |
| `scriptBytes`     | the share of `bodyBytes` whose request was a script                                | inline scripts, which are part of their document's bytes                                                                                                                         |

`reactCommits` needs a production React that loads after the fixture's init
script, which every page script does. A phase in which no React renderer ran
reports **no** commit count rather than zero, so a ceiling of zero commits is
always a measurement of a React page and never the absence of one.

Body bytes are read from the body itself. Chromium's own encoded size counts a
chunked response's framing, which follows how the server happened to split its
writes, and it misreports a body a route fulfilled. A redirect has no body and
counts none.

## The ceilings file

A spec's ceilings live beside it, named after it: `e2e/tier-list.spec.ts` has
`e2e/tier-list.spec.counts.json`. One entry per test, keyed by the test's titles
below the file joined with `›`, with the project in brackets in front when the
project has a name (`[mobile] › the tier list sorts`).

```json
{
  "the tier list sorts": {
    "browser": "chromium 151.0.7922.34",
    "phases": {
      "load": {
        "reactCommits": 7,
        "mutationRecords": 5407,
        "requests": 80,
        "bodyBytes": 3436864,
        "scriptBytes": 859890
      },
      "sort": {
        "reactCommits": 3,
        "mutationRecords": {
          "ceiling": 40,
          "was": 32,
          "reason": "the sort now animates its arrow"
        },
        "requests": 0,
        "bodyBytes": 0,
        "scriptBytes": 0
      }
    },
    "seal": "4c1f0e2a9b7d3e61"
  }
}
```

A count passes only when it equals its ceiling. One above fails, naming the
test, the phase, the count, the ceiling and what was measured. One below fails
too, and says to lower the ceiling with the command, so a ceiling never drifts
above what the page does. Nothing is averaged, retried or given a tolerance: one
run, compared exactly. A test that Playwright retries is refused on the retry, so
set `test.describe.configure({ retries: 0 })` on a spec that budgets.

## The command

```sh
COUNT_BUDGET=write bunx playwright test e2e/tier-list.spec.ts
```

It runs the tests and, instead of checking each one, writes its entry. A test
with no entry is written as measured. Every count that came in below its ceiling
is lowered to what was measured. A count above its ceiling keeps the ceiling and
fails the test, because the command never raises a number. A phase the test no
longer marks, and a commit count on a page that is no longer React, are dropped.
The entry records the browser it ran on and a fresh seal. Commit the file.

Any other value of `COUNT_BUDGET` stops the run before a test starts. Unset or
blank means check.

Because a phase or a test is keyed by its name, renaming one starts it with a
fresh ceiling at whatever it measures. The rename is in the diff, where a
reviewer sees it.

## Raising a ceiling

Raising is a hand edit, with a reason. Replace the number with what the page now
does, keep the number the command wrote as `was`, and say why:

```json
"mutationRecords": { "ceiling": 40, "was": 32, "reason": "the sort now animates its arrow" }
```

A failing test prints that object for the count it failed on. `ceiling` has to be
above `was`, and `reason` cannot be blank. The `seal` covers every number the
command wrote, a raised count's `was` included, so a number edited in place
without this form fails the test as edited by hand. The seal is a hash and not a
secret: it catches a raise nobody explained, not someone set on hiding one.

The command keeps a raised ceiling while the page meets it, and lowers it to a
plain number once the page does less.

## When a count is refused

A count is only worth comparing when it is repeatable, so the fixture refuses a
test, recording nothing, when one of these preconditions does not hold.

- **A request reached an origin the test neither serves nor stubs.** Responses
  from outside land when they land, and React commits once or twice depending on
  how close together they arrive. The test serves its `baseURL`'s origin, and any
  origin named in the `servedOrigins` option:

  ```ts
  test.use({ servedOrigins: ["http://127.0.0.1:8787"] });
  ```

  Every other request has to be answered by `route.fulfill`, with a captured
  payload. An aborted request is refused too, since it changes what the page
  does. A `data:` or `blob:` URL is the page's own and needs nothing.

- **The page never went still** in 100 idle rounds. The refusal names what kept
  moving and any request still in flight. A script animation that ignores
  reduced motion, a timer that keeps mutating the DOM and a request that never
  finishes are the usual causes.

- **The ceilings were measured on another browser build.** Each entry records
  the browser that measured it, and a count is only comparable on that build. A
  Playwright upgrade refuses every budgeted test until the command is run, which
  records the new build and lowers what dropped. A count that rose on the new
  build keeps its ceiling and fails until it is raised by hand with a reason.

## What it does not see

- **Pages other than the test's own `page`.** A popup, or a page from
  `context.newPage()`, is neither counted nor emulated. The sweep still sweeps
  it.
- **Iframes.** Their requests count, and their DOM and React do not.
- **Work on a timer slower than two idle rounds.** A page that mutates the DOM a
  second after it went still has gone still in between, and the mutation lands in
  whatever phase is running then, or in none, depending on how long the phases
  around it took. Such a count can differ from one run to the next.
- **Time.** A change that makes the same work slower moves no count.
- **Other browsers' counts.** The measurement behind this ran on Chromium 151
  only. That the counts hold over a longer horizon against a live API, and on
  another engine, is not shown.
