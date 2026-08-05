import { describe, expect, test } from "bun:test";

import {
  CANON,
  type Issue,
  type Label,
  type LabelEvent,
  type Queue,
  queueAudit,
} from "../.github/actions/queue-audit/queue-audit.ts";
import {
  type IssueDesk,
  type Promotion,
  queueGuard,
} from "../.github/actions/queue-guard/queue-guard.ts";

import { containing } from "./matchers.ts";

const LABELS: Label[] = CANON.vocabulary.map((name) => ({ name }));
const OWNER = "gokayo43";
const RULES = { ...CANON, owner: OWNER };

function queue(
  labels: Label[],
  issues: Issue[] = [],
  timelines: Record<number, LabelEvent[]> = {},
): Queue {
  return {
    labels: async () => labels,
    openIssues: async () => issues,
    labelEvents: async (issue) => timelines[issue] ?? [],
  };
}

async function audit(
  labels: Label[],
  issues: Issue[] = [],
  timelines: Record<number, LabelEvent[]> = {},
): Promise<string[]> {
  return (await queueAudit(queue(labels, issues, timelines), RULES)).map(({ message }) => message);
}

/** Records what reached the issue, and can be told to fail at either step. */
function desk(
  failAt?: "comment" | "removeLabel",
): IssueDesk & { comments: string[]; removed: string[] } {
  const state = {
    comments: [] as string[],
    removed: [] as string[],
    comment: async (_issue: string, body: string) => {
      if (failAt === "comment") throw new Error("gh issue comment failed");
      state.comments.push(body);
    },
    removeLabel: async (_issue: string, label: string) => {
      if (failAt === "removeLabel") throw new Error("gh issue edit failed");
      state.removed.push(label);
    },
  };
  return state;
}

/** The message a rejected call produced, or "" if it resolved — so a case cannot pass by not throwing. */
async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const PROMOTION: Promotion = {
  label: "ready-for-agent",
  actor: "some-agent",
  owner: OWNER,
  issue: "42",
};

describe("queue guard", () => {
  // Encodes a known limitation, not a security property: an agent acting
  // through the owner's account is the owner in every payload, so this branch
  // is also the one that lets such an agent promote its own proposal. See
  // docs/gates/queue-integrity.md.
  test("a promotion by the owner's account is allowed, agent or not", async () => {
    const seam = desk();
    expect(await queueGuard({ ...PROMOTION, actor: OWNER }, seam)).toEqual([]);
    expect(seam.comments).toEqual([]);
    expect(seam.removed).toEqual([]);
  });

  test.each(["ready-for-agent", "ready-for-human"])(
    "anyone else promoting %s has it taken back",
    async (label) => {
      const seam = desk();
      const problems = await queueGuard({ ...PROMOTION, label }, seam);
      expect(problems.map(({ message }) => message)).toEqual([
        containing(`some-agent added '${label}'`),
      ]);
      expect(seam.removed).toEqual([label]);
      expect(seam.comments).toEqual([containing(`Removing \`${label}\``)]);
    },
  );

  test("anyone may file a proposal or ask for information", async () => {
    const seam = desk();
    expect(await queueGuard({ ...PROMOTION, label: "needs-triage" }, seam)).toEqual([]);
    expect(await queueGuard({ ...PROMOTION, label: "needs-info" }, seam)).toEqual([]);
    expect(seam.comments).toEqual([]);
  });

  // The recoverable half of a partial failure is the explained label. A label
  // that vanished with nothing said is what nobody can reconstruct, so the
  // comment has to have landed even when the removal did not.
  test("a removal that fails leaves the issue explaining itself", async () => {
    const seam = desk("removeLabel");
    expect(await rejection(queueGuard(PROMOTION, seam))).toBe("gh issue edit failed");
    expect(seam.comments).toHaveLength(1);
    expect(seam.removed).toEqual([]);
  });

  test("a comment that fails takes the removal with it", async () => {
    const seam = desk("comment");
    expect(await rejection(queueGuard(PROMOTION, seam))).toBe("gh issue comment failed");
    expect(seam.removed).toEqual([]);
  });
});

describe("queue audit", () => {
  test("the canon vocabulary with well-formed issues passes", async () => {
    expect(
      await audit(
        LABELS,
        [
          { number: 1, labels: [{ name: "needs-triage" }], body: "evidence" },
          {
            number: 2,
            labels: [{ name: "ready-for-agent" }, { name: "commitment" }],
            body: "Drop the shim.\n\n**Trigger:** the grace period closes.",
          },
        ],
        { 2: [{ label: "ready-for-agent", actor: OWNER }] },
      ),
    ).toEqual([]);
  });

  test("a label outside the vocabulary is refused", async () => {
    expect(await audit([...LABELS, { name: "enhancement" }])).toEqual([
      containing("label 'enhancement' is outside the queue vocabulary"),
    ]);
  });

  test("a missing canon label is refused — the state machine has to exist to be used", async () => {
    expect(await audit(LABELS.slice(1))).toEqual([containing("label 'needs-triage' is missing")]);
  });

  test("an issue in no state is refused", async () => {
    expect(
      await audit(LABELS, [
        { number: 4, labels: [{ name: "commitment" }], body: "**Trigger:** x" },
      ]),
    ).toEqual([containing("issue #4 carries no state label")]);
  });

  test("an issue in two states is refused", async () => {
    expect(
      await audit(
        LABELS,
        [{ number: 5, labels: [{ name: "needs-triage" }, { name: "ready-for-agent" }], body: "" }],
        { 5: [{ label: "ready-for-agent", actor: OWNER }] },
      ),
    ).toEqual([containing("needs-triage and ready-for-agent")]);
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

  // A label applied with the job's own token starts no workflow run, so the
  // guard never saw it. The timeline still records who did it.
  test("a promotion the guard never saw is caught on the schedule", async () => {
    const issue: Issue = { number: 9, labels: [{ name: "ready-for-agent" }], body: "x" };
    expect(
      await audit(LABELS, [issue], { 9: [{ label: "ready-for-agent", actor: "some-bot" }] }),
    ).toEqual([containing("promoted to 'ready-for-agent' by some-bot")]);
    expect(
      await audit(LABELS, [issue], { 9: [{ label: "ready-for-agent", actor: OWNER }] }),
    ).toEqual([]);
  });

  test("the latest application of the label is the one that counts", async () => {
    const issue: Issue = { number: 10, labels: [{ name: "ready-for-human" }], body: "x" };
    expect(
      await audit(LABELS, [issue], {
        10: [
          { label: "ready-for-human", actor: "some-bot" },
          { label: "ready-for-human", actor: OWNER },
        ],
      }),
    ).toEqual([]);
  });

  test("a promotion with no event at all cannot be attributed, so it is refused", async () => {
    const issue: Issue = { number: 11, labels: [{ name: "ready-for-agent" }], body: "x" };
    expect(await audit(LABELS, [issue])).toEqual([
      containing("with no labelled event naming who added it"),
    ]);
  });

  test("an issue with no body at all is still audited", async () => {
    expect(
      await audit(LABELS, [{ number: 7, labels: [{ name: "commitment" }], body: null }]),
    ).toEqual([
      containing("issue #7 carries no state label"),
      containing("issue #7 is a commitment"),
    ]);
  });
});
