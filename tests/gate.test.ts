import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowlistFrom,
  inputs,
  notice,
  publish,
  report,
  required,
} from "../.github/actions/_lib/gate.ts";
import { git, history, type Tree } from "./tree.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

const environment = { ...process.env };

/**
 * The run summaries the publishing cases wrote, deleted after each of them. The
 * name is derived rather than random for the reason `tests/tree.ts` gives about
 * fixture roots: a run killed outright leaves a name the next run reclaims.
 */
const summaries: string[] = [];

afterEach(async () => {
  await Promise.all(summaries.splice(0).map((file) => rm(file, { force: true })));
  process.exitCode = 0;
  // Restored rather than reset: these cases set and delete variables the whole
  // suite runs inside, and a case that changed one for every case after it
  // would be a fixture nobody could read in isolation.
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
});

describe("annotations", () => {
  // The workflow-command syntax is a contract with GitHub: a diagnostic in any
  // other shape is a log line nobody sees on the file it belongs to.
  test("a problem carrying a file annotates that file", () => {
    const { lines, restore } = captureLog();
    report([{ file: "package.json", message: "packageManager must read bun@<version>" }]);
    restore();
    expect(lines).toEqual(["::error file=package.json::packageManager must read bun@<version>"]);
  });

  test("a problem with no file is still an error", () => {
    const { lines, restore } = captureLog();
    report([{ message: "issue #4 carries no state label" }]);
    restore();
    expect(lines).toEqual(["::error::issue #4 carries no state label"]);
  });

  test("every problem is reported, so one run lists every fix", () => {
    const { lines, restore } = captureLog();
    report([{ message: "one" }, { message: "two" }, { message: "three" }]);
    restore();
    expect(lines).toHaveLength(3);
    expect(process.exitCode).toBe(1);
  });

  test("nothing to report leaves the step passing", () => {
    const { lines, restore } = captureLog();
    report([]);
    restore();
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("a notice says something without failing anything", () => {
    const { lines, restore } = captureLog();
    notice("exempt from 'ci-call'");
    restore();
    expect(lines).toEqual(["::notice::exempt from 'ci-call'"]);
    expect(process.exitCode).toBe(0);
  });
});

/**
 * Every entry point that publishes hands its whole verdict to `publish` and does
 * nothing else, so what those runs put on the log and in the run summary is
 * decided entirely here. Captured off `console.log` because that is the
 * protocol: GitHub reads `::error` and `::notice` off stdout, and the order they
 * arrive in is what a reader scrolls through.
 */
describe("what publishing a verdict writes", () => {
  /** A run summary of this case's own, since that is where the table goes. */
  async function summaryFile(): Promise<string> {
    const file = join(tmpdir(), `gate-summary-${process.pid}-${summaries.length}.md`);
    summaries.push(file);
    await rm(file, { force: true });
    return file;
  }

  const nothing = { note: undefined, table: undefined, log: undefined, problems: [] };

  // The order is the claim `publish` makes: the evidence is above the
  // annotation that summarises it, which is above the errors — so a reader who
  // scrolls to the error finds what it was about without scrolling further.
  test("the log comes before the note, and the note before the errors", async () => {
    const { lines, restore } = captureLog();
    await publish(
      {
        ...nothing,
        note: "2 changed domain files held no mutants",
        log: "stryker said this\nand then this",
        problems: [{ message: "kill the mutants listed in the run summary" }],
      },
      await summaryFile(),
    );
    restore();

    expect(lines).toEqual([
      "stryker said this",
      "and then this",
      "::notice::2 changed domain files held no mutants",
      "::error::kill the mutants listed in the run summary",
    ]);
  });

  test("a verdict with nothing to say writes nothing and fails nothing", async () => {
    const { lines, restore } = captureLog();
    await publish(nothing, await summaryFile());
    restore();

    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("the table goes to the run summary rather than to the log", async () => {
    const file = await summaryFile();
    const { lines, restore } = captureLog();
    await publish({ ...nothing, table: "### Capacity\n" }, file);
    restore();

    expect(lines).toEqual([]);
    expect(await Bun.file(file).text()).toBe("### Capacity\n");
  });

  // Two gates of one job publish into the same file, and a run summary that
  // held only the last of them would be the first one's measurement lost.
  test("a second table joins the first rather than replacing it", async () => {
    const file = await summaryFile();
    const { restore } = captureLog();
    await publish({ ...nothing, table: "### Capacity\n" }, file);
    await publish({ ...nothing, table: "### Mutation lane\n" }, file);
    restore();

    expect(await Bun.file(file).text()).toBe("### Capacity\n### Mutation lane\n");
  });

  // The run this step is about to fail is exactly the run whose measurement is
  // worth reading: it is what says which way the ramp or the campaign went wrong.
  test("the table is published for a run the step fails", async () => {
    const file = await summaryFile();
    const { restore } = captureLog();
    await publish(
      { ...nothing, table: "### Capacity\n", problems: [{ message: "half the ramp failed" }] },
      file,
    );
    restore();

    expect(await Bun.file(file).text()).toBe("### Capacity\n");
    expect(process.exitCode).toBe(1);
  });
});

// A gate that throws dies as a stack trace on stderr, which GitHub renders on
// no file and no step. Asked of every entry point at once, because the one
// added next is the one that would go back to a stack trace.
describe("entry points", () => {
  const ACTIONS = new URL("../.github/actions/", import.meta.url).pathname;
  const MAINS = [...new Bun.Glob("*/*.main.ts").scanSync({ cwd: ACTIONS })].toSorted((a, b) =>
    a.localeCompare(b),
  );

  test("the suite found the entry points to ask", () => {
    expect(MAINS.length).toBeGreaterThan(0);
  });

  // An inherited environment would hand these the inputs they read, so the
  // environment is built rather than passed through: with none of them set,
  // every entry point throws on the first input it asks for.
  test.each(MAINS)("%s annotates what it died of", async (main) => {
    const proc = Bun.spawn(["bun", join(ACTIONS, main)], {
      env: { PATH: Bun.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(stdout).toContain("::error::");
  });
});

describe("action inputs", () => {
  test("a declared input is read from the variable the action sets", () => {
    process.env["INPUT_WORKING_DIRECTORY"] = "apps/api";
    process.env["INPUT_TIMESTAMP_ALLOWLIST"] = "public.audit log.at";
    expect(inputs("working-directory", "timestamp-allowlist")).toEqual({
      "working-directory": "apps/api",
      "timestamp-allowlist": "public.audit log.at",
    });
  });

  test("an empty input is a value, not an absence", () => {
    process.env["INPUT_EXEMPTIONS"] = "";
    expect(inputs("exemptions")).toEqual({ exemptions: "" });
  });

  // A gate that defaulted a missing input would grade the repo against a
  // contract nobody chose, and the wiring bug would never surface.
  test("an input the action forgot to pass fails loudly", () => {
    delete process.env["INPUT_NEVER_SET"];
    expect(() => inputs("never-set")).toThrow("INPUT_NEVER_SET is not set");
  });

  test("a variable the calling job owns is read from the environment", () => {
    process.env["DATABASE_URL"] = "postgres://localhost/db";
    expect(required("DATABASE_URL", "why")).toBe("postgres://localhost/db");
  });

  // Two gates read this one variable, and the run that is left holding nothing
  // is not always the same one — so the reason travels with the call.
  test("a missing variable fails carrying the reason its caller gave", () => {
    delete process.env["DATABASE_URL"];
    expect(() => required("DATABASE_URL", "the replay needs a database")).toThrow(
      "DATABASE_URL is not set — the replay needs a database",
    );
    process.env["DATABASE_URL"] = "";
    expect(() => required("DATABASE_URL", "the replay needs a database")).toThrow(
      "DATABASE_URL is not set",
    );
  });
});

// Every allowlist input in this repo pays what a lint directive pays: an
// exemption whose reason nobody had to write is one nobody can review later.
describe("allowlist entries", () => {
  test("an entry carries its reason, and the reason is not part of the subject", () => {
    const read = allowlistFrom("OPTIONS /* -- the cors plugin answers these", "route-allowlist");
    expect(read.entries).toEqual(["OPTIONS /*"]);
    expect(read.problems).toEqual([]);
  });

  test("a reasonless entry is refused, and still waives what it names", () => {
    const read = allowlistFrom("public.audit.at", "timestamp-allowlist");
    expect(read.entries).toEqual(["public.audit.at"]);
    expect(read.problems.map(({ message }) => message)).toEqual([
      "timestamp-allowlist waives public.audit.at without saying why — write 'public.audit.at -- <reason>', the same price a lint directive pays",
    ]);
  });

  test("an empty reason is no reason", () => {
    expect(allowlistFrom("GET /x --   ", "route-allowlist").problems).toHaveLength(1);
  });

  // A reason may say anything, including something with the separator in it.
  test("only the first separator divides the entry", () => {
    const read = allowlistFrom("GET /x -- it -- really -- is fine", "route-allowlist");
    expect(read.entries).toEqual(["GET /x"]);
    expect(read.problems).toEqual([]);
  });

  test("entries are one per line, and a blank line is not an entry", () => {
    const read = allowlistFrom("a -- one\n b -- two \n\n", "x");
    expect(read.entries).toEqual(["a", "b"]);
    expect(read.problems).toEqual([]);
  });

  // Why a newline is the only separator is in entriesIn. This is the input
  // that found it.
  test("a comma in the reason is part of the reason", () => {
    const read = allowlistFrom(
      "POST /api/auth/$ -- the shipped ramp only issues GETs, and a sign-up POST would write a user per request",
      "route-allowlist",
    );
    expect(read.entries).toEqual(["POST /api/auth/$"]);
    expect(read.problems).toEqual([]);
  });

  test("nothing allowlisted is nothing to report", () => {
    expect(allowlistFrom("", "route-allowlist")).toEqual({
      entries: [],
      unreasoned: new Set(),
      problems: [],
    });
  });

  test("the subjects of the reasonless entries travel with their problems", () => {
    // A gate with a second rule about an entry reads these rather than the
    // sentences: one refusal per mistake means knowing which entry it was.
    const read = allowlistFrom("GET /a -- why\nGET /b\nGET /c", "route-allowlist");
    expect(read.unreasoned).toEqual(new Set(["GET /b", "GET /c"]));
    expect(read.problems).toHaveLength(read.unreasoned.size);
  });
});

// The shared fixture builder every history-reading suite goes through. Its one
// inviolable property is that the last tree given is the tree at HEAD — a
// builder that quietly commits something else grades every gate above it
// against a repository nobody wrote.
describe("a repository built from a list of trees", () => {
  const A: Tree = { "a.txt": "A\n" };
  const B: Tree = { "b.txt": "B\n" };

  /** Every path a revision holds, which is what a tree is compared by here. */
  async function treeAt(root: string, rev: string): Promise<string[]> {
    return (await git(root, ["ls-tree", "-r", "--name-only", rev])).split("\n").filter(Boolean);
  }

  test("ends at the last tree given", async () => {
    const repo = await history(A, B);
    expect(await treeAt(repo.root, "HEAD")).toEqual(["b.txt"]);
  });

  // A tree that comes round again is what a revert looks like, and it is the
  // one the builder used to skip: it recognised "the first tree" by identity,
  // so the third argument here wrote nothing and committed B's tree a second
  // time. Every case built on it would have been grading the wrong tree.
  test("including a tree it has already been given", async () => {
    const repo = await history(A, B, A);

    expect(await treeAt(repo.root, "HEAD")).toEqual(["a.txt"]);
    expect(await treeAt(repo.root, repo.revs[1] ?? "")).toEqual(["b.txt"]);
    expect(repo.revs).toHaveLength(3);
  });

  test("and a commit that changes nothing is still a commit", async () => {
    const repo = await history(A, A);

    expect(repo.revs).toHaveLength(2);
    expect(repo.revs[0]).not.toBe(repo.revs[1]);
    expect(await treeAt(repo.root, "HEAD")).toEqual(["a.txt"]);
  });
});

describe("a message that is not the gate author's to trust", () => {
  // Every diagnostic these gates write quotes something they read — a row out
  // of a dump, an allowlist entry, a path. GitHub parses one workflow command
  // per line, so an unescaped newline in any of that ends the annotation and
  // offers the rest to the parser: `::add-mask::` in a row value would be a
  // command the runner obeys, and the half of the message after it would never
  // be rendered on the step at all.
  test("a newline in a message does not start a second command", () => {
    const { lines, restore } = captureLog();

    report([{ message: "row differs: 'para one\n::add-mask::secret\npara two'" }]);
    restore();

    expect(lines).toEqual(["::error::row differs: 'para one%0A::add-mask::secret%0Apara two'"]);
  });

  test("a percent is escaped before what the escaping introduces", () => {
    const { lines, restore } = captureLog();

    notice("coverage fell to 80% \r\nof the floor");
    restore();

    expect(lines).toEqual(["::notice::coverage fell to 80%25 %0D%0Aof the floor"]);
  });
});
