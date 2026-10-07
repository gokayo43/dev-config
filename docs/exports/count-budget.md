# The count budget

`@gokayo43/dev-config/count-budget` exports `test`, which is
[the invariant sweep's](invariant-sweep.md) own `test` with a `budget` fixture
beside it. A test that asks for `budget` marks the phases of a job, the load and
then each interaction, and every phase's counts are held exactly to the ceilings
committed beside the spec. A spec that imports this `test` is swept as well,
since it is the sweep's `test` extended.

```ts
import { test } from "@gokayo43/dev-config/count-budget";

test.describe.configure({ retries: 0 });

test("the tier list sorts", async ({ page, budget }) => {
  await budget.phase("load", () => page.goto("/champions"));
  await budget.phase("sort", () => page.getByRole("button", { name: "Win %" }).click());
});
```

It counts and never times. A stopwatch on a shared CI box measures the box. The
five counts below were identical over 20 to 25 runs of one page, quiet and with
every core loaded, in the measurement this export is built from (dev-config#142),
and they are identical over 20 runs of each kind on this package's own fixture
page. That holds for a page whose work does not depend on timing. A page that
does work on a slow timer, or runs a script animation for as long as it takes
to finish, can give a different count from one run to the next, and nothing
refuses it except the next run failing. Style recalculations, layout count,
layout shifts, long tasks, transferred bytes and heap size varied between
identical runs in the measurement, so they are not offered.

The measurement also found four more counts steady that are not offered. DOM
nodes, layout objects and event listeners after a forced garbage collection
were read through Chromium's DevTools protocol (`Performance.getMetrics` after
`HeapProfiler.collectGarbage`), and this export opens no DevTools session: it
reads the page through a script of its own and Playwright's events. Offering
them would take a session on Chromium alone. Document bytes are already inside
`bodyBytes`, since a document is a response like any other.

## Marking phases

`budget.phase(name, action)` waits for the page to go still, runs `action`, waits
for the page to go still again, and records what the page did between the two.
It answers whatever `action` answered. Whatever the load was still doing when
`goto` resolved finishes inside the load, because the phase ends only once the
page is still, so it does not reach the first interaction. Work on a timer
slower than that is the exception, under "What it does not see". A phase that
navigates is charged with what the page it left did, as well as with the page
it arrived on.

Anything a test does outside a phase is not counted, and the wait at the start of
the next phase keeps its tail out of that phase too.

A phase name is used once per test: a second phase of the same name fails the
test. A phase that throws, a refusal included, fails the test even when the test
catches the error and goes on, because the counts would then describe a job
that did not happen. A test that asks for `budget` and marks no phase fails.

**Still** means two idle rounds in a row in which nothing moved. A round is one
`requestIdleCallback` followed by an animation frame. Nothing moved means no
React commit, no mutation record and no request started or finished, with no
request in flight, a service worker's own fetches included. A round whose idle
callback had to be forced after 100ms found the page busy, and counts as one in
which it moved. Network idle is not still: under load, a page's hydration can
run on well past the last response.

The fixture emulates `prefers-reduced-motion: reduce` on the test's page, because
an animation driven from script that runs forever never lets a page go still. A
page that animates forever under reduced motion anyway is refused, as below. One
that animates for a while and stops is not refused: it goes still once it stops,
and its mutation count follows how many animation frames it ran, which follows
how busy the box was.

## The counts

| Count             | What it counts                                                                     | What it is blind to                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reactCommits`    | commits React made, through the DevTools global hook's `onCommitFiberRoot`         | how many components a commit rendered; work outside React; React in an iframe                                                                                                                                   |
| `mutationRecords` | records a `MutationObserver` on the document delivered: nodes, attributes and text | how much one record changed (one `append` of a fragment of a thousand rows is one record); work that changes no DOM, such as layout, canvas or computation; anything inside a shadow root; an iframe's document |
| `requests`        | requests the page made, its iframes' included, and stubbed ones                    | their size, their timing and what they were for; a service worker's own fetches, which are waited for but not counted; a WebSocket; a beacon sent from `pagehide`                                               |
| `bodyBytes`       | decoded body bytes of every response, stubbed ones included                        | compression, since the bytes are counted after decoding; headers; a WebSocket's messages; a service worker's own fetches                                                                                        |
| `scriptBytes`     | the share of `bodyBytes` whose request was a script                                | inline scripts, which are part of their document's bytes                                                                                                                                                        |

`reactCommits` is read from the DevTools hook the fixture installs before any
page script runs. A development build of React reports its commits to the hook
too, but they are not the production build's commits, so budget the build you
ship. The `Counts` type states when the count is there, and this is its rule:
present exactly when the phase ran in a document holding a React renderer, the
one current when it began, the one current when it ended, or one that attached
a renderer while it ran; absent, never zero, otherwise. A ceiling of zero
commits is therefore always a measurement of a React page and never the absence
of one. A page that writes to the hook is refused: setting its `isDisabled`,
overwriting its properties as the common "disable React DevTools" snippet does,
or putting another object in its place. React reports nothing to a hook it
cannot use, and the page would read as one with no React.

Body bytes are read from the body itself. Chromium's own encoded size counts a
chunked response's framing, which follows how the server happened to split its
writes, and it misreports a body a route fulfilled. A redirect, a `204`, a
`205` and the answer to a `HEAD` have no body and count none.

A request a page sends as it leaves, a `keepalive` fetch or a `sendBeacon` from
the click that navigates, is counted when it is sent and not waited for once the
next document has replaced the one that sent it: Playwright reports no end for
it, and no document is left for its answer to change. For the same reason the
origin rule below does not hold it.

Each budgeted test carries its counts as the `count-budget` attachment in
Playwright's report: a JSON object of phases, each a `Counts` as the package
exports the type.

## The ceilings file

A spec's ceilings live beside it, named after it: `e2e/tier-list.spec.ts` has
`e2e/tier-list.spec.counts.json`. There is one entry per test, keyed by the
test's titles below the file joined with `›` (a space either side), with the
project in brackets in front when the project has a name
(`[mobile] › the tier list sorts`). The file lists its tests in code-point
order.

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
          "reason": "the sort now shows a count per column"
        },
        "requests": 0,
        "bodyBytes": 0,
        "scriptBytes": 0
      }
    },
    "seal": "1f0c9e2a…"
  }
}
```

## The check

Without `COUNT_BUDGET`, the fixture compares what the test measured with the
test's entry, after the test has passed. A test that failed or was skipped is
not compared, and nothing is recorded for it. The check fails, naming the test,
the file and every difference, in each of these cases:

- **no file, or no entry for the test**: run the command and commit the file;
- **a phase the entry has no ceilings for**, or **an entry phase the test no
  longer marks**: run the command, which adds or drops it;
- **a count above its ceiling**: the message names the phase, the count, the
  ceiling and what was measured, and prints the raise to write if the extra work
  is meant;
- **a count below its ceiling**: run the command, which lowers it, so a ceiling
  never drifts above what the page does;
- **`reactCommits` on one side only**: a ceiling for commits on a phase that by
  the rule under "The counts" has no commit count, or commits in a phase whose
  entry has none; the command drops or adds it;
- **the entry was measured on another browser build**: each entry records the
  browser that measured it, and a count is only comparable on that build, so
  this is the one difference the check names, whatever the counts did. After a
  Playwright upgrade every budgeted test fails this way until the command is
  run on a person's machine;
- **a raise the command has not kept yet**, under "Raising a ceiling".

A count passes only when it equals its ceiling. Nothing is averaged, retried or
given a tolerance: one run, compared exactly. The check and the command share
one rule: the check fails exactly when the command would write the entry
differently, or would keep a ceiling the page is above.

## The command

```sh
COUNT_BUDGET=write bunx playwright test e2e/tier-list.spec.ts
```

It runs the tests and writes each passing test's entry instead of failing it on
a difference. A test with no entry, and a phase or a count with no ceiling, is
written as measured. Every count below its ceiling is lowered to the measure. A
phase the test no longer marks, and a commit count on a phase that no longer
has one, are dropped. A count **above** its ceiling keeps the ceiling, and the
test still fails, because the command never raises a number; a person raises
one, under "Raising a ceiling". The entry records the browser it ran on and a
fresh seal. Commit the file.

The browser is recorded as Playwright's browser name and version, such as
`chromium 151.0.7922.34`. It does not tell Chromium's headless shell from a
headed Chromium of the same version, and it does not record the operating
system the command ran on, so a file written on one and checked on the other
compares counts across a difference the key does not show.

The command is for a person's machine. It refuses to run when `CI` is set: a CI
workspace throws the file away, and a write skips the two things a CI check is
for, a count below its ceiling and a file measured on another browser build. Any
value of `COUNT_BUDGET` other than `write` stops the run before a test starts.
Unset or blank means check.

Workers running tests of one spec in parallel take turns at the file through a
lock, `<spec>.counts.json.lock`, which names the process holding it, and each
writes the file whole as `<spec>.counts.json.<pid>.writing` before moving it
into place. A lock whose process is gone, left by a worker that was killed
while writing, is taken over. Whoever next takes the lock removes what killed
workers left beside it: a staging file, and the files under
`<spec>.counts.json.lock.` that name a process that is gone. A lock held by a
live process for 10 seconds fails the test with a message naming the lock and
the process. The lock proves a holder alive from `/proc`, so the command runs
on Linux only.

## Raising a ceiling

The command never raises a ceiling. Raising is a hand edit, with a reason, and
then the command, which keeps the raise. Replace the number with what the page
now does, keep the number that was there as `was`, and say why:

```json
"mutationRecords": { "ceiling": 40, "was": 32, "reason": "the sort now shows a count per column" }
```

A failing test prints that object for the count it failed on. `ceiling` has to be
above `was`, and `reason` cannot be blank. Then run the command, which keeps the
raise and seals it, and commit the file. Until the command has kept it, the
check fails with a message saying so.

## What the seal guards

The seal is one digest per count of the ceiling the command last accepted: a
plain number as the command wrote it, and a raise once the command has kept it.
It guards the entry it sits in. Both the check and the command refuse an entry
that differs from its seal in any way other than a fresh raise in the form
above:

- a number edited in place, up or down;
- a kept raise whose `ceiling` was moved again in place, which has to be a new
  raise with the kept ceiling as its `was`;
- a count or a phase removed from the entry, or added to it by hand. A phase
  missing one of the four counts every phase has is refused before the seal is
  read, naming the count.

The seal does **not** guard:

- **an entry deleted or renamed**: deleting a test's entry and running the
  command writes whatever the page now measures, with no reason, and renaming a
  test or a phase does the same through a new key. The old entry is never
  removed by the command, because a run of some of a spec's tests cannot tell a
  test that was renamed from one that was not run; remove it by hand. Only the
  file's diff in review shows either. Anchoring the check to the file as the
  base ref holds it would close this: dev-config#146;
- **someone set on hiding a raise**: it is a hash, not a secret, so anyone can
  compute a seal. It catches a raise nobody explained, by accident or in a hurry.

## When a test is refused

A count is only worth comparing when it is repeatable and the entry is one the
command accepted, so the fixture refuses a test in each case below. A refused
test **fails**, with a message saying what to do, and nothing is recorded for
it, in check and command alike.

- **A request reached an origin the test neither serves nor stubs.** Responses
  from somewhere the test does not control land when they land, and React
  commits once or twice depending on how close together they arrive. A response
  from the test's own server is no different in that, but the test controls the
  server, and the measurement found its counts steady. The test serves its
  `baseURL`'s origin, and any origin named in the `servedOrigins` option, each
  read as a URL, so a trailing path is fine:

  ```ts
  test.use({ servedOrigins: ["http://127.0.0.1:8787"] });
  ```

  Every other request has to be answered by `route.fulfill`, and every other
  WebSocket by `page.routeWebSocket`, each with a captured payload. A service
  worker's own fetches are held to the same rule, and the phase waits for them.
  A `data:` or `blob:` URL is the page's own and needs nothing.

- **A request to an origin the test does not serve ended with no answer.** The
  page aborted it, a route aborted it, or the connection failed, and nothing
  observable tells those apart; each changes what the page does next. A stub
  that answers only after the page gave up is this case too. Answer it with a
  stub that arrives before the page gives up, or change the page so it does not
  issue the request.

- **A response's body could not be read**, so its bytes cannot be counted. The
  message names the request and what Playwright said.

- **The page never went still** in 100 idle rounds. The refusal names what kept
  moving and any request still in flight. A script animation that runs forever
  and ignores reduced motion, a timer that keeps mutating the DOM and a request
  that never finishes are the usual causes.

- **React's DevTools hook was written to**, as under "The counts".

- **The entry was edited by hand**, as under "What the seal guards".

- **The test is a retry.** A retry would pass a count that differs from one run
  to the next, which is what a budget exists to catch, so a budgeted test fails
  on its retry. Set `test.describe.configure({ retries: 0 })` on a spec that
  budgets.

## What it does not see

- **Pages other than the test's own `page`.** A popup, or a page from
  `context.newPage()`, is neither counted nor emulated. The sweep still sweeps
  it.
- **Iframes and shadow roots.** An iframe's requests count, and its DOM and React
  do not. A mutation inside a shadow root is not a record the document's
  observer sees.
- **A socket a route connected through.** A WebSocket that `page.routeWebSocket`
  hands to `connectToServer` reaches its server without the page raising the
  event the origin rule reads.
- **A route that fetches the real response.** `route.fulfill({ response: await
route.fetch() })` answers the page with live data, and the page sees a
  fulfilled response, which is what a stub is. Playwright's own request to the
  origin is not one the page made.
- **Work on a timer slower than two idle rounds.** A page that mutates the DOM a
  second after it went still has gone still in between, and the mutation lands
  in whatever phase is running then, or in none, depending on how long the
  phases around it took.
- **Time.** A change that makes the same work slower moves no count.
- **Whether counts hold on another engine, or over time.** The measurement
  behind this ran on Chromium 151 only. Nothing here checks the engine: on
  Firefox or WebKit the fixture runs, records that browser in the entry, and
  holds the counts to ceilings measured on it, but nobody has shown those counts
  steady there. Playwright reports which service worker made a request on
  Chromium only, so on another engine a service worker's own fetches are not
  seen at all. That the counts hold over a longer horizon against a live API is
  not shown either.
