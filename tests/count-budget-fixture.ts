/**
 * The pages the count budget is driven over, the React app among them, and the
 * Playwright runs that drive it.
 *
 * The app is built once per suite, in memory, for production: React calls the
 * DevTools hook on a production build too, and a development build commits and
 * mutates differently enough that counts read from it would grade nothing a
 * consumer ships.
 */
import { join } from "node:path";

import { type ConfigObject, plainly, record } from "../.github/actions/_lib/gate.ts";
import { always, type Count, type Counts, isWhole } from "../count-ceilings.ts";
import { install, listAt, playwrightRun, resultsOf } from "./sweep-fixture.ts";
import { materialise } from "./tree.ts";

const HERE = join(import.meta.dir, "..");

/** How many rows one page of the list holds. */
export const ROWS = 20;

/** How many characters of unrendered detail each row carries under the heavy plant. */
const DETAIL = 2_000;

/** How long the tail page's late work runs past `load`: this many 10ms tasks, past the 500ms Playwright calls network idle. */
const TAIL_TASKS = 100;

/** How long the other origin takes to answer `/slow`: longer than a page takes to go still. */
const SLOW_MS = 1_000;

/**
 * The list, and the three regressions planted in it, chosen by `?plant=`:
 * `rerender` lifts the hover highlight into the list's state, so one hover
 * re-renders every row; `request` has every row fetch its own detail on mount;
 * `heavy` asks the API for a detail field per row that nothing renders.
 */
const APP = `import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const plant = new URLSearchParams(location.search).get("plant") ?? "none";

function Probe({ id }) {
  useEffect(() => {
    fetch("/api/row/" + id);
  }, [id]);
  return null;
}

function App() {
  const [rows, setRows] = useState([]);
  const [hovered, setHovered] = useState(null);
  const [footer, setFooter] = useState(null);
  useEffect(() => {
    fetch("/api/rows?page=1" + (plant === "heavy" ? "&detail=full" : ""))
      .then((response) => response.json())
      .then(setRows);
  }, []);
  const more = () =>
    Promise.all([import("./count-budget-footer.js"), fetch("/api/rows?page=2").then((response) => response.json())]).then(
      ([{ Footer }, next]) => {
        setRows((held) => [...held, ...next]);
        setFooter(() => Footer);
      },
    );
  return h(
    "main",
    null,
    h(
      "ul",
      null,
      rows.map((row) =>
        h(
          "li",
          {
            key: row.id,
            className: plant === "rerender" && hovered === row.id ? "row hovered" : "row",
            onMouseEnter: plant === "rerender" ? () => setHovered(row.id) : undefined,
          },
          row.name,
          plant === "request" ? h(Probe, { id: row.id }) : null,
        ),
      ),
    ),
    h("button", { onClick: more }, "more"),
    footer === null ? null : h(footer),
  );
}

createRoot(document.getElementById("root")).render(h(App));
`;

const FOOTER = `import { createElement as h } from "react";

export function Footer() {
  return h("footer", null, "the end of the list");
}
`;

/** The built app, by the path it is served at. */
async function built(): Promise<Map<string, string>> {
  const entry = join(import.meta.dir, "count-budget-app.js");
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: APP, [join(import.meta.dir, "count-budget-footer.js")]: FOOTER },
    splitting: true,
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!build.success) {
    throw new Error(
      `the fixture app did not build:\n${build.logs.map((log) => log.message).join("\n")}`,
    );
  }
  const served = new Map<string, string>();
  for (const output of build.outputs) {
    served.set(`/assets/${output.path.replace(/^\.\//, "")}`, await output.text());
  }
  return served;
}

function html(head: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>${head}</head><body>${body}</body></html>`;
}

function rows(page: number, detail: boolean): string {
  return JSON.stringify(
    Array.from({ length: ROWS }, (_, index) => {
      const id = (page - 1) * ROWS + index + 1;
      return { id, name: `row ${id}`, ...(detail ? { detail: "d".repeat(DETAIL) } : {}) };
    }),
  );
}

/** Appends one empty element to the body: one mutation record. */
const ADD = `const add = () => document.body.append(document.createElement("div"));`;

/**
 * The plain pages, none of them React. `other` is an origin the test does not
 * serve, which is what the origin rule is about.
 */
function pagesFor(other: string, entry: string): Map<string, string> {
  return new Map(
    Object.entries({
      "/app": html(
        `<style>.row:hover,.row.hovered{background:#eee}</style>`,
        `<div id="root"></div><script type="module" src="${entry}"></script>`,
      ),
      // Work that runs on past `load` in back-to-back tasks. Asked for a tail,
      // it then appends four elements and a button, which appends one more
      // when clicked: a spec that clicks it waits for the tail to land.
      "/tail": html(
        "",
        `<script>${ADD}
addEventListener("load", () => {
  const channel = new MessageChannel();
  let left = ${TAIL_TASKS};
  channel.port1.onmessage = () => {
    const until = performance.now() + 10;
    while (performance.now() < until);
    if (--left > 0) return channel.port2.postMessage(null);
    if (!location.search.includes("tail")) return;
    for (let i = 0; i < 4; i++) add();
    const late = document.createElement("button");
    late.id = "late";
    late.textContent = "add";
    late.addEventListener("click", add);
    document.body.append(late);
  };
  channel.port2.postMessage(null);
});</script>`,
      ),
      // A click that mutates the document it is about to leave.
      "/leaving": html(
        "",
        `<a id="go" href="/landing">go</a><script>${ADD}
document.getElementById("go").addEventListener("click", add);</script>`,
      ),
      "/landing": html("", `<p>landed</p>`),
      // Appends `?mutations=` elements, fetches `/bytes` `?requests=` times, and
      // loads a script, so a test chooses its own counts.
      "/counted": html(
        "",
        `<script src="/counted.js"></script><script>${ADD}
const asked = new URLSearchParams(location.search);
for (let i = 0; i < Number(asked.get("mutations")); i++) add();
for (let i = 0; i < Number(asked.get("requests")); i++) fetch("/bytes");</script>`,
      ),
      "/external": html(
        "",
        `<script>fetch("${other}/data").then((response) => response.text()).then((text) => document.body.append(text), () => document.body.append("failed"))</script>`,
      ),
      // Moves every frame whatever the user's motion preference.
      "/restless": html(
        "",
        `<div id="spin" style="height:4px;background:#333"></div><script>let n = 0;
const step = () => { document.getElementById("spin").style.width = (++n % 50) + "px"; requestAnimationFrame(step); };
requestAnimationFrame(step);</script>`,
      ),
      // Moves every frame unless the user asked for reduced motion.
      "/motion": html(
        "",
        `<div id="spin" style="height:4px;background:#333"></div><script>let n = 0;
const step = () => { document.getElementById("spin").style.width = (++n % 50) + "px"; requestAnimationFrame(step); };
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(step);</script>`,
      ),
      "/hanging": html("", `<script>fetch("/never")</script>`),
      // A socket to the other origin, whose first message lands in the page.
      "/socket": html(
        "",
        `<script>new WebSocket("${other.replace(/^http/, "ws")}/").onmessage = (event) => document.body.append(event.data);</script>`,
      ),
      // A service worker whose own fetch reaches the other origin.
      "/worker": html(
        "",
        `<script>navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => document.body.append("ready"));</script>`,
      ),
      // The list behind a page that turns React's DevTools hook off before React loads.
      "/hardened": html(
        "",
        `<script>window.__REACT_DEVTOOLS_GLOBAL_HOOK__.isDisabled = true;</script><div id="root"></div><script type="module" src="${entry}"></script>`,
      ),
      // The list behind the body of `@fvilers/disable-react-devtools`, which
      // overwrites every property of the hook rather than setting `isDisabled`.
      "/neutered": html(
        "",
        `<script>const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (typeof hook === "object") {
  for (const prop in hook) {
    if (prop === "renderers") { hook[prop] = new Map(); continue; }
    hook[prop] = typeof hook[prop] === "function" ? Function.prototype : null;
  }
}</script><div id="root"></div><script type="module" src="${entry}"></script>`,
      ),
      // A service worker whose own fetch to the other origin outlives the load.
      "/slow-worker": html(
        "",
        `<script>navigator.serviceWorker.register("/slow-sw.js").then(() => navigator.serviceWorker.ready).then(() => document.body.append("ready"));</script>`,
      ),
      // A fetch to the other origin the page gives up on after 20ms.
      "/impatient": html(
        "",
        `<script>const gaveUp = new AbortController();
fetch("${other}/data", { signal: gaveUp.signal }).then((response) => response.text()).then((text) => document.body.append(text), () => document.body.append("gave up"));
setTimeout(() => gaveUp.abort(), 20);</script>`,
      ),
      // An iframe in the markup and one added by script, each a navigation of a frame that did not exist yet.
      "/framed": html(
        "",
        `<iframe src="/landing"></iframe><script>const late = document.createElement("iframe");
late.src = "/landing";
document.body.append(late);</script>`,
      ),
      // A click that sends analytics as it leaves: a beacon and a keepalive fetch.
      "/beacon": html(
        "",
        `<a id="go" href="/landing">go</a><script>document.getElementById("go").addEventListener("click", () => { navigator.sendBeacon("/ping"); fetch("/keep", { method: "POST", keepalive: true }); });</script>`,
      ),
      "/blob": html(
        "",
        `<script>fetch(URL.createObjectURL(new Blob(["made here"]))).then((response) => response.text()).then((text) => document.body.append(text))</script>`,
      ),
    }),
  );
}

export interface Serving {
  readonly origin: string;
  /** The origin no test serves. */
  readonly other: string;
  readonly stop: () => Promise<void>;
}

/** The fixture pages, and the other origin, on ports nobody chose. */
export async function serving(): Promise<Serving> {
  const assets = await built();
  const entry = [...assets.keys()].find((path) => path.endsWith("/count-budget-app.js"));
  if (entry === undefined)
    throw new Error(`the fixture app's build has no entry: ${[...assets.keys()].join(", ")}`);
  const other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, held) {
      if (held.upgrade(request)) return undefined;
      if (new URL(request.url).pathname === "/slow") await Bun.sleep(SLOW_MS);
      return new Response("from the other origin", {
        headers: { "access-control-allow-origin": "*" },
      });
    },
    websocket: {
      open: (socket) => {
        socket.send("from the other origin's socket");
      },
      message: () => {},
    },
  });
  const pages = pagesFor(other.url.origin, entry);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const json = { headers: { "content-type": "application/json" } };
      if (path === "/never") return await new Promise<Response>(() => {});
      if (path === "/ping" || path === "/keep") return new Response(null, { status: 204 });
      if (path === "/sw.js") {
        return new Response(
          `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(fetch("${other.url.origin}/data").then((response) => response.text())));`,
          { headers: { "content-type": "text/javascript" } },
        );
      }
      if (path === "/slow-sw.js") {
        return new Response(
          `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(fetch("${other.url.origin}/slow").then((response) => response.text())));`,
          { headers: { "content-type": "text/javascript" } },
        );
      }
      if (path === "/api/rows") {
        return new Response(
          rows(Number(url.searchParams.get("page")), url.searchParams.has("detail")),
          json,
        );
      }
      if (path.startsWith("/api/row/"))
        return new Response(JSON.stringify({ id: path.slice(9) }), json);
      if (path === "/bytes") return new Response("b".repeat(100));
      if (path === "/counted.js") {
        return new Response(`window.counted = true;`, {
          headers: { "content-type": "text/javascript" },
        });
      }
      const asset = assets.get(path);
      if (asset !== undefined)
        return new Response(asset, { headers: { "content-type": "text/javascript" } });
      const page = pages.get(path);
      if (page === undefined) return new Response("no such fixture page", { status: 404 });
      return new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  return {
    origin: server.url.origin,
    other: other.url.origin,
    stop: async () => {
      await server.stop(true);
      await other.stop(true);
    },
  };
}

/** How one run of one test came out. */
export interface Outcome {
  /** Playwright's own word for it: `passed`, `failed`, `skipped`, `timedOut`, `interrupted`. */
  readonly status: string;
  readonly ok: boolean;
  readonly said: string;
  /** What the fixture measured, by phase; absent when it measured nothing. */
  readonly counts?: Record<string, Counts>;
}

/** One phase's counts as attached, refused where a count is missing or not a whole number. */
function countsOf(attached: unknown, where: string): Counts {
  const written = record(attached);
  const count = (name: Count): number => {
    const value = written[name];
    if (!isWhole(value)) throw new Error(`${where}.${name} is ${JSON.stringify(value)}`);
    return value;
  };
  const counts = always(count);
  return Object.hasOwn(written, "reactCommits")
    ? { ...counts, reactCommits: count("reactCommits") }
    : counts;
}

/** The counts a run attached, by phase: the fixture's own JSON, read back through the reporter's. */
function countsIn(attached: string): Record<string, Counts> {
  const phases = record(JSON.parse(Buffer.from(attached, "base64").toString("utf8")));
  return Object.fromEntries(
    Object.entries(phases).map(([phase, counts]) => [phase, countsOf(counts, phase)]),
  );
}

function outcomeOf(result: ConfigObject): Outcome {
  const said = listAt(result, "errors")
    .map((error) => (typeof error["message"] === "string" ? error["message"] : ""))
    .join("\n");
  const attached = listAt(result, "attachments").find(
    (attachment) => attachment["name"] === "count-budget",
  )?.["body"];
  const status = String(result["status"]);
  const ok = status === "passed";
  return typeof attached === "string"
    ? { status, ok, said, counts: countsIn(attached) }
    : { status, ok, said };
}

/** How the fixture's Playwright config runs its tests. */
export interface Config {
  readonly workers: number;
  /** Tests of one file in parallel, which is what puts two writers on one ceilings file. */
  readonly fullyParallel?: boolean;
}

/** A fixture tree: the config, the specs, and this package installed beside them. */
export async function fixture(
  origin: string,
  files: Readonly<Record<string, string>>,
  config: Config,
): Promise<string> {
  const root = await materialise({
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: ${config.workers},
  fullyParallel: ${config.fullyParallel === true},
  use: { baseURL: ${JSON.stringify(origin)}, viewport: { width: 800, height: 600 } },
});
`,
    ...files,
  });
  await install(root);
  return root;
}

/**
 * Runs the fixture's specs, and reports every run of every test by its title,
 * in the order they ran — more than one where `--repeat-each` asked or a retry
 * ran. A title two spec files share is refused, since a case reading it by
 * title would read whichever the reporter listed last. `CI` is taken out of the
 * environment the suite runs in, since write mode refuses to run under it and
 * CI runs this suite.
 */
export async function playwright(
  root: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[] = [],
): Promise<Map<string, Outcome[]>> {
  const { COUNT_BUDGET: _mode, CI: _ci, ...inherited } = plainly(Bun.env);
  const outcomes = new Map<string, Outcome[]>();
  const fileOf = new Map<string, string>();
  for (const spec of await playwrightRun(root, args, { ...inherited, ...env })) {
    const title = String(spec["title"]);
    const file = String(spec["file"]);
    const seen = fileOf.get(title) ?? file;
    if (seen !== file) throw new Error(`${seen} and ${file} each have a test titled ${title}`);
    fileOf.set(title, file);
    outcomes.set(title, [...(outcomes.get(title) ?? []), ...resultsOf(spec).map(outcomeOf)]);
  }
  return outcomes;
}

/** The checkout, for a spec that imports the export by path. */
export const SOURCE = JSON.stringify(join(HERE, "count-budget.ts"));
