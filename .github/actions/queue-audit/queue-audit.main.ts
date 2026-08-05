import { gh } from "../_lib/gh.ts";
import { inputs, list, report } from "../_lib/gate.ts";
import { CANON, type Issue, type Label, type Queue, queueAudit } from "./queue-audit.ts";

const read = inputs("vocabulary", "state-labels", "commitment-label");
const or = (value: string, canon: readonly string[]): readonly string[] =>
  list(value).length > 0 ? list(value) : canon;

const queue: Queue = {
  labels: async () =>
    JSON.parse(await gh(["label", "list", "--limit", "200", "--json", "name"])) as Label[],
  openIssues: async () =>
    JSON.parse(
      await gh([
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "500",
        "--json",
        "number,labels,body",
      ]),
    ) as Issue[],
};

report(
  await queueAudit(queue, {
    vocabulary: or(read["vocabulary"], CANON.vocabulary),
    stateLabels: or(read["state-labels"], CANON.stateLabels),
    commitmentLabel: read["commitment-label"] || CANON.commitmentLabel,
  }),
);
