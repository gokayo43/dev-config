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

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const { pathname } = new URL(request.url);
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    return Response.json({ status: "ok" });
  },
});

// One short stage, because this proves the script's branches rather than the
// machine's throughput — the ramp shape is the action's business.
const STAGE = "--stage=2s:5";

async function ramp(
  capacityPath: string | undefined,
): Promise<Record<string, Record<string, number>>> {
  hits.clear();
  const out = join(
    tmpdir(),
    `capacity-${capacityPath === undefined ? "absent" : capacityPath === "" ? "health" : "hot"}.json`,
  );
  const proc = Bun.spawn([k6, "run", "--quiet", STAGE, "--summary-export", out, RAMP], {
    env: {
      PATH: requireEnv("PATH"),
      HEALTH_URL: `http://localhost:${PORT}/api/health`,
      ...(capacityPath === undefined ? {} : { CAPACITY_PATH: capacityPath }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`k6 failed: ${await new Response(proc.stderr).text()}`);
  }
  const summary = (await Bun.file(out).json()) as {
    metrics: Record<string, Record<string, number>>;
  };
  await rm(out, { force: true });
  return summary.metrics;
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const health = await ramp("");
expect((hits.get("/api/health") ?? 0) > 0, "the health route was never rammed");
expect(hits.size === 1, `only the health route should be hit, saw ${[...hits.keys()].join(", ")}`);
expect(
  (health["checks"]?.["fails"] ?? 1) === 0,
  "a check failed against a server that answers everything",
);

// The variable is absent when a person runs this by hand, and the branch used
// to build a URL ending in the literal "undefined".
const absent = await ramp(undefined);
expect(
  hits.size === 1,
  `an absent CAPACITY_PATH must ramp the health route alone, saw ${[...hits.keys()].join(", ")}`,
);
expect(
  (absent["checks"]?.["fails"] ?? 1) === 0,
  "an absent CAPACITY_PATH produced a failing request",
);

const both = await ramp("/api/things");
expect(
  (hits.get("/api/health") ?? 0) > 0,
  "the health route was dropped when a hot path was given",
);
expect((hits.get("/api/things") ?? 0) > 0, "the hot path was never rammed — the branch is dead");
expect(
  (both["http_reqs"]?.["count"] ?? 0) > (health["http_reqs"]?.["count"] ?? 0) / 2,
  "the two-URL ramp made suspiciously few requests",
);

await server.stop(true);
console.log(`capacity.js: health-only and hot-path branches both executed (${hits.size} routes)`);
