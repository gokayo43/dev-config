# The mutation lane

Coverage says a line ran. It cannot say the suite would have noticed had the
line been wrong, and a test that executes a branch while asserting nothing about
it counts exactly as much as one that pins it. The mutation lane asks the other
question: change the code, and see whether anything fails.

StrykerJS does the changing, through `@hughescr/stryker-bun-runner` — the stock
runner does not speak `bun test`. Both are the repo's own devDependencies rather
than something this action fetches, so their versions are the ones its lockfile
pins, under the same release-age window as everything else it installs. A repo
that turns the lane on without them is told to add them by name.

## Selective, because the alternative is not affordable

A full campaign over a domain layer is minutes to hours: every mutant is a run
of the tests that cover it. A gate that costs that runs nightly, or it runs
never. So what a pull request is held to is the code in the pull request:

- the files it changed, against the base ref — the merge base with the branch it
  targets, or the tip a push had before, the same resolution [the upgrade
  gate](upgrade-path.md) and the repo contract use;
- of those, the ones under the repo's **pure domain**;
- of the mutants in those files, the undetected ones sitting on lines this
  branch wrote.

Nothing changed under the domain is a pass that says so. Everything else about
the branch — the routes, the server, the components — is outside the lane
entirely, and deliberately: a mutant of code that talks to a database is a
statement about the fake behind it.

## Where the domain is

From `.oxlintrc.json`, as the `boundaries/elements` entry the layer rule already
reads:

```json
{ "type": "domain", "pattern": "src/domain" }
```

One declaration per repo rather than two. A gate input naming the same folders
would be a second place to write down what is pure, and the day the two
disagreed the linter and this lane would be enforcing different layers. A
monorepo declares one element per project — the `pattern` takes a glob, so
`apps/*/src/domain` is one entry — and a repo that declares no domain element is
told to write one instead of being quietly excused.

Under those folders the lane mutates `.ts`, `.tsx`, `.mts` and `.cts`, and never
a `.d.ts` or a `*.test.*` / `*.spec.*` file.

## Which mutants fail the branch

A mutant fails the branch when **every line it spans** is a line this branch
wrote. Containment rather than overlap, and the difference is not a detail: a
one-line edit inside an existing function sits inside a mutant of the whole
enclosing block, and failing on that one would fail the branch for code it did
not write. The block belongs to whoever wrote the block.

Two statuses count as undetected, and they ask for different things:

| Status       | What it means                     | The diagnostic asks for              |
| ------------ | --------------------------------- | ------------------------------------ |
| `Survived`   | tests ran the line and all passed | a case that fails on the replacement |
| `NoCoverage` | no test reached the line at all   | a test that reaches it               |

`Killed` and `Timeout` are caught. A mutant that would not compile, or that the
config ignored, is neither caught nor missed: it is outside the ratio rather
than a zero in it — Stryker's own definition of the score, kept rather than
reinvented.

## The score, and the floor

The mutation score over the files the branch touched goes to the run summary
every time, passing or failing, with the undetected mutants on the branch's own
lines listed under it.

`mutation-floor` is what turns that number into a bound, and it is empty by
default — publish only. It is written as a fraction between 0 and 1, the way
`bunfig.toml` writes `coverageThreshold`, and anything else is refused rather
than guessed at. What it means is what the coverage floor means, and the
paragraph in README's "Tests and coverage" is the whole argument: **a floor, not
a target.** It sits at or below what the repo's domain already scores, it is
raised only after the tests are there, and a floor above current reality is a
red CI run that teaches everyone to ignore red CI runs.

The floor and the containment rule cover each other. Containment lets a mutant
past when a branch edits one line of a block it did not write; the floor is
still measured over every mutant in every file the branch touched, so a file
whose score is falling says so whoever wrote the lines.

## Turning it on

```yaml
with:
  mutation-lane: true
  mutation-floor: "0.7"
```

`mutation-floor` without `mutation-lane: true` fails the run rather than being
ignored, for the reason the database inputs do: a bound nobody notices is off is
a bound nobody has.

## What it cannot see

- **A domain that is not declared as a layer.** The lane reads one key of one
  file. A repo whose pure code lives somewhere the boundaries matrix does not
  name gets no lane until it says so — which is the correct order, since the
  linter is not enforcing that layer either.
- **A change whose mutants all sit in a block it did not write.** Containment is
  a choice about who is answerable, not a claim that those mutants are fine. The
  floor is what still counts them.
- **A suite that passes for the wrong reason.** A mutant is killed by any
  failing test, including one that fails for an unrelated reason. Mutation
  testing grades the suite's sensitivity, not its correctness.
- **Anything outside the domain.** By construction, and see above.
