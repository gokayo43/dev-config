import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shellScripts } from "../.github/actions/shell-scripts/shell-scripts.ts";
import { containing } from "./matchers.ts";
import { materialise, type Tree } from "./tree.ts";

/**
 * The shellcheck the shipped action fetches, resolved through the shipped
 * library rather than taken off PATH. What a run says depends on which
 * shellcheck said it — the tool adds checks between releases — so a suite
 * grading this gate against whatever the machine has installed is grading a
 * different gate from the one CI runs.
 */
const SHELLCHECK = await (async (): Promise<string> => {
  const library = new URL("../.github/actions/_lib/shellcheck.sh", import.meta.url).pathname;
  const temp = join(tmpdir(), `pinned-tools-${process.getuid?.() ?? 0}`);
  // `set -e` because the library is sourced rather than run: a fetch that failed
  // half way leaves the export after it running and the path pointing at nothing.
  // The fetch's own output goes to stderr, since `sha256sum -c` writes its
  // verdict to stdout and stdout here is the path.
  const script = `set -euo pipefail
mkdir -p "$RUNNER_TEMP"
{ . "${library}"; } >&2
printf %s "$SHELLCHECK"`;
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { PATH: Bun.env["PATH"] ?? "", HOME: Bun.env["HOME"] ?? "", RUNNER_TEMP: temp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [path, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`the pinned shellcheck did not arrive: ${err}`);
  return path;
})();

async function messagesOf(tree: Tree): Promise<string[]> {
  const root = await materialise(tree);
  return (await shellScripts(root, SHELLCHECK)).map(
    ({ file, message }) => `${file ?? ""}: ${message}`,
  );
}

/** A script of the shape these repos actually keep: a guard, a dump, a cap. */
const CLEAN: Tree = {
  "scripts/backup.sh": `#!/usr/bin/env bash
set -euo pipefail

target=\${1:?name the database}
out="\${2:-/tmp/dump.sql}"

pg_dump "$target" > "$out"
echo "wrote $out"
`,
};

/** Two findings on one line, for the cases about which files are read at all. */
const DANGLING = "#!/usr/bin/env bash\ncd $HOME\n";

describe("a repository's own shell scripts", () => {
  test("a script that quotes what it expands passes", async () => {
    expect(await messagesOf(CLEAN)).toEqual([]);
  });

  // The class the gate exists for: an unquoted expansion is a word split on
  // whatever the value happened to hold, and in this set that is a path handed
  // to something that deletes.
  test("an unquoted expansion is refused, naming the line", async () => {
    const messages = await messagesOf({
      "scripts/backup.sh": CLEAN["scripts/backup.sh"]?.replace('"$out"', "$out") ?? "",
    });
    expect(messages).toEqual([
      "scripts/backup.sh: line 7: Double quote to prevent globbing and word splitting. (SC2086 — https://www.shellcheck.net/wiki/SC2086)",
    ]);
  });

  // The other half of the class the issue names: a name misspelled where it is
  // read is, under `set -u`, a script that dies at exactly the line that was
  // about to do the dangerous part.
  test("a name that is never assigned is refused", async () => {
    expect(
      await messagesOf({
        "scripts/drill.sh": `#!/usr/bin/env bash
set -euo pipefail
dropdb "$drill_databse"
`,
      }),
    ).toEqual([
      "scripts/drill.sh: line 3: drill_databse is referenced but not assigned. (SC2154 — https://www.shellcheck.net/wiki/SC2154)",
    ]);
  });

  // Not `scripts/` and not an input naming paths: what makes a script worth
  // reading is what is in it. A gate keyed to a directory stops covering the
  // file the day somebody moves it, and says nothing when it does.
  test("a script anywhere in the tree is read, whatever the directory", async () => {
    expect(await messagesOf({ "infra/deploy/rollout.sh": DANGLING })).toEqual([
      containing("infra/deploy/rollout.sh: line 2: Use 'cd ... || exit'"),
      containing("infra/deploy/rollout.sh: line 2: Double quote"),
    ]);
  });

  test("every script is read, so one run lists every fix", async () => {
    const files = (await messagesOf({ "a.sh": DANGLING, "b.sh": DANGLING })).map(
      (message) => message.split(":")[0],
    );
    expect(new Set(files)).toEqual(new Set(["a.sh", "b.sh"]));
  });

  // Most repos here have no shell at all, and a gate that hung on one would be
  // a step spending the job's whole timeout: with no file argument shellcheck
  // reads stdin.
  test("a repository with no shell scripts is nothing to report", async () => {
    expect(await messagesOf({ "package.json": '{ "name": "quiet" }\n' })).toEqual([]);
  });

  // The escape hatch stays what it is everywhere else here: beside the line, in
  // the diff, where a reviewer sees it — rather than a .shellcheckrc the gate
  // would have obeyed without anybody reading it.
  test("a directive beside the line waives it, and a .shellcheckrc at the root does not", async () => {
    const waived = CLEAN["scripts/backup.sh"]?.replace(
      'pg_dump "$target"',
      "# shellcheck disable=SC2086\npg_dump $target",
    );
    expect(await messagesOf({ "scripts/backup.sh": waived ?? "" })).toEqual([]);

    expect(
      await messagesOf({
        ".shellcheckrc": "disable=SC2086\n",
        "scripts/backup.sh": CLEAN["scripts/backup.sh"]?.replace('"$out"', "$out") ?? "",
      }),
    ).toHaveLength(1);
  });

  // shellcheck answers 2 for a file it could not open — and writes a valid,
  // empty report on stdout while doing it, which is byte for byte a clean tree.
  // The status is the only thing that tells them apart.
  test("a script shellcheck could not read is not a clean tree", async () => {
    const root = await materialise({ "scripts/locked.sh": "#!/usr/bin/env bash\necho ok\n" });
    await chmod(join(root, "scripts/locked.sh"), 0o000);
    const failure = await shellScripts(root, SHELLCHECK).catch((error: unknown) => error);
    // Restored before the assertion, so a failing case still leaves a tree the
    // suite's own cleanup can remove.
    await chmod(join(root, "scripts/locked.sh"), 0o644);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("shellcheck exited 2 without reading the scripts");
    expect(String(failure)).toContain("permission denied");
  });

  /** A stand-in for the pinned binary, for the runs where what it wrote is the subject. */
  async function shellcheckWriting(stdout: string): Promise<string> {
    const root = await materialise({ "fake.sh": `#!/bin/sh\nprintf %s '${stdout}'\n` });
    const path = join(root, "fake.sh");
    await chmod(path, 0o755);
    return path;
  }

  // Read as a clean tree, each of these is the gate passing by having been
  // handed nothing — and each is one Renovate could introduce, since the pin
  // moves on its own and json1 is a format the tool owns rather than this repo.
  test.each([
    ["a report that is not JSON", "shellcheck: unrecognised flag", "shellcheck wrote no report"],
    ["a report with no comments", '{"version":2}', "report has no comments list"],
    [
      "a comment missing what a diagnostic needs",
      '{"comments":[{"file":"a.sh","line":3}]}',
      "reported something this cannot read",
    ],
  ])("%s fails loudly rather than passing", async (_, wrote, said) => {
    const root = await materialise(CLEAN);
    // Awaited rather than left as a floating `.rejects` chain: a case that
    // finishes before the assertion resolves reports an unhandled rejection
    // instead of the run that was asked.
    const failure = await shellScripts(root, await shellcheckWriting(wrote)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(said);
  });
});
