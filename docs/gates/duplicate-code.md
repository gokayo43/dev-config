# Duplicate code

A pull request that pastes a block already in the repo, or pastes its own block
twice, passes every other gate here: the copy typechecks, lints and is covered
by the same tests as the original. Until this gate, a reviewer's eye was the
only thing that caught it. `duplicate-code` fails the run instead, and is
switched on with the `duplicate-code` input.

```
::error file=src/discounts.ts,line=2::move the 15 normalised lines src/discounts.ts:2-16 shares with src/prices.ts:3-17 into one place both call, or keep the copy with `// duplicate-code-allow -- <reason>` on line 2
```

## What a clone is

A run of at least **twelve normalised lines** in a file this branch changed, at
least one of which this branch wrote, that also appears anywhere else in the
repo's source: in another file, or elsewhere in the same file. Elsewhere means
the two ranges do not overlap, so a block whose lines repeat a short pattern,
such as rows of a table, is one block rather than a clone of itself.

A **normalised** line is a line with its comments removed and every run of
whitespace collapsed to one space, and a line left blank by that is dropped.
Re-indenting, reformatting or re-commenting a copy therefore does not hide it.
Renaming its identifiers does, and that is deliberate: two implementations of
one decision that share no lines are a judgement about intent, which stays with
review.

Each clone is reported once, extended both ways to the longest run the two
places share, with both places as `file:first-last` and the run's length. A
new copy of a block that already sits in two places is two refusals, one per
pair.

## Which files

Source is every file git tracks ending `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or
`.cjs`. Never a `.d.ts`, never anything under a `dist/` folder at any depth and
never anything under `node_modules`. A declaration file and a committed build
each hold a second copy of the code by design, and this repo commits its
`dist/`. Lockfiles and snapshots are outside by their extension.

Tracked, rather than every file git would keep as the other gates read: the
branch's side of a clone comes out of `git diff`, which never shows an
untracked file, so both sides are read from one population and a scratch copy
nobody committed is neither.

A symlink is not read. Its target is either another tracked file, read as
itself, or somewhere outside the checkout, which is not this repo's code.

## What "this branch" means

The same thing it means to [the mutation lane](mutation-lane.md), because both
read one diff, `.github/actions/_lib/change-set.ts`: the files the branch
changed against the base ref, which is the merge base with the branch a pull
request targets or the tip a push had before, and in each the lines it wrote.
The base ref has to be in the checkout, so the job checks out with
`fetch-depth: 0`, and a shallow checkout is refused rather than read as having
no history.

A clone that was already in the tree before the branch is not the branch's,
and passes. A pull request that changed no source file is a pass that says so.

The diff runs with git's rename detection at its default whatever the reader's
own config says. A reader whose `diff.renames` is `copies` would otherwise see a
copied file as a copy with no line written, which is the one change this gate
exists to see.

## Why twelve, and why it is not an input

A per-repo number is the first thing a red run asks for, and a floor every repo
can lower is a floor no repo has. Below twelve lines the matches are mostly what
any two files of a repo share by construction: measured on 2026-11-01 across
fec-program, lolstats and postpad with every line counted as new, a six-line
window found 951 clone pairs and a twelve-line one 152, most of those test setup
blocks and form fields copied whole. dev-config itself held none at twelve.

## Keeping a copy

A directive on the clone's first line, in the file the branch wrote:

```ts
export const price0 = measure(0, "price"); // duplicate-code-allow -- the fixture mirrors the wire format
```

The directive keeps that clone for the run, and the gate's log names each clone
it kept with its reason. It counts only on a side the branch wrote into, so a
directive written on an older block does not license the next copy of it.

The reason is owed, as for every other directive here.
[suppression-hygiene](suppression-hygiene.md) refuses a `duplicate-code-allow`
with no ` -- reason`, and this gate keeps the clone regardless, so one mistake
draws one diagnostic.
