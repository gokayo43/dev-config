# Generated interleavings

`@gokayo43/dev-config/interleaving` lets a property test in an Effect codebase
generate the order in which overlapping fibers' steps run. A race nobody wrote
a case for is found by the search, and the seed fast-check prints replays it.

```ts
import { interleavings, simulate } from "@gokayo43/dev-config/interleaving";
import { check } from "@gokayo43/dev-config/property";
import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { property } from "fast-check";

import { makeSeats } from "../src/seats.ts";

const bookTwice = Effect.gen(function* () {
  const seats = yield* makeSeats(1);
  const first = yield* Effect.fork(seats.book);
  const second = yield* Effect.fork(seats.book);
  return [yield* Fiber.join(first), yield* Fiber.join(second)].filter(Boolean).length;
});

test("two bookings of the last seat sell it once", () => {
  check(
    property(interleavings(64), (interleaving) => {
      expect(simulate(bookTwice, interleaving)).toMatchObject({
        parked: false,
        exit: Exit.succeed(1),
      });
    }),
  );
});
```

- `interleavings(ops)` is the fast-check arbitrary of schedules for a program
  whose runs take about `ops` ops. Its values are plain data, so fast-check
  prints them in a counterexample and shrinks them like any other value.
- `simulate(program, interleaving)` runs the program to the end, synchronously,
  and answers `{ parked: false, exit, ops }` for a run that finished, or
  `{ parked: true, ops }` for a run in which every fiber was waiting with the
  program unfinished. A deadlock is a parked run. `ops` is how many ops the run
  executed.
- `simulate` throws when a run executes 100 000 ops without finishing, which is
  a fiber that loops or yields forever, so the case fails rather than hangs.

The program is built fresh for each run: state the fibers share is created
inside the effect, as `makeSeats` does above, never outside it. `effect` is an
optional peer dependency, from 3.22 below 4, and the repo brings its own beside
`fast-check`.

## How it works

Effect's runtime asks its `Scheduler` before every op of every fiber whether
the fiber should yield there, and every resumed, forked or yielded fiber is a
task handed to that same scheduler. `simulate` installs one whose every answer
comes from the interleaving: it says before each op whether to preempt, and it
picks which queued fiber runs next. Nothing else decides the order: no timer,
no microtask, no clock and no `Math.random`. The same program under the same
interleaving executes the same order every time.

A preemption can fall between any two ops of a fiber, including two synchronous
ones with nothing between them a test could wrap, and inside an
`Effect.uninterruptible` region, which stops interruption but not scheduling.
That is the reach fast-check's own `fc.scheduler` lacks: it reorders only at the
promises a test wraps, and in the prototype this export came from it found none
of the four subtle bugs planted there.

The arbitrary mixes two strategies, because the prototype needed both:

- a random walk, which preempts at generated op indices and then picks the next
  fiber from generated choices;
- a priority strategy, PCT (Burckhardt et al., ASPLOS 2010), which gives each
  fiber a generated priority, always runs the highest, and at up to three
  generated op indices drops the running fiber below every other.

Everything rests on the runtime asking before every op. Effect 3.22 does. The
suite's canary fails if an Effect release stops asking, or asks only at yields
and forks.

## What a program may contain

Only its own fibers. A fiber waiting on a real timer or real I/O waits on
something no interleaving controls, so at the end of the run it looks parked,
and the property reads a deadlock that is not there. `Effect.sleep`,
`Effect.promise` over a real call, a database driver and `fetch` all wait that
way, and a timeout's timer never fires inside a run. Put each behind a service
the test replaces with an in-memory one that completes through a `Deferred` or
a `Ref`.

`Effect.never` holds a real `setInterval`. A run that parks on it leaves the
interval set, and the test process stays alive after the suite. Wait on a
`Deferred` nobody completes instead.

When something outside the program wakes a fiber after `simulate` returned, such
as a timer firing or a callback the test kept and called, `simulate`'s scheduler
throws from that call. Nothing of the program runs after `simulate` has answered.

## Sizing `ops` and the run count

`ops` decides where the generated preemptions fall: the walk's preemption points
and the priority strategy's change points are drawn below it. Size it to about
one run's length, which a single `simulate` answers as `ops`. The suite's
fixtures below, whose runs take 54 to 66 ops, failed in about the same share of
runs at 64, 128 and 400. Sized below the run, the walk never preempts the part
of it past `ops`.

The run count is the house's: the property goes through
[`check`](property.md), like every other property, so the nightly multiplies it.
Size the property's own `numRuns` from a measured kill rate, which is the share
of generated interleavings that expose the race. Measure it by running the
property against the racy version with `endOnFailure` over 20 seeds or more and
reading `numRuns` at each failure. A count where a miss stays improbable is
several times the slowest of those. The narrowest window in the prototype
needed about 700 runs. This repo's own fixtures measured as follows, at
`interleavings(64)` over seeds 1 to 20:

| Fixture                                   | Share of runs that fail | Median runs to find | Slowest of 20 seeds |
| ----------------------------------------- | ----------------------- | ------------------- | ------------------- |
| a check-then-act across a yield           | 14%                     | 5                   | 11                  |
| a lost update between two synchronous ops | 1.8%                    | 42                  | 416                 |

The suite searches each over 1 000 runs.

## Pinning a race that was found

Do not pin the seed or the interleaving a failure printed. Both are decisions
about op indices and queue positions, and any change to the code's shape moves
those, the fix included. After the fix, the pinned schedule no longer reaches
the race, so the pinned case passes whether the race is fixed or not.

The regression case is the fixed operations from the counterexample, run under
fresh interleavings every run, plus an assertion that the run reached the
interleaving the race needs. Reached means the program's own log of what
executed shows the steps overlapping, for example both bookings having read the
seat count before either wrote it. Count the runs that reached it and assert
that count is above zero, so a change that stops the search from reaching the
window fails the case instead of passing it vacuously.

## Reading a counterexample

The op indices in an interleaving count every op the run executes, across all
its fibers. When fast-check shrinks the program's operations, removing one
shifts the index of every op after it, so the same interleaving no longer
preempts at the same place and the race disappears. Shrinking therefore keeps
operations that do not take part in the race. Expect a counterexample with
more operations than the race needs, and read the program's log to see which
of them matter.
