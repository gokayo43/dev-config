// The ramp capacity-ramp runs when the caller names paths rather than a script
// of its own. It runs inside k6, which resolves neither TypeScript nor Bun.
import http from "k6/http";

const health = __ENV.HEALTH_URL;
const origin = health.replace(/^(https?:\/\/[^/]+).*$/, "$1");

const targets = [{ url: health, name: health.slice(origin.length) || "/" }].concat(
  (__ENV.CAPACITY_PATH || "")
    .split("\n")
    .filter((path) => path !== "")
    .map((path) => ({ url: origin + path, name: path })),
);

export default function () {
  for (const target of targets) {
    http.get(target.url, { tags: { name: target.name } });
  }
}
