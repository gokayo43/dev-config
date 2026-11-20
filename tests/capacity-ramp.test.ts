import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { asyncProperty, constantFrom, integer } from "fast-check";

import {
  k6Home,
  MEASURED,
  NO_MEASUREMENT,
  pinnedK6,
  planFrom,
  ramp,
  type Result,
  RESULTS,
  WRONG_ARGUMENTS,
  WrongArguments,
} from "../capacity-ramp-ladder.ts";
import { check } from "../property.ts";
import { materialise, scratch } from "./tree.ts";

/**
 * The capacity ramp against a stub that breaks where the case says it does,
 * through the pinned k6 — the only target any case here points it at, on
 * loopback, on a port the system chose.
 *
 * The stub breaks on how many k6 connections are open, not on how many
 * requests are in flight: k6 holds one connection per simultaneous user for a
 * whole step, so that count is the step's users exactly whatever share of the
 * processor this box gives the run, where an in-flight count would depend on
 * how fast k6 got round its loop. A connection counts once it has carried a
 * request from k6, so the command's own health check is not a user.
 *
 * The holds are a second and the steps 1, 2 and 4 users, so a case runs in
 * seconds; the bounds sit far from what the stub answers on either side of its
 * breaking point, since the live services take this box's processors first.
 */

const ROOT = join(import.meta.dir, "..");
const PINNED = await pinnedK6(k6Home(process.env));

/** What the stub does past its breaking point: refuse, or answer far past the p95 bound. */
type Breaking = "errors" | "slow";

/** Fast is well under the p95 bound a case sets, slow is three times over it. */
const FAST_MS = 20;
const P95_BOUND_MS = 500;
const SLOW_MS = 1_500;

interface Stub extends AsyncDisposable {
  readonly health: string;
  readonly origin: string;
}

/** A target that answers fast while at most `users` k6 users are connected, and `breaking` past that. */
async function stub(users: number, breaking: Breaking): Promise<Stub> {
  const k6Sockets = new Set<Socket>();
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    const { socket } = request;
    if ((request.headers["user-agent"] ?? "").startsWith("Grafana k6") && !k6Sockets.has(socket)) {
      k6Sockets.add(socket);
      socket.once("close", () => k6Sockets.delete(socket));
    }
    const past = k6Sockets.size > users;
    if (past && breaking === "errors") {
      response.writeHead(503).end("over capacity");
      return;
    }
    // oxlint-disable-next-line anti-slop/no-real-timers -- the subject is k6 timing real responses; there is no virtual clock k6 reads
    setTimeout(
      () => {
        response.end("ok");
      },
      past ? SLOW_MS : FAST_MS,
    );
  };
  const server = createServer(answer);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the stub has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    health: `${origin}/health`,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const SMALL = ["--start-users", "1", "--max-users", "4", "--hold", "1s"];

function planOf(health: string, ...more: string[]) {
  return planFrom(["--health", health, ...SMALL, "--max-p95", `${P95_BOUND_MS}ms`, ...more]);
}

async function rampOf(health: string, root: string, ...more: string[]): Promise<Result> {
  const outcome = await ramp(
    planOf(health, ...more),
    {
      k6: PINNED.k6,
      k6Version: PINNED.version,
      log: () => {},
      signal: new AbortController().signal,
    },
    root,
  );
  if ("unmeasured" in outcome) throw new Error(`no measurement: ${outcome.unmeasured}`);
  return outcome.result;
}

describe("what the command reads off its command line", () => {
  test("doubles from the first step and ends on the maximum itself", () => {
    expect(planFrom(["--health", "http://127.0.0.1:1/h"]).steps).toEqual([
      10, 20, 40, 80, 160, 320,
    ]);
    expect(planFrom(["--health", "http://127.0.0.1:1/h", "--max-users", "100"]).steps).toEqual([
      10, 20, 40, 80, 100,
    ]);
  });

  test("the defaults are the page's: 30s a step, 1% failed, a p95 of a second", () => {
    expect(planFrom(["--health", "http://127.0.0.1:1/h"])).toMatchObject({
      holdMs: 30_000,
      bounds: { failed: 0.01, p95Ms: 1000 },
      paths: [],
      script: null,
    });
  });

  // The target is always stated: nothing here reads a workflow for it.
  test.each([
    [[], "--health is required"],
    [["--health", "localhost:3000"], "it takes an http or https address"],
    [["--health", "http://x/h", "--path", "api/things"], "does not start with /"],
    [
      ["--health", "http://x/h", "--start-users", "40", "--max-users", "20"],
      "is above --max-users",
    ],
    [["--health", "http://x/h", "--max-users", "0"], "a whole number of users"],
    [["--health", "http://x/h", "--hold", "30"], "write a duration"],
    [["--health", "http://x/h", "--max-failed", "0.01"], "write a percentage"],
    [["--health", "http://x/h", "--users", "5"], "Unknown option"],
  ])("refuses %j", (args, said) => {
    expect(() => planFrom(args)).toThrow(WrongArguments);
    expect(() => planFrom(args)).toThrow(said);
  });
});

describe("the ceiling it finds", () => {
  // Invariant 3: a held step at or below where the target breaks, a broken
  // step above it, and the bound named. Breaking at 0 is the first step
  // breaking, and at 4 or more is every step held. The likeliest wrong ladders
  // are an off-by-one in which step counts as held, carrying on past a broken
  // step, and naming the wrong bound; each fails one of the expectations here.
  test("held at or below the breaking point, broken above it, and the bound that broke named", async () => {
    await check(
      asyncProperty(
        integer({ min: 0, max: 5 }),
        constantFrom<Breaking>("errors", "slow"),
        async (users, breaking) => {
          await using target = await stub(users, breaking);
          const result = await rampOf(target.health, await scratch());
          const held = [1, 2, 4].findLast((step) => step <= users) ?? null;
          const broke = [1, 2, 4].find((step) => step > users) ?? null;
          expect(result.held).toBe(held);
          expect(result.broke?.users ?? null).toBe(broke);
          expect(result.steps.map((step) => step.users)).toEqual(
            [1, 2, 4].filter((step) => step <= (broke ?? 4)),
          );
          expect(result.broke?.bounds ?? []).toEqual(
            broke === null ? [] : [breaking === "errors" ? "failed" : "p95"],
          );
        },
      ),
      {
        numRuns: 7,
        endOnFailure: true,
        // The edges every run covers, whatever the random draws: the first
        // step breaking, each bound breaking a later step, and none breaking.
        examples: [
          [0, "slow"],
          [1, "errors"],
          [2, "slow"],
          [5, "errors"],
        ],
      },
    );
  });

  // Where to start looking: every path it was given, slowest first, at the
  // step that decided the run.
  test("reports each path at the deciding step, slowest first", async () => {
    await using target = await stub(1, "slow");
    const result = await rampOf(
      target.health,
      await scratch(),
      "--path",
      "/things",
      "--path",
      "/other",
    );
    const deciding = result.steps.at(-1);
    expect(deciding?.users).toBe(2);
    expect(deciding?.paths.map((path) => `${path.method} ${path.name}`).toSorted()).toEqual([
      "GET /health",
      "GET /other",
      "GET /things",
    ]);
    const p95s = deciding?.paths.map((path) => path.p95Ms) ?? [];
    expect(p95s).toEqual(p95s.toSorted((a, b) => b - a));
  });
});

/** Runs the bin in `root`, as an agent at a terminal does, and answers what it said and left behind. */
async function command(root: string, args: readonly string[], until?: (stderr: string) => boolean) {
  const run = Bun.spawn(["bun", join(ROOT, "capacity-ramp.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  const reading = (async () => {
    for await (const chunk of run.stderr.pipeThrough(new TextDecoderStream())) {
      stderr += chunk;
      if (until?.(stderr) === true) run.kill("SIGTERM");
    }
  })();
  const [stdout, status] = await Promise.all([
    new Response(run.stdout).text(),
    run.exited,
    reading,
  ]);
  const written = await readdir(join(root, RESULTS)).catch(() => []);
  return { stdout, stderr, status, written: written.toSorted((a, b) => a.localeCompare(b)) };
}

/**
 * A result's fields, nested, without its values: an object as its keys, a list
 * as its first element's shape. `previous` is a value here, since a first run
 * has none and a second one does.
 */
type Shape = string | Shape[] | { readonly [key: string]: Shape };

function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) return [shapeOf(value[0])];
  if (typeof value !== "object" || value === null) return typeof value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]): [string, Shape] => [
      key,
      key === "previous" ? "previous" : shapeOf(field),
    ]),
  );
}

describe("what the command leaves behind", () => {
  test("is the package's capacity-ramp bin, and ships with what it runs", async () => {
    const manifest: unknown = await Bun.file(join(ROOT, "package.json")).json();
    expect(manifest).toMatchObject({ bin: { "capacity-ramp": "./capacity-ramp.ts" } });
    expect(manifest).toHaveProperty(
      "files",
      expect.arrayContaining([
        "capacity-ramp.ts",
        "capacity-ramp-ladder.ts",
        "capacity-ramp.js",
        ".github/actions/_lib/k6.sh",
        ".github/actions/_lib/pinned-tool.sh",
      ]),
    );
  });

  // Invariant 5: the same fields and the same table every run, and a second
  // run of the same measurement names the first one's held step. The wrong
  // implementations are a lookup that never finds its predecessor, one that
  // finds a run of another target, and a file whose shape depends on the run.
  test("two runs of one measurement: the same shape, and the second names the first", async () => {
    await using target = await stub(2, "errors");
    const root = await materialise({});
    const args = ["--health", target.health, ...SMALL, "--max-p95", `${P95_BOUND_MS}ms`];
    const first = await command(root, args);
    expect(first.status).toBe(MEASURED);
    expect(first.stdout).toContain("- Previous run: none for this target");
    await using other = await stub(4, "errors");
    const elsewhere = await command(root, ["--health", other.health, ...args.slice(2)]);
    expect(elsewhere.stdout).toContain("- Previous run: none for this target");
    const second = await command(root, args);
    expect(second.status).toBe(MEASURED);

    const jsons = second.written.filter((name) => name.endsWith(".json"));
    expect(second.written).toHaveLength(6);
    const [firstJson = "", , secondJson = ""] = jsons;
    expect(second.stdout).toContain(`- Previous run: 2 users held, in ${RESULTS}/${firstJson}`);
    expect(second.stdout).toContain(`Written: ${join(root, RESULTS, secondJson)}`);

    const a: unknown = await Bun.file(join(root, RESULTS, firstJson)).json();
    const b: unknown = await Bun.file(join(root, RESULTS, secondJson)).json();
    expect(a).toMatchObject({ held: 2, previous: null });
    expect(b).toMatchObject({ held: 2, previous: { file: `${RESULTS}/${firstJson}`, held: 2 } });
    expect(shapeOf(b)).toEqual(shapeOf(a));

    // Every line but the values: the headings, the list's labels and the
    // tables' heads.
    const form = async (name: string): Promise<string[]> =>
      (await Bun.file(join(root, RESULTS, name.replace(".json", ".md"))).text())
        .split("\n")
        .filter((line) => /^(## |- |\| (Users|Path|---) )/u.test(line))
        .map((line) =>
          line.replace(/:.*$/u, "").replace(/^## Slowest paths at .*/u, "## Slowest paths"),
        );
    expect(await form(secondJson)).toEqual(await form(firstJson));
  });

  // Invariant 4: no measurement is never reported as one. Each exits 1 with
  // its reason and leaves no result; the wrong implementation writes what it
  // had, or reports the steps it finished as a held step.
  test("a health address that does not answer is no measurement", async () => {
    const target = await stub(1, "errors");
    const health = target.health;
    await target[Symbol.asyncDispose]();
    const root = await materialise({});
    const { status, stderr, written } = await command(root, ["--health", health, ...SMALL]);
    expect(status).toBe(NO_MEASUREMENT);
    expect(stderr).toContain(`no measurement, so no result was written. ${health} did not answer`);
    expect(written).toEqual([]);
  });

  test("a script that sends no request is no measurement", async () => {
    await using target = await stub(4, "errors");
    const root = await materialise({
      "idle.js": 'import { sleep } from "k6";\nexport default function () { sleep(0.2); }\n',
    });
    const { status, stderr, written } = await command(root, [
      "--health",
      target.health,
      "--script",
      "idle.js",
      ...SMALL,
    ]);
    expect(status).toBe(NO_MEASUREMENT);
    expect(stderr).toContain("k6 recorded no request in the step of 1 users");
    expect(written).toEqual([]);
  });

  test("a run stopped before its last step finished is no measurement", async () => {
    await using target = await stub(4, "errors");
    const root = await materialise({});
    const { status, stderr, written } = await command(
      root,
      ["--health", target.health, "--start-users", "1", "--max-users", "4", "--hold", "20s"],
      (said) => said.includes("step 1 of 3"),
    );
    expect(status).toBe(NO_MEASUREMENT);
    expect(stderr).toContain("the run was stopped during the step of 1 users");
    expect(written).toEqual([]);
  });

  // One owner of the steps: a script that sets its own would make the ladder
  // mean nothing, so it is refused by name before a request is sent.
  test("a script that sets steps of its own is refused by name", async () => {
    await using target = await stub(4, "errors");
    const root = await materialise({
      "staged.js":
        'import http from "k6/http";\nexport const options = { stages: [{ duration: "1s", target: 2 }] };\nexport default function () { http.get(__ENV.HEALTH_URL); }\n',
    });
    const { status, stderr, written } = await command(root, [
      "--health",
      target.health,
      "--script",
      "staged.js",
      ...SMALL,
    ]);
    expect(status).toBe(WRONG_ARGUMENTS);
    expect(stderr).toContain("--script staged.js sets stages");
    expect(stderr).not.toContain("about to hit");
    expect(written).toEqual([]);
  });

  test("arguments it cannot read exit 2 with the usage", async () => {
    const root = await materialise({});
    const { status, stderr } = await command(root, ["--health", "localhost"]);
    expect(status).toBe(WRONG_ARGUMENTS);
    expect(stderr).toContain("capacity-ramp --health <url>");
  });
});

describe("CI runs no ramp", () => {
  // Invariant 1: the ramp left CI. The reusable workflow and every action it
  // calls are read for the k6 loader; the loader itself is the command's.
  test("no job of check.yml, and no action it calls, loads k6", async () => {
    const workflow = await Bun.file(join(ROOT, ".github/workflows/check.yml")).text();
    const called = [...workflow.matchAll(/dev-config\/\.github\/actions\/([\w-]+)@/gu)].map(
      ([, name]) => name ?? "",
    );
    expect(called).toContain("db-gate");
    expect(workflow).not.toMatch(/k6/iu);
    for (const action of new Set(called)) {
      const directory = join(ROOT, ".github/actions", action);
      for (const file of await readdir(directory)) {
        expect(`${action}/${file}: ${await Bun.file(join(directory, file)).text()}`).not.toMatch(
          /k6\.sh|\$K6\b/u,
        );
      }
    }
  });
});
