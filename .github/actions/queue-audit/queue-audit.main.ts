import { gh, whole } from "../_lib/gh.ts";
import { inputs, list, report } from "../_lib/gate.ts";
import {
  CANON,
  type Issue,
  type Label,
  type LabelEvent,
  type Queue,
  queueAudit,
} from "./queue-audit.ts";

const LABEL_LIMIT = 200;
const ISSUE_LIMIT = 500;

const read = inputs("vocabulary", "state-labels", "commitment-label", "owner");
const or = (value: string, canon: readonly string[]): readonly string[] =>
  list(value).length > 0 ? list(value) : canon;

interface TimelineEvent {
  readonly event: string;
  readonly label?: { readonly name: string };
  readonly actor?: { readonly login: string } | null;
}

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
  labelEvents: async (issue) => {
    const events = JSON.parse(
      await gh(["api", "--paginate", `repos/${Bun.env["GH_REPO"] ?? ""}/issues/${issue}/events`]),
    ) as TimelineEvent[];
    return events
      .filter(
        (event): event is TimelineEvent & { label: { name: string } } =>
          event.event === "labeled" && event.label !== undefined,
      )
      .map(
        (event): LabelEvent => ({
          label: event.label.name,
          actor: event.actor?.login ?? "",
        }),
      );
  },
};

report(
  await queueAudit(queue, {
    vocabulary: or(read["vocabulary"], CANON.vocabulary),
    stateLabels: or(read["state-labels"], CANON.stateLabels),
    commitmentLabel: read["commitment-label"] || CANON.commitmentLabel,
    owner: read["owner"],
  }),
);
