import { describe, expect, test } from "bun:test";

import {
  CANON,
  type Issue,
  type Label,
  type Queue,
  queueAudit,
} from "../.github/actions/queue-audit/queue-audit.ts";

import { containing } from "./matchers.ts";

const LABELS: Label[] = CANON.vocabulary.map((name) => ({ name }));

function queue(labels: Label[], issues: Issue[]): Queue {
  return { labels: async () => labels, openIssues: async () => issues };
}

async function audit(labels: Label[], issues: Issue[] = []): Promise<string[]> {
  return (await queueAudit(queue(labels, issues), CANON)).map(({ message }) => message);
}

describe("queue audit", () => {
  test("the canon vocabulary with well-formed issues passes", async () => {
    expect(
      await audit(LABELS, [
        { number: 1, labels: [{ name: "needs-triage" }], body: "evidence" },
        {
          number: 2,
          labels: [{ name: "ready-for-agent" }, { name: "commitment" }],
          body: "Drop the shim.\n\n**Trigger:** the grace period closes.",
        },
      ]),
    ).toEqual([]);
  });

  test("a label outside the vocabulary is refused", async () => {
    expect(await audit([...LABELS, { name: "enhancement" }])).toEqual([
      containing("label 'enhancement' is outside the queue vocabulary"),
    ]);
  });

  test("a missing canon label is refused — the vocabulary has to exist to be used", async () => {
    expect(await audit(LABELS.slice(1))).toEqual([containing("label 'needs-triage' is missing")]);
  });

  test("a commitment with no trigger is refused", async () => {
    expect(
      await audit(LABELS, [
        {
          number: 6,
          labels: [{ name: "roadmap" }, { name: "commitment" }],
          body: "Trigger: someday, in prose nobody greps for",
        },
      ]),
    ).toEqual([containing("issue #6 is a commitment")]);
  });

  test("an issue with no body at all is still audited", async () => {
    expect(
      await audit(LABELS, [{ number: 7, labels: [{ name: "commitment" }], body: null }]),
    ).toEqual([containing("issue #7 is a commitment")]);
  });

  // Which label an issue carries, and how many, is a convention agents follow
  // out of the canon. Nothing here polices it: the fleet is one account, and an
  // account cannot police itself. See docs/gates/queue-integrity.md.
  test("how an issue is labelled is not this audit's business", async () => {
    expect(
      await audit(LABELS, [
        { number: 8, labels: [], body: "no state label at all" },
        {
          number: 9,
          labels: [{ name: "needs-triage" }, { name: "ready-for-agent" }],
          body: "two of them",
        },
      ]),
    ).toEqual([]);
  });
});
