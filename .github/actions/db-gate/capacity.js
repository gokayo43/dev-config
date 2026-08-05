// The default ramp. A repo with a hotter path than its health route points
// `capacity-script` at its own file instead; this one exists so that turning
// the gate on costs one input rather than a k6 script nobody has written yet.
//
// Deliberately no thresholds: on a shared CI runner a latency bound is a coin
// toss, and a gate people disable is worse than a number people read. The step
// that runs this asserts a measurement happened; the numbers go to the summary.
import http from "k6/http";
import { check } from "k6";

const health = __ENV.HEALTH_URL;
const origin = health.replace(/^(https?:\/\/[^/]+).*$/, "$1");
const hot = __ENV.CAPACITY_PATH === "" ? null : origin + __ENV.CAPACITY_PATH;

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
