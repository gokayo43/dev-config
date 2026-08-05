import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { inputs, notice, report } from "../.github/actions/_lib/gate.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  process.exitCode = 0;
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
});
