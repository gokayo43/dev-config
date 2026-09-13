import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The nightly's filing workflow, which is the only thing this repo ships that
 * writes anything anywhere — and the one piece of it whose subject is an effect
 * that leaves the system.
 *
 * Driven the way the test-suite gate is driven, one level down again: the step
 * is shell in a workflow, so the suite extracts it out of the shipped YAML and
 * runs it with a stand-in for `gh` on the path. The stand-in is not a stub of
 * the answers — it logs every call and then runs the step's own `--jq` program
 * over canned API JSON with the real `jq`, so a filter that selects the wrong
 * issues fails here rather than on GitHub.
 *
 * What is graded is which calls the step makes, because here the calls *are*
 * the contract: "file one issue, comment rather than file a second, close it
 * when the run is green" is a statement about requests and about nothing else.
 */

const WORKFLOW = new URL("../.github/workflows/nightly-issue.yml", import.meta.url).pathname;
const DOCUMENT = record(Bun.YAML.parse(await Bun.file(WORKFLOW).text()));
const FILING = record(record(record(DOCUMENT["jobs"])["file"]));

/** The step, found by the fact that it is the one that runs shell. */
const STEP = ((): ConfigObject => {
  const steps = isList(FILING["steps"]) ? [...FILING["steps"]] : [];
  const found = steps.map(record).filter((step) => typeof step["run"] === "string");
  const [step, ...rest] = found;
  if (step === undefined || rest.length > 0) {
    throw new Error(`the filing job has ${found.length} shell steps, not one`);
  }
  return step;
})();

const SCRIPT = String(STEP["run"]);

/** The title as the shipped step spells it, which is the whole of the issue's identity. */
const TITLE = String(record(STEP["env"])["TITLE"]);

const RUN_URL = "https://github.com/gokayo43/fixture/actions/runs/4242";

/**
 * A `gh` that answers from a file and remembers what it was asked. Reads go
 * through the step's own `--jq` program and the real `jq`; writes answer the
 * `.html_url` every call in the step asks for.
 */
const GH = `#!/usr/bin/env bash
set -euo pipefail

{
  printf 'gh %s\\n' "$*"
  case " $* " in
    *" --input - "*) sed 's/^/  | /' ;;
  esac
} >> "$GH_LOG"

canned=$WROTE_JSON
subject=write
case " $* " in
  *"/jobs"*) canned=$JOBS_JSON subject=jobs ;;
  *" -X GET "*) canned=$ISSUES_JSON subject=search ;;
esac

# What the API refusing looks like from in here: a rate limit, an outage, a
# token that expired mid-run. Named per subject, because which read failed is
# the whole of what the cases below are about.
case " $REFUSES " in
  *" $subject "*)
    echo "gh: HTTP 503 (https://api.github.com/…)" >&2
    exit 1
    ;;
esac

program=.
take_next=false
for argument in "$@"; do
  if [ "$take_next" = true ]; then
    program=$argument
    take_next=false
  fi
  if [ "$argument" = "--jq" ]; then take_next=true; fi
done

jq -r "$program" "$canned"
`;

/** One request the step made, as the log records it. */
type Call = string;

interface Ran {
  readonly status: number;
  readonly calls: Call[];
  /** Everything written to the log, which includes the bodies of what was posted. */
  readonly log: string;
  readonly output: string;
}

interface Nightly {
  /** What the check came to, which is the one value the step decides on. */
  readonly result?: string;
  /** Which `gh` reads answer with an error instead: `search`, `jobs`, `write`. */
  readonly refuses?: readonly string[];
  /** The open issues the search finds, as the API answers them. */
  readonly issues?: readonly ConfigObject[];
  /** The run's jobs, as the API answers them. */
  readonly jobs?: readonly ConfigObject[];
  /** A fuzz report in the run's evidence, as JSON — or as the text of one nothing can parse. */
  readonly fuzz?: ConfigObject | string;
}

const FAILED_JOB = {
  name: "check / static",
  conclusion: "failure",
  steps: [
    { name: "Run the suite", conclusion: "failure" },
    { name: "Publish the junit report", conclusion: "success" },
  ],
};

/** An issue as the API answers one; a pull request answers with the extra key. */
function issue(number: number, title = TITLE, pull = false): ConfigObject {
  return { number, title, ...(pull ? { pull_request: { url: "…" } } : {}) };
}

async function ran({
  result = "success",
  refuses = [],
  issues = [],
  jobs = [FAILED_JOB],
  fuzz,
}: Nightly): Promise<Ran> {
  const tree: Tree = {
    gh: GH,
    "issues.json": JSON.stringify(issues),
    "jobs.json": JSON.stringify({ jobs }),
    "wrote.json": JSON.stringify({ html_url: "https://github.com/gokayo43/fixture/issues/1" }),
    ...(fuzz === undefined
      ? {}
      : {
          "evidence/db-gate-evidence/fuzz.json":
            typeof fuzz === "string" ? fuzz : JSON.stringify(fuzz),
        }),
  };
  const root = await materialise(tree);
  await chmod(join(root, "gh"), 0o755);

  const proc = Bun.spawn(["bash", "-c", SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env["PATH"] ?? ""}`,
      RUNNER_TEMP: root,
      GH_LOG: join(root, "gh.log"),
      ISSUES_JSON: join(root, "issues.json"),
      JOBS_JSON: join(root, "jobs.json"),
      WROTE_JSON: join(root, "wrote.json"),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "gokayo43/fixture",
      GITHUB_RUN_ID: "4242",
      GH_TOKEN: "not-a-token",
      REFUSES: refuses.join(" "),
      RESULT: result,
      TITLE,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  const logged = Bun.file(join(root, "gh.log"));
  const log = (await logged.exists()) ? await logged.text() : "";
  return {
    status,
    calls: log.split("\n").filter((line) => line.startsWith("gh ")),
    log,
    output: `${out}${err}`,
  };
}

/** What the step did to the API, as the verbs a reader of this suite cares about. */
function wrote(calls: readonly Call[]): string[] {
  return calls
    .filter((call) => call.includes("-X POST") || call.includes("-X PATCH"))
    .map((call) => call.replaceAll(/\s+--jq\s+\S+|\s+--input\s+-/gu, "").replace("gh api ", ""));
}

describe("a nightly that is red", () => {
  test("files one issue, under the title that is its identity", async () => {
    const { status, calls, log } = await ran({ result: "failure" });
    expect(status).toBe(0);
    expect(wrote(calls)).toEqual(["-X POST /repos/gokayo43/fixture/issues"]);
    expect(log).toContain(`"title": "${TITLE}"`);
  });

  // The body may never be without this. An issue naming no run is an issue
  // nobody can act on, and the step writes it before it searches for anything.
  test("carrying the run, the job that failed and the step inside it", async () => {
    const { log } = await ran({ result: "failure" });
    expect(log).toContain(RUN_URL);
    expect(log).toContain("check / static: Run the suite");
  });

  // The fuzzer's two facts, out of the artifact the run left behind — the seed
  // replays the whole run and the command replays the one request, and neither
  // survives anywhere else once the logs expire.
  test("and the fuzzer's seed and first failure where the run got that far", async () => {
    const { log } = await ran({
      result: "failure",
      fuzz: {
        seed: 2751418394,
        failures: [
          {
            method: "POST",
            path: "/things/:id",
            broke: "answered 500",
            curl: "curl -i -X POST 'http://localhost:3000/things/0'",
          },
        ],
      },
    });
    expect(log).toContain("2751418394");
    expect(log).toContain("curl -i -X POST");
    expect(log).toContain("/things/:id");
  });

  test("but says nothing about a fuzzer that never ran", async () => {
    const { log } = await ran({ result: "failure" });
    expect(log).not.toContain("Fuzzer");
  });

  // Search, then act: the second night is a comment, not a second issue. A step
  // that filed unconditionally would leave a month of identical issues behind
  // it, which is the same as reporting nothing.
  test("comments on the issue already open rather than filing another", async () => {
    const { calls } = await ran({ result: "failure", issues: [issue(7)] });
    expect(wrote(calls)).toEqual(["-X POST /repos/gokayo43/fixture/issues/7/comments"]);
  });

  // The one window search-then-act cannot close is between the search and the
  // create. This is what cleans it up: the oldest is where the nightly reports,
  // and the rest are closed as what they are.
  test("and where two are open, the oldest gets the run and the rest are closed", async () => {
    const { calls, log } = await ran({
      result: "failure",
      issues: [issue(9), issue(7)],
    });
    expect(wrote(calls)).toEqual([
      "-X POST /repos/gokayo43/fixture/issues/7/comments",
      "-X POST /repos/gokayo43/fixture/issues/9/comments",
      "-X PATCH /repos/gokayo43/fixture/issues/9 -f state=closed -f state_reason=completed",
    ]);
    expect(log).toContain("duplicate of #7");
  });

  // The check is one job to its caller, so one value decides this: what the
  // step must never do is need to know which of that workflow's jobs was the
  // red one.
  test("whichever job inside the check was the red one", async () => {
    const { calls } = await ran({ result: "failure" });
    expect(wrote(calls)).toEqual(["-X POST /repos/gokayo43/fixture/issues"]);
  });
});

describe("a nightly that is green", () => {
  test("closes the issue that was open, naming the run that closed it", async () => {
    const { calls, log } = await ran({ issues: [issue(7)] });
    expect(wrote(calls)).toEqual([
      "-X POST /repos/gokayo43/fixture/issues/7/comments",
      "-X PATCH /repos/gokayo43/fixture/issues/7 -f state=closed -f state_reason=completed",
    ]);
    expect(log).toContain(`green again: ${RUN_URL}`);
  });

  test("and does nothing at all where there is nothing open", async () => {
    const { status, calls } = await ran({});
    expect(status).toBe(0);
    expect(wrote(calls)).toEqual([]);
  });

  // A check that did not run at all — the database job of a repo with no
  // schema, or a whole workflow skipped — is not a check that failed.
  test("a check that was skipped is not a check that failed", async () => {
    const { calls } = await ran({ result: "skipped", issues: [issue(7)] });
    expect(wrote(calls).at(-1)).toContain("state=closed");
  });
});

describe("an API that does not answer", () => {
  // A search that did not answer is not an answer. Inside a process
  // substitution its failure is invisible — `mapfile` reads an empty list and
  // the step goes on to file the issue it has just failed to look for, so one
  // flaky read a night is one duplicate issue a night, for as long as the repo
  // stays red.
  test("a search that failed files nothing and fails the step", async () => {
    const { status, calls, output } = await ran({ result: "failure", refuses: ["search"] });
    expect(wrote(calls)).toEqual([]);
    expect(status).not.toBe(0);
    expect(output).toContain("could not read this repo's open issues");
  });

  // The other direction, and the reason the two are not one rule: everything
  // that only enriches the body is optional, because the issue is the point.
  // The artifact download is `continue-on-error` for exactly this reason, and a
  // read that killed the step would have made that pointless.
  test("a jobs read that failed still files the issue, saying what is missing", async () => {
    const { status, calls, log } = await ran({ result: "failure", refuses: ["jobs"] });
    expect(status).toBe(0);
    expect(wrote(calls)).toEqual(["-X POST /repos/gokayo43/fixture/issues"]);
    expect(log).toContain(RUN_URL);
    expect(log).toContain("unavailable");
  });

  test("and a fuzz report nothing can parse costs the issue nothing either", async () => {
    const { status, calls, log } = await ran({ result: "failure", fuzz: "{ this is not json" });
    expect(status).toBe(0);
    expect(wrote(calls)).toEqual(["-X POST /repos/gokayo43/fixture/issues"]);
    expect(log).toContain(RUN_URL);
    expect(log).toContain("unavailable");
  });
});

describe("what the search must not match", () => {
  // The issues endpoint answers pull requests too, and a pull request titled
  // like the nightly would otherwise be commented on and closed by a green run.
  test("a pull request wearing the same title", async () => {
    const { calls } = await ran({ issues: [issue(7, TITLE, true)] });
    expect(wrote(calls)).toEqual([]);
  });

  test("or an issue about something else", async () => {
    const { calls } = await ran({ issues: [issue(7, "Nightly is red, sometimes")] });
    expect(wrote(calls)).toEqual([]);
  });
});

describe("a run that neither passed nor failed", () => {
  // A cancelled workflow is this job's own `if:`; what is left is a job the
  // runner lost, and neither filing nor closing is true of it.
  test("files nothing and closes nothing, and says why", async () => {
    const { status, calls, output } = await ran({ result: "cancelled", issues: [issue(7)] });
    expect(status).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toContain("::notice::the nightly says nothing");
  });
});
