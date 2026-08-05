# Queue integrity

The issue queue is the register for everything not being done right now. One
weekly workflow reads it and reports the two ways it rots without anyone
noticing.

```yaml
# .github/workflows/queue-weekly.yml
name: Queue weekly
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  audit:
    permissions:
      contents: read
      issues: read
    uses: gokayo43/dev-config/.github/workflows/queue-audit.yml@<commit sha> # <release tag>
```

It asserts exactly two things:

- **The label vocabulary is intact** — every canon label exists, and no label
  outside the set does. GitHub seeds a new repo with `bug`, `enhancement` and
  friends, which are a taxonomy nobody drains; the scaffolder clears them and
  this notices if they come back.
- **Every issue labelled `commitment` states a `**Trigger:**` in its body.** A
  commitment whose trigger was never written down is a promise nobody can check,
  and it is the one thing in the queue that expires silently.

| Input              | Default                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `vocabulary`       | `needs-triage needs-info ready-for-agent ready-for-human roadmap commitment wontfix` |
| `commitment-label` | `commitment`                                                                         |

Read-only: the job asks for `issues: read` and the audit writes nothing.

## What is a convention, and what is enforced

The label state machine — an issue in one state, `ready-for-agent` meaning the
product owner approved it, agents filing `needs-triage` and never promoting
their own proposals — is a **convention out of the canon**, followed because
agents read the canon. Nothing here enforces it, and in particular **nothing
checks who applied a label**.

That is deliberate and it is the owner's call. Every actor in this fleet — the
owner, and every agent working on their behalf — authenticates as the same
account. A guard comparing the labelling actor against the repo owner is
therefore inert by construction: in the event payload, in the issue timeline and
in the API there is no field that tells them apart. Machinery policing a threat
that structurally cannot occur is not protection, it is a maintenance bill and a
false sense of one.

If the fleet ever grows a separate principal for agents, that is the change that
makes such a check meaningful, and it is a decision for the repo owner rather
than something a gate can assume. Until then: convention, plus this tripwire.
