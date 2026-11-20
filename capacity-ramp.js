// The ramp capacity-ramp runs when the caller names paths rather than a script
// of its own. It runs inside k6, which resolves neither TypeScript nor Bun.
import http from "k6/http";
import exec from "k6/execution";

const health = __ENV.HEALTH_URL;
const origin = health.replace(/^(https?:\/\/[^/]+).*$/, "$1");

const targets = [{ url: health, name: health.slice(origin.length) || "/" }].concat(
  (__ENV.CAPACITY_PATH || "")
    .split("\n")
    .filter((path) => path !== "")
    .map((path) => ({ url: origin + path, name: path })),
);

// One request an iteration, each given CAPACITY_TIMEOUT to answer, which the
// command sets below the time k6 lets a step's last iterations run: so k6
// records every request this sends, answered or not, and a path that never
// answers is a failed request in its own row rather than one k6 cut off.
export default function () {
  const target = targets[exec.scenario.iterationInTest % targets.length];
  http.get(target.url, { tags: { name: target.name }, timeout: __ENV.CAPACITY_TIMEOUT });
}
