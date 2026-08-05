import { inputs, list, report } from "../_lib/gate.ts";
import { gh, whole } from "../_lib/gh.ts";
import { CANON, type Issue, type Label, type Queue, queueAudit } from "./queue-audit.ts";

const LABEL_LIMIT = 200;
const ISSUE_LIMIT = 500;

const read = inputs("vocabulary", "commitment-label");

const queue: Queue = {
  labels: async () =>
    whole(
      JSON.parse(
        await gh(["label", "list", "--limit", String(LABEL_LIMIT), "--json", "name"]),
      ) as Label[],
      LABEL_LIMIT,
      "labels",
    ),
  openIssues: async () =>
    whole(
      JSON.parse(
        await gh([
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          String(ISSUE_LIMIT),
          "--json",
          "number,labels,body",
        ]),
      ) as Issue[],
      ISSUE_LIMIT,
      "open issues",
    ),
};

report(
  await queueAudit(queue, {
    vocabulary: list(read["vocabulary"]).length > 0 ? list(read["vocabulary"]) : CANON.vocabulary,
    commitmentLabel: read["commitment-label"] || CANON.commitmentLabel,
  }),
);
