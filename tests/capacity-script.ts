// Runs the shipped k6 ramp against a stub server, both ways round: with a hot
// path and without one. "It runs inside k6" is why the linter skips this
// script; it is not a reason for nothing to have executed it.
//
// A CI step rather than a bun test, because it needs the pinned k6 binary — CI
// fetches it through the same helper the gates use, and a developer runs this
// with K6 pointing at one.
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is unset — point it at the pinned k6 binary (CI fetches one before this runs)`,
    );
  }
  return value;
}

const k6 = requireEnv("K6");

const RAMP = new URL("../.github/actions/db-gate/capacity.js", import.meta.url).pathname;
const PORT = 58231;
const hits = new Map<string, number>();

const ANSWERS = new Set(["/api/health", "/api/things"]);

// Everything else 404s, which is what a mistyped capacity-path meets and what
// the ramp's failure threshold is there to refuse.
const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const { pathname } = new URL(request.url);
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    return ANSWERS.has(pathname)
      ? Response.json({ status: "ok" })
      : new Response("no such route", { status: 404 });
  },
});

// One short stage, because this proves the script's branches rather than the
// machine's throughput — the ramp shape is the action's business.
const STAGE = "--stage=2s:5";

interface Ramp {
  /** k6 exits 99 on a threshold it breached, which is the whole of the failure bound. */
  readonly exitCode: number;
  readonly metrics: Record<string, Record<string, number>>;
}

async function ramp(capacityPath: string | undefined, name: string): Promise<Ramp> {
  hits.clear();
  const out = join(tmpdir(), `capacity-${name}.json`);
  const proc = Bun.spawn([k6, "run", "--quiet", STAGE, "--summary-export", out, RAMP], {
    env: {
      PATH: requireEnv("PATH"),
      HEALTH_URL: `http://localhost:${PORT}/api/health`,
      ...(capacityPath === undefined ? {} : { CAPACITY_PATH: capacityPath }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const summary = (await Bun.file(out).json()) as {
    metrics: Record<string, Record<string, number>>;
  };
  await rm(out, { force: true });
  return { exitCode, metrics: summary.metrics };
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const health = await ramp("", "health");
expect((hits.get("/api/health") ?? 0) > 0, "the health route was never rammed");
expect(hits.size === 1, `only the health route should be hit, saw ${[...hits.keys()].join(", ")}`);
expect(health.exitCode === 0, "a ramp against a server that answers 200 did not exit 0");
expect(
  (health.metrics["checks"]?.["fails"] ?? 1) === 0,
  "a check failed against a server that answers everything",
);

// The variable is absent when a person runs this by hand, and the branch used
// to build a URL ending in the literal "undefined".
const absent = await ramp(undefined, "absent");
expect(
  hits.size === 1,
  `an absent CAPACITY_PATH must ramp the health route alone, saw ${[...hits.keys()].join(", ")}`,
);
expect(
  (absent.metrics["checks"]?.["fails"] ?? 1) === 0,
  "an absent CAPACITY_PATH produced a failing request",
);

const both = await ramp("/api/things", "hot");
expect(
  (hits.get("/api/health") ?? 0) > 0,
  "the health route was dropped when a hot path was given",
);
expect((hits.get("/api/things") ?? 0) > 0, "the hot path was never rammed — the branch is dead");
expect(both.exitCode === 0, "a ramp against two routes that answer 200 did not exit 0");
expect(
  (both.metrics["http_reqs"]?.["count"] ?? 0) > (health.metrics["http_reqs"]?.["count"] ?? 0) / 2,
  "the two-URL ramp made suspiciously few requests",
);

// A capacity-path with a typo in it: k6 keeps ramping, every check fails, and
// checks reach no exit code — the run is a clean exit carrying the throughput
// of a 404. The bound that refuses it lives in the step that reads the summary,
// so what this proves is the seam it reads across: the field the failures land
// in, and that they land there rather than in the exit code.
const typo = await ramp("/api/thigns", "typo");
expect(
  typo.exitCode === 0,
  `a ramp against a 404 exited ${typo.exitCode} — the shipped script declares no threshold, so the summary is what carries the failures`,
);
expect(
  (typo.metrics["http_req_failed"]?.["value"] ?? 0) > 0.1,
  "half the ramp's requests 404d and http_req_failed.value did not record it — the gate reads that field",
);

await server.stop(true);
console.log(`capacity.js: health-only and hot-path branches both executed (${hits.size} routes)`);
