/**
 * The repo's CI workflow — where it lives, the call into the shared check.yml
 * it makes and what that call asks for, and the queue its runs share — which
 * both halves of the contract have an opinion about and neither owns.
 *
 * `repo-contract.ts` asks whether the file calls the shared check.yml at a
 * pinned SHA, whether the workflow cancels a run a newer push replaced, and
 * whether the repo exposes the migration entry point that call implies — facts
 * about every repo. `live.ts` names the same file in two problems about what
 * that call has to ask for — facts about a repo with users. Either module could
 * hold them and import them to the other; both directions read as one of them
 * owning something it merely mentions, and one of them is the cycle. So they
 * are here, the way `db-gate` keeps what two of its gates share inside its own
 * directory rather than in `_lib`.
 */
import {
  type ConfigObject,
  isList,
  oneOf,
  type Problem,
  readConfig,
  record,
} from "../_lib/gate.ts";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * Which database gates a caller's `check.yml` call runs, as the call spells it.
 *
 * Three values rather than a boolean, because "no Postgres job here" and "no
 * database gates anywhere" are different facts and only the second excuses a
 * repo from replaying its schema. `postgres` is check.yml's own job. `external`
 * is what a wrapper workflow passes when it calls check.yml for every static
 * gate and replaces the Postgres job with its own dialect's — `gokayo43/dev-config-db`
 * is the case, and under a boolean its consumers were refused for a job the
 * wrapper had deliberately taken over. `none` is a repo with no schema at all.
 */
const DATABASE_GATES = ["postgres", "external", "none"] as const;

export type DatabaseGates = (typeof DATABASE_GATES)[number];

/** The input as one of those, or nothing — which is the caller's problem and never a default. */
export function databaseGatesOf(value: string): DatabaseGates | undefined {
  return oneOf(DATABASE_GATES, value);
}

/** What a caller is told when it wrote something else. */
export function notDatabaseGates(value: string): string {
  return `database reads ${JSON.stringify(value)} — it is one of ${DATABASE_GATES.join(
    ", ",
  )}: postgres runs check.yml's own database job, external says a wrapper workflow runs the database gates instead of it, and none is a repo with no schema`;
}

const CHECK_CALL = /^gokayo43\/dev-config\/\.github\/workflows\/check\.yml@[0-9a-f]{40}$/;

/**
 * The workflow as read once, for every rule with a question about it. Missing
 * and unreadable are different states, and the rules answer them differently:
 * only the call has anything to say about a file that is not there, and only
 * the queue — which no exemption waives — speaks for one that will not parse,
 * so an unreadable file is reported once whatever the exemptions.
 */
export type Workflow =
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly problems: readonly Problem[] }
  | { readonly state: "read"; readonly contents: ConfigObject };

export async function readWorkflow(root: string): Promise<Workflow> {
  if (!(await Bun.file(`${root}/${CI_WORKFLOW}`).exists())) return { state: "missing" };
  const read = await readConfig(root, CI_WORKFLOW, "YAML");
  return read.contents === undefined
    ? { state: "unreadable", problems: read.problems }
    : { state: "read", contents: read.contents };
}

/** The repo's call into the shared gate, and what is wrong with it. */
export interface Call {
  /** The `with:` block of the job that calls check.yml, or nothing when no job does. */
  readonly asked: ConfigObject | undefined;
  /**
   * Every `run:` the workflow's own steps carry, in job order — what this file
   * says the repo does for itself, as against what it asked the shared workflow
   * for. Empty where the file is missing or unreadable, which is a workflow
   * that runs nothing either way.
   */
  readonly steps: readonly string[];
  readonly problems: Problem[];
}

/** Every step of every job that runs something, as the command it runs. */
function stepsIn(jobs: ConfigObject): string[] {
  return Object.values(jobs).flatMap((job) => {
    const steps = record(job)["steps"];
    if (!isList(steps)) return [];
    return steps.flatMap((step) => {
      const run = record(step)["run"];
      return typeof run === "string" ? [run] : [];
    });
  });
}

/**
 * The call, read once and handed to everyone who has a question about it: that
 * it exists and is pinned is asked here, and what a live repo's copy of it asks
 * for, and whether a live repo with pages runs its browser suite somewhere in
 * the workflow, are asked in `live.ts` of what this answers. Threading a `live`
 * boolean in here would put those inside a check that is not about them, and
 * hide the fact that `ci-call` waives the pin and the upgrade gate together.
 */
export function checkCall(workflow: Workflow): Call {
  if (workflow.state === "missing") {
    return {
      asked: undefined,
      steps: [],
      problems: [{ file: CI_WORKFLOW, message: "the repo has no CI workflow" }],
    };
  }
  if (workflow.state === "unreadable") return { asked: undefined, steps: [], problems: [] };

  const jobs = record(workflow.contents["jobs"]);
  const steps = stepsIn(jobs);
  const call = Object.values(jobs)
    .map((job) => record(job))
    .find(({ uses }) => typeof uses === "string" && CHECK_CALL.test(uses));
  if (call === undefined) {
    return {
      asked: undefined,
      steps,
      problems: [
        {
          file: CI_WORKFLOW,
          message:
            "no job calls gokayo43/dev-config/.github/workflows/check.yml pinned to a 40-character commit SHA — a tag is a name someone else can repoint",
        },
      ],
    };
  }
  return { asked: record(call["with"]), steps, problems: [] };
}

/** What a `group` names inside its `${{ }}` expressions, which is the only place a name is read as one. */
function expressionsIn(group: string): string {
  return [...group.matchAll(/\$\{\{(.*?)\}\}/g)].map(([, inner]) => inner ?? "").join(" ");
}

/**
 * The top-level `concurrency` block every repo's workflow owes, `ci-call` or
 * not: its runs queue on one self-hosted runner however the CI is written. A
 * missing file is the call's to report; an unreadable one is reported here,
 * since this is the rule no exemption reaches.
 */
export function checkConcurrency(workflow: Workflow): Problem[] {
  if (workflow.state === "missing") return [];
  if (workflow.state === "unreadable") {
    return workflow.problems.map(({ message }) => ({
      file: CI_WORKFLOW,
      message: `${message}, so its top-level \`concurrency\` block cannot be read`,
    }));
  }
  const concurrency = record(workflow.contents["concurrency"]);
  const group = concurrency["group"];
  const problems: Problem[] = [];
  if (concurrency["cancel-in-progress"] !== true) {
    problems.push({
      file: CI_WORKFLOW,
      message:
        "the top-level `concurrency` block has to set `cancel-in-progress: true` — every CI run of a repo queues on its one self-hosted runner, and a run a newer push has replaced holds that runner until it finishes unless it is cancelled",
    });
  }
  const named = typeof group === "string" ? expressionsIn(group) : "";
  if (!/\bgithub\.ref\b/.test(named) || !/\bgithub\.event_name\b/.test(named)) {
    problems.push({
      file: CI_WORKFLOW,
      message:
        "the top-level `concurrency` block's `group` has to name both `github.ref` and `github.event_name`, each inside `${{ }}`, as `ci-${{ github.ref }}-${{ github.event_name }}` does — the ref keeps a push from cancelling another branch's run, and the event keeps a push from cancelling a nightly and a nightly from cancelling a push",
    });
  }
  return problems;
}
