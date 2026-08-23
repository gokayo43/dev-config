import { describe, expect, test } from "bun:test";

import { isList, readConfig, record } from "../.github/actions/_lib/gate.ts";
import { composeLint, TEST_FILES } from "../.github/actions/compose-lint/compose-lint.ts";

import { containing } from "./matchers.ts";
import { materialise, type Tree } from "./tree.ts";

const FILE = "docker-compose.yml";

/** The test the clean fixture's waiver names, since the gate now reads it off disk. */
const WAIVER_TEST = "tests/migrate.test.ts";

const CLEAN = `name: clean

services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "127.0.0.1:5435:5432"
    mem_limit: 512m
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clean -d clean"]

  migrate:
    build:
      context: .
      target: deps
    command: ["bun", "run", "db:migrate"]
    mem_limit: 512m
    restart: "no"
    x-no-healthcheck: ${WAIVER_TEST} -- a one-shot job that exits; it never reaches a steady state to probe

  web:
    build:
      context: .
      target: runtime
    ports:
      - "127.0.0.1:5180:3000"
    mem_limit: 1g
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/')"]
`;

/**
 * The compose file inside a repository, because the healthcheck waiver names a
 * file in one. `beside` is whatever else the case needs on disk — the test a
 * waiver points at, or nothing where its absence is the subject.
 */
async function lint(text: string, beside: Tree = { [WAIVER_TEST]: "" }): Promise<string[]> {
  const root = await materialise(beside);
  return (await composeLint(root, FILE, text)).map(({ message }) => message);
}

/** The clean file with its healthcheck waiver replaced by whatever the case is about. */
function waiving(value: string): string {
  return CLEAN.replace(/x-no-healthcheck: .*/, `x-no-healthcheck: ${value}`);
}

describe("compose lint", () => {
  test("the deployment shape passes", async () => {
    expect(await lint(CLEAN)).toEqual([]);
  });

  test("a port on every interface is refused", async () => {
    expect(await lint(CLEAN.replace('"127.0.0.1:5180:3000"', '"5180:3000"'))).toEqual([
      containing("web publishes"),
    ]);
  });

  test("the long port form is read too", async () => {
    const long = CLEAN.replace(
      '      - "127.0.0.1:5180:3000"',
      "      - target: 3000\n        published: 5180\n        host_ip: 0.0.0.0",
    );
    expect(await lint(long)).toEqual([containing("web publishes")]);
  });

  test("a service with no memory cap is refused", async () => {
    expect(await lint(CLEAN.replace("    mem_limit: 1g\n", ""))).toEqual([
      containing("web has no mem_limit"),
    ]);
  });

  test("a service with no healthcheck and no waiver is refused", async () => {
    expect(await lint(CLEAN.replace(/ {4}x-no-healthcheck: .*\n/, ""))).toEqual([
      containing("migrate has no healthcheck"),
    ]);
  });

  test("an empty opt-out is no waiver", async () => {
    expect(await lint(waiving('""'))).toEqual([containing("migrate has no healthcheck")]);
  });

  // The waiver a quantlab review found: "the runtime exits the process on a
  // failure the loop cannot recover from" was false, and the gate took it
  // because it was a non-empty string. Prose names nothing a run can disagree
  // with; a path names something that either passes or does not.
  test("prose where a path belongs is refused", async () => {
    expect(
      await lint(
        waiving("the runtime exits the process on a failure the loop cannot recover from"),
      ),
    ).toEqual([containing("which is not a test")]);
  });

  test("a waiver naming a test that is not there is refused, naming what to write", async () => {
    const [message] = await lint(CLEAN, {});
    expect(message).toContain(
      `migrate's x-no-healthcheck names ${WAIVER_TEST}, which git does not list in this repo`,
    );
    expect(message).toContain("write that test and commit it");
  });

  // Every one of these was accepted while the check was `Bun.file(...).exists()`.
  // A file that is not a test, a file git is told to ignore, one under
  // node_modules and a path that walks out of the repository are all things the
  // filesystem has, and none of them is the test that asserts this.
  test.each([
    ["a file that is not a test", "README.md", { "README.md": "# hi\n" }, "which is not a test"],
    [
      "a test .gitignore covers",
      "scratch/local.test.ts",
      { ".gitignore": "scratch/\n", "scratch/local.test.ts": "" },
      "which git does not list",
    ],
    [
      "a test under node_modules",
      "node_modules/dep/dep.test.ts",
      { "node_modules/dep/dep.test.ts": "" },
      "which git does not list",
    ],
    ["a path out of the repository", "../../../etc/hostname", {}, "which is not a test"],
  ])("%s is refused", async (_, named, beside, said) => {
    // Reasoned, so that the rows about the path reach the checks about the path:
    // a waiver with no reason is refused before its path is ever looked up.
    expect(await lint(waiving(`${named} -- the loop exits the process`), beside)).toEqual([
      containing(said),
    ]);
  });

  // The definition of "a test" is oxlint.base.json's own test override rather
  // than a second opinion in the gate: the fleet lints by that list, and a
  // waiver graded against a different one would refuse a file every other tool
  // here calls a test.
  test("what counts as a test is the base's own list", async () => {
    // Through the gates' own reader, since the base is JSON with comments —
    // README asks for the reason for an override beside it.
    const base = record((await readConfig(".", "oxlint.base.json")).contents);
    const overrides = isList(base["overrides"]) ? base["overrides"] : [];
    const testOverride = overrides
      .map((entry) => record(entry)["files"])
      .filter(isList)
      .find((files) => files.includes("**/*.test.ts"));

    expect(testOverride).toEqual(TEST_FILES);
  });

  // The reason is not optional, for the reason it is not optional on any hatch
  // here: the test says the service cannot answer a probe, and the reason says
  // why that is the design rather than an omission. The diagnostic used to ask
  // for one and the gate used to take a bare path anyway.
  test("a path with no reason is refused", async () => {
    expect(await lint(waiving(WAIVER_TEST))).toEqual([
      containing(`names ${WAIVER_TEST} without saying why`),
    ]);
  });

  // `./x` and `x` are one path to everyone except git, which lists the second
  // spelling and only the second — so the first was being told the file it is
  // looking at is not in the repository.
  test("a path written from here is the same path", async () => {
    expect(await lint(waiving(`./${WAIVER_TEST} -- a one-shot job that exits`))).toEqual([]);
  });

  // The separator is the one every allowlist input here uses, so a reason
  // containing it is still one reason and the path is still the first field.
  test("only the first separator divides the waiver", async () => {
    expect(await lint(waiving(`${WAIVER_TEST} -- it -- really -- does exit`))).toEqual([]);
  });

  test("a compose file with no migrate service is refused", async () => {
    const withoutMigrate = CLEAN.replace(/ {2}migrate:[\s\S]*?\n\n/, "").replace(
      "      migrate:\n        condition: service_completed_successfully\n",
      "",
    );
    expect(await lint(withoutMigrate)).toEqual([
      containing("no migrate service"),
      containing("web must depend_on migrate"),
    ]);
  });

  test("a migrate service that restarts is refused", async () => {
    expect(await lint(CLEAN.replace('restart: "no"', "restart: unless-stopped"))).toEqual([
      containing("restart:"),
    ]);
  });

  test("an app service that does not wait for the migration is refused", async () => {
    expect(
      await lint(
        CLEAN.replace("      migrate:\n        condition: service_completed_successfully\n", ""),
      ),
    ).toEqual([containing("web must depend_on migrate")]);
  });

  test("the short depends_on form carries no condition, so it does not satisfy the wait", async () => {
    const short = CLEAN.replace(
      "    depends_on:\n      postgres:\n        condition: service_healthy\n      migrate:\n        condition: service_completed_successfully\n",
      "    depends_on:\n      - postgres\n      - migrate\n",
    );
    expect(await lint(short)).toEqual([containing("web must depend_on migrate")]);
  });

  // Compose drops the ports key for a host-networked service without a word,
  // so the loopback rule above has nothing left to check.
  test("a host-networked service is refused", async () => {
    const host = CLEAN.replace('      - "127.0.0.1:5180:3000"', "    network_mode: host").replace(
      "    ports:\n",
      "",
    );
    expect(await lint(host)).toEqual([containing("web runs with network_mode: host")]);
  });

  test("a host-networked service with a reasoned opt-out passes", async () => {
    const host = CLEAN.replace(
      '      - "127.0.0.1:5180:3000"',
      "    network_mode: host\n    x-host-network: the ingest listener needs the host stack for PROXY protocol",
    ).replace("    ports:\n", "");
    expect(await lint(host)).toEqual([]);
  });

  test("an image-only service is infrastructure, not something the migration gates", async () => {
    // postgres has no `build`, so it is not asked to wait on the migration it
    // hosts; give it one and the rule would fire on a circular dependency.
    const building = CLEAN.replace(
      "  postgres:\n    image: postgres:16-alpine\n",
      "  postgres:\n    build:\n      context: ./db\n",
    );
    expect(await lint(building)).toEqual([containing("postgres must depend_on migrate")]);
  });
});
