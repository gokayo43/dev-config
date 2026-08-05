// The default ramp. A repo with a hotter path than its health route points
// `capacity-script` at its own file instead; this one exists so that turning
// the gate on costs one input rather than a k6 script nobody has written yet.
//
// Deliberately no thresholds: on a shared CI runner a latency bound is a coin
// toss, and a gate people disable is worse than a number people read. The one
// bound that is not the runner's — the share of requests the app refused — is
// held by the step that reads the summary, so that it binds a repo ramping with
// a script of its own too. See docs/gates/capacity.md.
import http from "k6/http";
import { check } from "k6";

const health = __ENV.HEALTH_URL;
const origin = health.replace(/^(https?:\/\/[^/]+).*$/, "$1");

// The same comma-or-newline list every allowlist input in this repo is written
// in — split here rather than imported from _lib/gate.ts, because this file is
// the one k6 runs and k6 resolves neither TypeScript nor Bun. Truthiness, not a
// comparison against "": the variable is absent when the script is run by hand,
// and `origin + undefined` is a URL ending "undefined".
const paths = (__ENV.CAPACITY_PATH || "")
  .split(/[,\n]/)
  .map((path) => path.trim())
  .filter((path) => path !== "");

// Every path the caller named, alongside the health route: an app serves more
// than one route, and a ramp that reaches one of them is what the route floor
// exists to refuse.
const urls = [health].concat(paths.map((path) => origin + path));

export const options = {
  stages: [
    { duration: "20s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
};

export default function () {
  for (const url of urls) {
    const response = http.get(url);
    check(response, { "answers 2xx": (r) => r.status >= 200 && r.status < 300 });
  }
}
