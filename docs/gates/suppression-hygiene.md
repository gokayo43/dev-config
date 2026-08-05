# Suppression hygiene

Two ways work hides in a tree rather than in the queue, both a failed step:

- a lint directive with no ` -- reason` after the rule names, in either
  spelling: oxlint honours `eslint-disable` exactly as it honours
  `oxlint-disable`, so a gate that knew only its own name left the other one
  unreasoned and unreported.
- a tracked `TODO.md`, `BACKLOG.md`, `TASKS.md`, `ISSUES.md` or `ROADMAP.md`.

The second one is not about the filename. A list in a file has no labels, no
assignee, no close, and no one who has agreed to drain it; the register is GitHub
issues in the repo the work belongs to, and a second register is deletion that
feels responsible.

A suite that tests this gate necessarily contains directives that are fixture
text rather than suppressions. Those files are named in the `fixtures` input —
narrower than teaching the scan enough TypeScript to tell a comment from a
string literal, and visible in the caller's diff rather than hidden in a
heuristic.
