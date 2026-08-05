import { gh } from "../_lib/gh.ts";
import { inputs, report } from "../_lib/gate.ts";
import { type IssueDesk, queueGuard } from "./queue-guard.ts";

const read = inputs("label", "actor", "owner", "issue");

const desk: IssueDesk = {
  comment: async (issue, body) => void (await gh(["issue", "comment", issue, "--body", body])),
  removeLabel: async (issue, label) =>
    void (await gh(["issue", "edit", issue, "--remove-label", label])),
};

report(
  await queueGuard(
    {
      label: read["label"],
      actor: read["actor"],
      owner: read["owner"],
      issue: read["issue"],
    },
    desk,
  ),
);
