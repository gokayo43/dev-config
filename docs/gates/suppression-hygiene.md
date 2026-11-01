# Suppression hygiene

Two ways work hides in a tree rather than in the queue, both a failed step:

- a directive with no ` -- reason` after the rule names, in any of four
  spellings: oxlint honours `eslint-disable` exactly as it honours
  `oxlint-disable`, so a gate that knew only its own name left the other one
  unreasoned and unreported — Stryker's `disable` comment silences a mutant in
  [the mutation lane](mutation-lane.md), and `duplicate-code-allow` keeps a
  clone [the duplicate-code gate](duplicate-code.md) would refuse, which are
  the same act by two more tools. `Stryker restore` is not one: it ends a
  disabled region rather than opening one, and the reason was owed at the
  `disable` above it.
- a tracked `TODO.md`, `BACKLOG.md`, `TASKS.md`, `ISSUES.md` or `ROADMAP.md`.

The second one is not about the filename. A list in a file has no labels, no
assignee, no close, and no one who has agreed to drain it; the register is GitHub
issues in the repo the work belongs to, and a second register is deletion that
feels responsible.

The scan reads comments, the only place a tool reads a directive from. A string
literal that spells one is data, which is what a suite's fixtures are, and owes
nothing. A comment is read whole, so a directive quoted in prose counts: a doc
comment that writes one out to explain it is a suppression as far as this is
concerned. Markdown is not scanned, which is where most of that prose lives; a
comment in code says the name without the leading slashes instead.

The reason is what follows `--` after the directive's own name, in the same
comment. A `--` in the code before the comment is not one.
