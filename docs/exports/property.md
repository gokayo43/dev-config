# The property budget

`@gokayo43/dev-config/property.ts` exports `check`, which is `fc.assert` with
one thing added: the run decides how far every property searches.

```ts
import { check } from "@gokayo43/dev-config/property.ts";
import { integer, property } from "fast-check";

test("a total is never less than its largest part", () => {
  check(
    property(integer({ min: 0 }), integer({ min: 0 }), (a, b) => {
      expect(total(a, b)).toBeGreaterThanOrEqual(Math.max(a, b));
    }),
  );
});
```

Adopting it is a change of import. The signature is `fc.assert`'s, all three
overloads of it, so an async property still hands back the promise the case has
to await — a wrapper answering `void` there would let a case finish before its
property had run, and the failure would arrive as a bare assertion error with no
counterexample and no seed to replay it with.

`fast-check` is an optional peer dependency: the repo brings its own, at the
version its lockfile pins.

## Why the dial is not in the test

How many inputs a property is run over is the whole of what it is worth. A
property at 100 runs and the same property at 5 000 are two different searches,
and the second is the one that finds the case nobody thought of. Written per
test, that number is one nobody can move: measured across the fleet on
2026-09-13, the properties that exist run anywhere between 12 and 20 000 runs,
each decided by whoever wrote the file, and not one of them reachable from
outside it.

So the dial is in the one call they all go through. A developer waits for the
small search; [the nightly](../../README.md#the-nightly-run) gets the large one
by setting two variables, and no test changes.

| Variable                 | Effect                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROPERTY_RUNS_FACTOR`   | Multiplies the effective `numRuns` — the caller's, else the repo's `configureGlobal`, else fast-check's own default. A whole number, one or more. Unset is 1. |
| `PROPERTY_TIME_LIMIT_MS` | How long one property may spend generating before fast-check stops and takes what it has (`interruptAfterTimeLimit`). Unset is no bound.                      |

Both are refused rather than defaulted when they hold something that is not a
whole number: a factor of `fifty` read as "no factor" is a nightly that quietly
ran the developer's search all night and reported it as the long one.

**A budget is not a bar to clear.** A property the time limit stops is a pass —
on however many runs it managed, and on none at all. The long budget can only
ever find more; it cannot fail a suite for being slow on a loaded box.

Holding that takes more than `markInterruptAsFailure: false`, which covers only
a run interrupted _after_ at least one success: fast-check reads an interruption
with no completed run as a failure whatever that flag says
(`considerInterruptedAsFailure = interruptedAsFailure || numSuccesses === 0`,
4.9.0), so one async property whose single run outlasts two minutes would have
filed "Nightly is red" every night. So `check` runs `fc.check` and reads the
details: a real failure is rethrown with fast-check's own report, and that one
outcome — interrupted, nothing completed, under a limit this module set — is
announced on the log as a property the budget could not search and passes. With
no time limit set, the behaviour is `fc.assert`'s exactly.

The pair is what makes a large factor safe to set fleet-wide. The factor alone
turns one slow property into a job that never ends; together they say "as many
runs as fit in two minutes".

Everything else passes through untouched. A failure's seed, path and shrunk
counterexample are what reproduce it, and a wrapper standing between a failing
property and the line that replays it would be worth more than the dial it
added.

## The lint entry

`oxlint.base.json` refuses `assert` and the default export from `fast-check`:

```
Import `check` from @gokayo43/dev-config/property.ts — it multiplies every
property's run count by PROPERTY_RUNS_FACTOR, which is what lets one run search
a hundred times as far as another. The default export is refused with it because
`fc.assert` reaches the same call: import the generators by name.
```

The default export is on the list because `import fc from "fast-check"` is how
the fleet writes it, and `fc.assert` reaches the call without ever naming it —
an entry listing only `assert` would have been a ban on one file in thirteen.
The generators are untouched and come in by name; only the call is refused.

`fast-check` also exports its own `check`, which runs a property and answers
details instead of throwing. This is not that one: this is `assert`, budgeted.
