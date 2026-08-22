# Suppression hygiene

Two ways work hides in a tree rather than in the queue, both a failed step:

- a directive with no ` -- reason` after the rule names, in any of three
  spellings: oxlint honours `eslint-disable` exactly as it honours
  `oxlint-disable`, so a gate that knew only its own name left the other one
  unreasoned and unreported — and Stryker's `disable` comment silences a mutant
  in [the mutation lane](mutation-lane.md), which is the same act by a third
  tool. `Stryker restore` is not one: it ends a disabled region rather than
  opening one, and the reason was owed at the `disable` above it.
- a tracked `TODO.md`, `BACKLOG.md`, `TASKS.md`, `ISSUES.md` or `ROADMAP.md`.

The second one is not about the filename. A list in a file has no labels, no
assignee, no close, and no one who has agreed to drain it; the register is GitHub
issues in the repo the work belongs to, and a second register is deletion that
feels responsible.

The scan reads source rather than intent, so a directive quoted in prose counts:
a doc comment that writes one out to explain it is a suppression as far as this
is concerned. Markdown is not scanned, which is where most of that prose lives;
a comment in code says the name without the leading slashes instead.

A suite that tests this gate necessarily contains directives that are fixture
text rather than suppressions. Those files are named in the `fixtures` input —
narrower than teaching the scan enough TypeScript to tell a comment from a
string literal, and visible in the caller's diff rather than hidden in a
heuristic.
