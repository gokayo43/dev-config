import { describe, expect, test } from "bun:test";

import { composeLint } from "../.github/actions/compose-lint/compose-lint.ts";

const FILE = "docker-compose.yml";

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
    x-no-healthcheck: a one-shot job that exits; it never reaches a steady state to probe

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

function lint(text: string): string[] {
  return composeLint(FILE, text).map(({ message }) => message);
}

describe("compose lint", () => {
  test("the deployment shape passes", () => {
    expect(lint(CLEAN)).toEqual([]);
  });

  test("a port on every interface is refused", () => {
    expect(lint(CLEAN.replace('"127.0.0.1:5180:3000"', '"5180:3000"'))).toEqual([
      expect.stringContaining("web publishes"),
    ]);
  });

  test("the long port form is read too", () => {
    const long = CLEAN.replace(
      '      - "127.0.0.1:5180:3000"',
      "      - target: 3000\n        published: 5180\n        host_ip: 0.0.0.0",
    );
    expect(lint(long)).toEqual([expect.stringContaining("web publishes")]);
  });

  test("a service with no memory cap is refused", () => {
    expect(lint(CLEAN.replace("    mem_limit: 1g\n", ""))).toEqual([
      expect.stringContaining("web has no mem_limit"),
    ]);
  });

  test("a service with no healthcheck and no reason is refused", () => {
    const stripped = CLEAN.replace(
      "    x-no-healthcheck: a one-shot job that exits; it never reaches a steady state to probe\n",
      "",
    );
    expect(lint(stripped)).toEqual([expect.stringContaining("migrate has no healthcheck")]);
  });

  test("an empty opt-out reason does not count as one", () => {
    expect(lint(CLEAN.replace(/x-no-healthcheck: .*/, 'x-no-healthcheck: ""'))).toEqual([
      expect.stringContaining("migrate has no healthcheck"),
    ]);
  });

  test("a compose file with no migrate service is refused", () => {
    const withoutMigrate = CLEAN.replace(/ {2}migrate:[\s\S]*?\n\n/, "").replace(
      "      migrate:\n        condition: service_completed_successfully\n",
      "",
    );
    expect(lint(withoutMigrate)).toEqual([
      expect.stringContaining("no migrate service"),
      expect.stringContaining("web must depend_on migrate"),
    ]);
  });

  test("a migrate service that restarts is refused", () => {
    expect(lint(CLEAN.replace('restart: "no"', "restart: unless-stopped"))).toEqual([
      expect.stringContaining("restart:"),
    ]);
  });

  test("an app service that does not wait for the migration is refused", () => {
    expect(
      lint(CLEAN.replace("      migrate:\n        condition: service_completed_successfully\n", "")),
    ).toEqual([expect.stringContaining("web must depend_on migrate")]);
  });

  test("the short depends_on form carries no condition, so it does not satisfy the wait", () => {
    const short = CLEAN.replace(
      "    depends_on:\n      postgres:\n        condition: service_healthy\n      migrate:\n        condition: service_completed_successfully\n",
      "    depends_on:\n      - postgres\n      - migrate\n",
    );
    expect(lint(short)).toEqual([expect.stringContaining("web must depend_on migrate")]);
  });

  test("an image-only service is infrastructure, not something the migration gates", () => {
    // postgres has no `build` and is not asked to wait on the migration it hosts.
    expect(lint(CLEAN)).toEqual([]);
  });
});
