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
// Truthiness, not a comparison against "": the variable is absent when this
// script is run by hand, and `origin + undefined` is a URL ending "undefined".
const hot = __ENV.CAPACITY_PATH ? origin + __ENV.CAPACITY_PATH : null;

export const options = {
  stages: [
    { duration: "20s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
};

export default function () {
  for (const url of hot === null ? [health] : [health, hot]) {
    const response = http.get(url);
    check(response, { "answers 2xx": (r) => r.status >= 200 && r.status < 300 });
  }
}
