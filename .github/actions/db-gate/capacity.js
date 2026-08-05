// The default ramp. A repo with a hotter path than its health route points
// `capacity-script` at its own file instead; this one exists so that turning
// the gate on costs one input rather than a k6 script nobody has written yet.
//
// Deliberately no latency threshold: on a shared CI runner a latency bound is a
// coin toss, and a gate people disable is worse than a number people read. The
// numbers go to the summary; the one bound below is the one that is not the
// runner's to fail.
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
  // A request the app refused is refused on any machine, so this bound says
  // nothing about the runner. Checks do not reach the exit code, so without it
  // a mistyped capacity-path ramps a 404 route and publishes the throughput of
  // the error page as the measurement.
  thresholds: { http_req_failed: ["rate<0.10"] },
};

export default function () {
  for (const url of hot === null ? [health] : [health, hot]) {
    const response = http.get(url);
    check(response, { "answers 2xx": (r) => r.status >= 200 && r.status < 300 });
  }
}
