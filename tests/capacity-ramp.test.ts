import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { asyncProperty, constantFrom, integer } from "fast-check";

import {
  markdownOf,
  MEASURED,
  type Measurement,
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
 * The stub breaks on how many k6 connections are in use, not on how many
 * requests are in flight: k6 holds one connection per simultaneous user for a
 * whole step, so that count is the step's users exactly whatever share of the
 * processor this box gives the run, where an in-flight count would depend on
 * how fast k6 got round its loop. In use means it has carried a request since
 * the newest k6 connection opened, which is an order and not a time: each step
 * is a k6 process of its own, which opens its connections as it starts and
 * sends nothing on the last step's, so a connection of a step that has ended
 * is never counted in the next. Counting the connections the stub still holds
 * open instead counted them: on a box that starves the stub's process, the
 * end of the last step's connections reaches it after the next step's first
 * requests. Only k6's requests count, so the command's own health check is not
 * a user.
 *
 * The holds are a second and the steps 1, 2 and 4 users, so a case runs in
 * seconds. Every time k6 measures includes however long the box took to
 * schedule the stub and k6, which on a box whose live services take the
 * processors first is a hundred milliseconds or more on any request it stalls,
 * and a p95 over a step this short is one of its few slowest requests. So a
 * case asserts no gap between two measured times: where its subject is failed
 * requests, the p95 bound is out of reach, and where it is the p95 bound, the
 * stub's slow answers sit above it whatever is added to them. Only a fast
 * answer can be pushed across that bound, so the bound sits just under a slow
 * answer and a second above a fast one: steps of a second at 4% of one core
 * measured a p95 of up to 200 ms on fast answers, and a bound of 500 ms broke a
 * step that held once in ten runs of this file there.
 */

const ROOT = join(import.meta.dir, "..");
const PINNED = await pinnedK6(process.env, new AbortController().signal);

/** What the stub does past its breaking point: refuse, or answer far past the p95 bound. */
type Breaking = "errors" | "slow";

/** Slow is over the p95 bound a case sets by any margin at all, and fast is far under it. */
const FAST_MS = 20;
const P95_BOUND = "1s";
const SLOW_MS = 1_100;
const SLOW_PATH_MS = 150;

/**
 * The shipped script gives a request 30 seconds to answer and the command
 * counts a request k6 cut off as lasting 35, so no step's p95 is above this.
 */
const UNREACHABLE_P95 = "60s";

interface Stub extends AsyncDisposable {
  readonly health: string;
  readonly origin: string;
}

/**
 * A target that answers fast while at most `users` k6 connections are in use,
 * and `breaking` past that. `slowPath`, where it is given, always answers in
 * `SLOW_PATH_MS`, under the p95 bound, so it is the slowest path without
 * breaking a step; `hangPath` never answers at all.
 */
async function stub(
  users: number,
  breaking: Breaking,
  { slowPath, hangPath }: { slowPath?: string; hangPath?: string } = {},
): Promise<Stub> {
  /** Each k6 connection's latest request, by its place in the order the stub took requests. */
  const latest = new Map<Socket, number>();
  let taken = 0;
  /** The place of the first request on the newest k6 connection. */
  let newest = 0;
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url === hangPath) return;
    const { socket } = request;
    const place = ++taken;
    if ((request.headers["user-agent"] ?? "").startsWith("Grafana k6")) {
      if (!latest.has(socket)) {
        newest = place;
        socket.once("close", () => latest.delete(socket));
      }
      latest.set(socket, place);
    }
    const past = [...latest.values()].filter((at) => at >= newest).length > users;
    if (past && breaking === "errors") {
      response.writeHead(503).end("over capacity");
      return;
    }
    // oxlint-disable-next-line anti-slop/no-real-timers -- the subject is k6 timing real responses; there is no virtual clock k6 reads
    setTimeout(
      () => {
        response.end("ok");
      },
      past ? SLOW_MS : request.url === slowPath ? SLOW_PATH_MS : FAST_MS,
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

/** A run of the ladder in `root`, with what it said on the way: `more` comes after `SMALL`, so it can narrow the ladder. */
async function rampLogged(
  health: string,
  root: string,
  ...more: string[]
): Promise<{ result: Result; said: string[] }> {
  const said: string[] = [];
  const result = await ramp(
    planFrom(["--health", health, ...SMALL, ...more], root),
    {
      k6: PINNED.k6,
      k6Version: PINNED.version,
      log: (line) => {
        said.push(line);
      },
      signal: new AbortController().signal,
    },
    root,
  );
  return { result, said };
}

async function rampOf(health: string, root: string, ...more: string[]): Promise<Result> {
  return (await rampLogged(health, root, ...more)).result;
}

describe("what the command reads off its command line", () => {
  test("doubles from the first step and ends on the maximum itself", () => {
    expect(planFrom(["--health", "http://127.0.0.1:1/h"], ROOT).steps).toEqual([
      10, 20, 40, 80, 160, 320,
    ]);
    expect(
      planFrom(["--health", "http://127.0.0.1:1/h", "--max-users", "100"], ROOT).steps,
    ).toEqual([10, 20, 40, 80, 100]);
    expect(
      planFrom(["--health", "http://127.0.0.1:1/h", "--start-users", "5", "--max-users", "5"], ROOT)
        .steps,
    ).toEqual([5]);
  });

  test("the defaults are the page's: 30s a step, 1% failed, a p95 of a second", () => {
    expect(planFrom(["--health", "http://127.0.0.1:1/h"], ROOT)).toMatchObject({
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
    // Logic 3: k6 refuses a step under a second, which used to surface as no
    // measurement once the health check had passed.
    [["--health", "http://x/h", "--hold", "500ms"], "k6 holds a step for 1s at the least"],
    [["--health", "http://x/h", "--max-failed", "0.01"], "write a percentage"],
    [["--health", "http://x/h", "--users", "5"], "Unknown option"],
  ])("refuses %j", (args, said) => {
    expect(() => planFrom(args, ROOT)).toThrow(WrongArguments);
    expect(() => planFrom(args, ROOT)).toThrow(said);
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
          const result = await rampOf(
            target.health,
            await scratch(),
            "--max-p95",
            breaking === "slow" ? P95_BOUND : UNREACHABLE_P95,
          );
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
  // step that decided the run. Which path k6 measured slowest is the box's to
  // decide as much as the stub's, so the order is read off the measurements:
  // the likeliest wrong report, in the order the paths were first requested,
  // puts the health address above the path the stub always holds back.
  test("reports each path at the deciding step, slowest first", async () => {
    await using target = await stub(4, "errors", { slowPath: "/things" });
    const result = await rampOf(
      target.health,
      await scratch(),
      "--max-p95",
      UNREACHABLE_P95,
      "--path",
      "/things",
      "--path",
      "/other",
    );
    expect(result.held).toBe(4);
    const deciding = result.steps.at(-1);
    expect(deciding?.users).toBe(4);
    const paths = deciding?.paths ?? [];
    expect(paths.map((path) => path.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "/health",
      "/other",
      "/things",
    ]);
    expect(paths.map((path) => path.p95Ms)).toEqual(
      paths.map((path) => path.p95Ms).toSorted((a, b) => b - a),
    );
    expect(paths.find((path) => path.name === "/things")?.p95Ms).toBeGreaterThanOrEqual(
      SLOW_PATH_MS,
    );
    const table = markdownOf(result).split("## Slowest paths at 4 users")[1] ?? "";
    expect(
      table
        .split("\n")
        .filter((line) => line.startsWith("| GET "))
        .map((line) => line.split(" | ")[0]),
    ).toEqual(paths.map((path) => `| GET ${path.name}`));
  });
});

describe("a request that never answers", () => {
  // Logic 1: k6 records nothing of a request still running when it ends a
  // step, so a path that never answered vanished from the result and its step
  // read as held. The likeliest wrong ramps are that one and one that lets k6
  // cut the request off with the step; either leaves the path out of the
  // deciding step's rows and the step held. The path is `//hang` so that the
  // address announced is checked against the one hit (logic 8), and the run's
  // length against the bound announced (logic 6).
  test("is a failed request in its path's row, and breaks the step", async () => {
    await using target = await stub(4, "errors", { hangPath: "//hang" });
    const begun = performance.now();
    const { result, said } = await rampLogged(
      target.health,
      await scratch(),
      "--max-users",
      "1",
      "--max-p95",
      UNREACHABLE_P95,
      "--path",
      "//hang",
    );
    const tookS = (performance.now() - begun) / 1000;
    expect(result.held).toBeNull();
    expect(result.broke).toEqual({ users: 1, bounds: ["failed"] });
    expect(result.steps[0].paths.find((path) => path.name === "//hang")?.failed).toBe(1);
    expect(result.steps[0].failures["0"]).toBeGreaterThan(0);
    const announced = said.join("\n");
    expect(announced).toContain(`about to hit ${target.health}, ${target.origin}//hang`);
    expect(tookS).toBeLessThan(Number(/up to (\d+)s of load/u.exec(announced)?.[1]));
  });

  // Logic 1, second half: a repo's script whose requests carry k6's own
  // 60-second timeout outlives the step's grace, and every request it sent is
  // cut off. That was "no measurement", the held steps thrown away; it is the
  // ceiling, and a step broken on failed requests.
  test("cut off with the step, every request of a script is a broken step, not no measurement", async () => {
    await using target = await stub(4, "errors", { hangPath: "/never" });
    const root = await materialise({
      "never.js":
        'import http from "k6/http";\nexport default function () { http.get(__ENV.HEALTH_URL.replace(/\\/health$/, "/never")); }\n',
    });
    const result = await rampOf(
      target.health,
      root,
      "--max-users",
      "1",
      "--max-p95",
      UNREACHABLE_P95,
      "--script",
      "never.js",
    );
    expect(result.held).toBeNull();
    expect(result.broke).toEqual({ users: 1, bounds: ["failed"] });
    expect(result.steps[0]).toMatchObject({ requests: 1, failed: 1, cutOff: 1 });
  });
});

/**
 * Runs the bin as an agent at a terminal does, in `root` or in the directory
 * of it named by `from`, and answers what it said and left behind. `until`
 * stops it as Ctrl-C would, once its progress says so.
 */
async function command(
  root: string,
  args: readonly string[],
  { until, from = "" }: { until?: (stderr: string) => boolean; from?: string } = {},
) {
  const run = Bun.spawn(["bun", join(ROOT, "capacity-ramp.ts"), ...args], {
    cwd: join(root, from),
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
    const args = ["--health", target.health, ...SMALL, "--max-p95", UNREACHABLE_P95];
    const first = await command(root, args);
    expect(first.status).toBe(MEASURED);
    expect(first.stdout).toContain("- Previous run: none of this measurement");
    await using other = await stub(4, "errors");
    const elsewhere = await command(root, ["--health", other.health, ...args.slice(2)]);
    expect(elsewhere.stdout).toContain("- Previous run: none of this measurement");
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
      { until: (said) => said.includes("step 1 of 3") },
    );
    expect(status).toBe(NO_MEASUREMENT);
    expect(stderr).toContain("the run was stopped during the step of 1 users");
    expect(written).toEqual([]);
  });

  // One owner of the steps: a script that sets its own would make the ladder
  // mean nothing, so it is refused by name before a request is sent. Run from
  // a package's directory, as in a monorepo, the script is the one beside the
  // agent: a path read from the repository root instead is a script k6 cannot
  // find, refused for a reason that is not this one.
  test("a script that sets steps of its own is refused by name", async () => {
    await using target = await stub(4, "errors");
    const root = await materialise({
      "api/staged.js":
        'import http from "k6/http";\nexport const options = { stages: [{ duration: "1s", target: 2 }] };\nexport default function () { http.get(__ENV.HEALTH_URL); }\n',
    });
    const { status, stderr, written } = await command(
      root,
      ["--health", target.health, "--script", "staged.js", ...SMALL],
      { from: "api" },
    );
    expect(status).toBe(WRONG_ARGUMENTS);
    expect(stderr).toContain("--script api/staged.js sets stages");
    expect(stderr).not.toContain("about to hit");
    expect(written).toEqual([]);
  });

  // Coherence 1 and failure 2: a held step is compared only with one of the
  // same measurement, and nothing in `capacity/` that cannot be read as one
  // stops the run. Each decoy is later than the run it must name and differs
  // from it in one field, so a lookup leaving that field out of the identity
  // names the decoy; the file that does not parse, the marked file of an older
  // shape and the file cut short each threw once the whole ramp had run.
  test("the previous run is the latest of the same measurement, and nothing else there stops the run", async () => {
    await using target = await stub(4, "errors");
    const same: Measurement = {
      k6: PINNED.version,
      health: target.health,
      paths: [],
      script: null,
      steps: [1],
      holdMs: 1000,
      bounds: { failed: 0.01, p95Ms: 60_000 },
    };
    const resultOf = (held: number, measurement: Measurement): string =>
      JSON.stringify({ tool: "capacity-ramp", startedAt: "", measurement, held });
    const decoys = [
      { ...same, k6: "v0.0.1" },
      { ...same, health: `${target.origin}/other` },
      { ...same, paths: ["/things"] },
      { ...same, script: "ramp.js" },
      { ...same, steps: [1, 2] },
      { ...same, holdMs: 2000 },
      { ...same, bounds: { failed: 0.02, p95Ms: 60_000 } },
    ];
    const root = await materialise({
      [`${RESULTS}/20260101T000000.000Z.json`]: resultOf(1, same),
      ...Object.fromEntries(
        decoys.map((decoy, at) => [`${RESULTS}/20260102T00000${at}.000Z.json`, resultOf(7, decoy)]),
      ),
      [`${RESULTS}/20260201T000000.000Z.json`]: "// another tool's\n{}\n",
      [`${RESULTS}/20260202T000000.000Z.json`]: JSON.stringify({ tool: "capacity-ramp", held: 10 }),
      [`${RESULTS}/20260203T000000.000Z.json`]: '{"tool":"capacity-ramp","measurement":',
    });
    const result = await rampOf(
      target.health,
      root,
      "--max-users",
      "1",
      "--max-p95",
      UNREACHABLE_P95,
    );
    expect(result.previous).toEqual({ file: `${RESULTS}/20260101T000000.000Z.json`, held: 1 });
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
