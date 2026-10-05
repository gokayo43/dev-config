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

const unpreempted = { strategy: "walk", preemptAt: [], picks: [] } as const;

test("two bookings of the last seat sell it once", () => {
  check(
    property(interleavings(simulate(bookTwice, unpreempted).ops), (interleaving) => {
      expect(simulate(bookTwice, interleaving)).toMatchObject({
        parked: false,
        exit: Exit.succeed(1),
      });
    }),
    { numRuns: 1_000 },
  );
});
```

- `interleavings(ops)` is the fast-check arbitrary of schedules for a program
  whose run takes `ops` ops when nothing preempts it, which is what `unpreempted`
  above measures. Sizing it, and `numRuns`, is below. Its values are plain
  data, so fast-check prints them in a counterexample and shrinks them like any
  other value, and a test can write one by hand.
- `simulate(program, interleaving)` runs the program until no fiber can run,
  synchronously, and answers `{ parked: false, exit, ops }` for a run that
  finished, or `{ parked: true, ops }` for a run in which every fiber was
  waiting with the program unfinished. A deadlock is a parked run. `ops` is how
  many ops the run executed.
- Before it answers, `simulate` interrupts every fiber of the run still
  unfinished, daemons included, and lets them wind down, so finalizers run and
  nothing of the run outlives the call.
- `simulate` throws when the run does not finish within 100 000 ops, and when a
  fiber does not finish once interrupted. A program that needs more ops passes
  `{ maxOps }` as a third argument.

The program is built fresh for each run: state the fibers share is created
inside the effect, as `makeSeats` does above, never outside it. `effect` is an
optional peer dependency, 3.22 or later below 4, and the repo brings its own
beside `fast-check`. Effect 4.0.0, published on 2026-10-01, is outside that
range: a repo on Effect 4 does not have this export.

## How it works

Effect's runtime asks its `Scheduler` before every op of every fiber whether
the fiber should yield there, and every resumed, forked or yielded fiber is a
task handed to that same scheduler. `simulate` installs one whose every answer
comes from the interleaving: it says before each op whether to preempt, and it
picks which queued fiber runs next. Nothing else decides the order: no timer,
no microtask, no clock and no `Math.random`. The same program under the same
interleaving executes the same order every time. Like Effect's own scheduler,
it also yields a fiber that has run `FiberRef.currentMaxOpsBeforeYield` ops in
one go, 2 048 unless the program sets it, so a fiber that busy-polls for another
still lets it run.

A preemption can fall between any two ops of a fiber, including two synchronous
ones with nothing between them a test could wrap, and inside an
`Effect.uninterruptible` region, which stops interruption but not scheduling.
That is the reach fast-check's own `fc.scheduler` lacks: it reorders only at the
promises a test wraps, and in the prototype this export came from
(dev-config#140) it found none of the four subtle bugs planted there.

Everything rests on the runtime asking before every op. The first `simulate` in
a process checks that the installed Effect does, by running a small program and
looking for a fiber that ran between two synchronous ops of another, and throws
if it finds none. So a repo whose Effect stopped asking fails its race
properties loudly instead of passing them by finding nothing.

The arbitrary mixes two strategies, because the prototype needed both to find
its races:

- a random walk, which preempts at generated op indices and then picks the next
  fiber from generated choices. A pick is an index taken modulo the queue's
  length and at most 7, so it reaches the first eight queued fibers; with more
  queued than that, the rest run only as the queue moves.
- a priority strategy, PCT (Burckhardt et al., ASPLOS 2010), which gives each
  fiber a generated priority, always runs the highest, and drops a fiber below
  every other when it yields and at up to three generated op indices. Up to 24
  priorities are generated, so fibers the run meets after the 24th all get 0.

## What a program may contain

Only its own fibers. A fiber waiting on anything outside the program waits on
something no interleaving controls, so at the end of the run it looks parked,
and the property reads a deadlock that is not there. A real timer waits that
way: `Effect.sleep`, and the timer behind a timeout, which never fires inside a
run. So does real I/O: a database driver and `fetch`. So does every promise,
including one that is already resolved, because a promise settles on a
microtask and the run has ended by then. An in-memory fake written as an `async`
function parks the run just as a real call would. Put each behind a service the
test replaces with an in-memory one written in Effect, completing through a
`Deferred` or a `Ref`.

Whatever such a fiber was waiting on is let go when the run winds down: the
wait is interrupted, so a timer is cleared, and a promise that settles later
wakes nothing. A wait inside an uninterruptible region cannot be let go, and
`simulate` throws.

## Sizing `ops` and the run count

`ops` decides where the generated preemptions fall: the walk's preemption points
and the priority strategy's change points are drawn below it. Size it to the
program's run under the interleaving that preempts nothing, as the example
does with `simulate(bookTwice, unpreempted).ops`. Most runs under a generated
interleaving are longer, since every preemption adds the ops of a yield, though
a different order can also take a shorter path through the code. When the program
is built from generated operations, size `ops` from the largest program the
generator produces, and generate both:

```ts
check(
  property(operations, interleavings(400), (steps, interleaving) => {
    expect(simulate(scenario(steps), interleaving)).toMatchObject({ parked: false });
  }),
  { numRuns: 700 },
);
```

The run count goes through [`check`](property.md), like every other property,
so the nightly multiplies whatever the property states. What the property states
is its own `numRuns`, sized from the share of generated interleavings that fail
against the racy version, `p`: at least `ln(10⁶) / p`, about 13.8 / p, which
misses the race in fewer than one search in a million. Measure `p` by running
the property against the racy version over many runs on one seed, counting the
failing runs rather than stopping at the first. The narrowest window in the
prototype needed about 700 runs to be found.

This repo's own fixtures, each sized by the rule above, measured as follows. The
share is the failing runs among 20 000 on seed 1. The runs to find are the
`numRuns` at which `fc.check` with `endOnFailure` failed, on each of seeds 1 to
20, capped at 3 000; every seed found the race.

| Fixture                                   | `ops` | Strategy | Share failing | Median runs to find | Slowest of 20 seeds |
| ----------------------------------------- | ----- | -------- | ------------- | ------------------- | ------------------- |
| a check-then-act across a yield           | 77    | walk     | 37.2%         | 2                   | 8                   |
|                                           |       | priority | 31.7%         | 3                   | 16                  |
|                                           |       | mixed    | 34.4%         | 2.5                 | 18                  |
| a lost update between two synchronous ops | 184   | walk     | 3.3%          | 22                  | 129                 |
|                                           |       | priority | 0.96%         | 64.5                | 460                 |
|                                           |       | mixed    | 2.2%          | 23                  | 236                 |

The suite searches each with the mixed arbitrary, over 1 000 runs.

## Turning a race the search found into a regression case

Do not pin the seed or the interleaving a failure printed. Both are decisions
about op indices and queue positions. A change to the code's shape moves those,
and the pinned schedule then runs some other order, which passes without
testing anything.

The regression case is the fixed operations from the counterexample, run under
a sweep of schedules the test writes by hand: one preemption at each op of the
unpreempted run, in turn. Each run asserts the invariant. Across the sweep, the
case asserts that at least one run reached the window the race lives in, stated
as both operations being in flight at once, not as the losing order. A correct
fix keeps that window reachable: the second booking waits on the lock while the
first holds it. A fix that removes the losing order does not remove it.

```ts
test("the last seat is sold once, with both bookings in flight at once", () => {
  let overlapped = 0;
  for (let op = 0; op < simulate(bookTwice, unpreempted).ops; op++) {
    const run = simulate(bookTwice, { strategy: "walk", preemptAt: [op], picks: [] });
    if (run.parked || Exit.isFailure(run.exit))
      throw new Error(`the run did not finish (op ${op})`);
    expect(run.exit.value.sold).toBe(1);
    if (run.exit.value.overlapped) overlapped += 1;
  }
  expect(overlapped).toBeGreaterThan(0);
});
```

Here `bookTwice` answers how many bookings sold the seat and whether both were
ever in flight at once, which the program records as it runs. The sweep is
deterministic and covers every preemption point of the code as it stands, so a
change to the code's shape moves the sweep with it. While the bug is there, a
shape one op longer or shorter still fails the case. Once fixed, the window
stays reached. If a change puts the window out of reach of one preemption, the
reached assertion fails the case. This repo's suite holds this recipe on its
booking fixture as written and one op longer and shorter.

## Reading a counterexample

This applies to a program built from generated operations. The op indices in an
interleaving count every op the run executes, across all its fibers. When
fast-check shrinks the operations, removing one shifts the index of every op
after it, so the same interleaving no longer preempts at the same place and the
race disappears. Shrinking therefore keeps operations that do not take part in
the race. Expect a counterexample with more operations than the race needs, and
read the program's log to see which of them matter.
