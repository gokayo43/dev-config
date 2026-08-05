import { describe, expect, test } from "bun:test";

import { queueAudit, type QueueRules } from "../.github/actions/queue-audit/queue-audit.ts";
import { queueGuard } from "../.github/actions/queue-guard/queue-guard.ts";

const RULES: QueueRules = {
  vocabulary: [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "roadmap",
    "commitment",
    "wontfix",
  ],
  stateLabels: ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "roadmap", "wontfix"],
  commitmentLabel: "commitment",
};

const LABELS = RULES.vocabulary.map((name) => ({ name }));

function messages(problems: { readonly message: string }[]): string[] {
  return problems.map(({ message }) => message);
}

describe("queue guard", () => {
  test("the owner promotes a proposal", () => {
    expect(queueGuard("ready-for-agent", "gokayo43", "gokayo43")).toEqual([]);
  });

  test.each(["ready-for-agent", "ready-for-human"])("anyone else promoting %s fails", (label) => {
    expect(messages(queueGuard(label, "some-agent", "gokayo43"))).toEqual([
      expect.stringContaining(`some-agent added '${label}'`),
    ]);
  });

  test("anyone may file a proposal or ask for information", () => {
    expect(queueGuard("needs-triage", "some-agent", "gokayo43")).toEqual([]);
    expect(queueGuard("needs-info", "some-agent", "gokayo43")).toEqual([]);
  });
});

describe("queue audit", () => {
  test("the canon vocabulary with well-formed issues passes", () => {
    expect(
      queueAudit(
        LABELS,
        [
          { number: 1, labels: [{ name: "needs-triage" }], body: "evidence" },
          {
            number: 2,
            labels: [{ name: "ready-for-agent" }, { name: "commitment" }],
            body: "Drop the shim.\n\n**Trigger:** the grace period closes.",
          },
        ],
        RULES,
      ),
    ).toEqual([]);
  });

  test("a label outside the vocabulary is refused", () => {
    expect(messages(queueAudit([...LABELS, { name: "enhancement" }], [], RULES))).toEqual([
      expect.stringContaining("label 'enhancement' is outside the queue vocabulary"),
    ]);
  });

  test("a missing canon label is refused — the state machine has to exist to be used", () => {
    expect(messages(queueAudit(LABELS.slice(1), [], RULES))).toEqual([
      expect.stringContaining("label 'needs-triage' is missing"),
    ]);
  });

  test("an issue in no state is refused", () => {
    expect(
      messages(queueAudit(LABELS, [{ number: 4, labels: [{ name: "commitment" }], body: "**Trigger:** x" }], RULES)),
    ).toEqual([expect.stringContaining("issue #4 carries no state label")]);
  });

  test("an issue in two states is refused", () => {
    expect(
      messages(
        queueAudit(
          LABELS,
          [{ number: 5, labels: [{ name: "needs-triage" }, { name: "ready-for-agent" }], body: "" }],
          RULES,
        ),
      ),
    ).toEqual([expect.stringContaining("needs-triage and ready-for-agent")]);
  });

  test("a commitment with no trigger is refused", () => {
    expect(
      messages(
        queueAudit(
          LABELS,
          [
            {
              number: 6,
              labels: [{ name: "roadmap" }, { name: "commitment" }],
              body: "Trigger: someday, in prose nobody greps for",
            },
          ],
          RULES,
        ),
      ),
    ).toEqual([expect.stringContaining("issue #6 is a commitment")]);
  });

  test("an issue with no body at all is still audited", () => {
    expect(
      messages(queueAudit(LABELS, [{ number: 7, labels: [{ name: "commitment" }], body: null }], RULES)),
    ).toEqual([
      expect.stringContaining("issue #7 carries no state label"),
      expect.stringContaining("issue #7 is a commitment"),
    ]);
  });
});
