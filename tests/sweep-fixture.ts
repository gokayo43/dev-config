/**
 * The pages the invariant sweep is driven over, and the Playwright run that
 * drives it.
 *
 * A fixture that is a real browser against a real server, because every part of
 * what the sweep claims is a browser fact: what `document.documentElement`
 * reports after a webfont settles, when a client-rendered change fires no
 * `load`, which URL the console attributes a message to. A stub of any of that
 * would be this repo asserting its own idea of a browser.
 *
 * Playwright resolves its own package from the test file's directory upward, so
 * the fixture directory is given this repo's `node_modules`, entry by entry as
 * symlinks — the same thing `mutation-lane.test.ts` does to run Stryker against
 * a fixture tree, and for the same reason: the tool has to be the installed one.
 * Beside them sits this package itself, copied rather than linked, which is what
 * `install` below is about.
 */
import { cp, mkdir, readdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";

import type { PlaywrightTestOptions, PlaywrightWorkerOptions } from "@playwright/test";

import type { InvariantSweep } from "../invariant-sweep.ts";

import { type ConfigObject, isList, plainly, record } from "../.github/actions/_lib/gate.ts";
import { ENDPOINT } from "../route-log.ts";
import { materialise } from "./tree.ts";

/** This checkout, which is both the package under test and where its install comes from. */
const HERE = join(import.meta.dir, "..");

/** The viewport every case is measured in, so "overflow" is a number and not a machine's. */
const VIEWPORT = { width: 800, height: 600 } as const;

/** Wide enough that no rounding argument can explain it away. */
const TOO_WIDE = VIEWPORT.width * 2;

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title><style>body{margin:0}</style></head><body>${body}</body></html>`;
}

/** How long the slow subresources take, in ms — long past first paint and past two frames. */
const LATE = 400;

/**
 * How long after its own `load` event the late page lays its overflow out, in ms
 * — the delay the gap was reported at (dev-config#113's review): past every
 * frame a flush could wait for, and inside the window a document goes quiet in.
 */
const AFTER_LOAD = 100;

/**
 * How often the animated page writes a style, in ms. Shorter than the quiet
 * window, so the document never goes quiet and the drain has to end on the
 * cutoff for a document that is changing without pause.
 */
const EVERY = 100;

/**
 * How long the self-closing popup waits before it goes, in ms. Shorter than the
 * quiet window, so it goes while its own drain is in flight — which is the whole
 * of what that fixture is for.
 */
const BEFORE_QUIET = 200;

/** How many popups the opener writes an error into, each before Playwright has reported it. */
export const WRITTEN = 16;

/**
 * How long after its own `load` event the late page moves, in ms: well inside
 * the window a document goes quiet in, so the drain is still waiting when it
 * lands.
 */
const LATE_SHIFT = 300;

/**
 * How long after the user acts the slow pages move, in ms: past the 500ms in
 * which a shift is still theirs, with room for the runner's own delay in
 * telling the page an action has returned.
 */
export const LONG_AFTER = 900;

/**
 * How long after its own `load` event the late form's field arrives, in ms:
 * long after its banner has moved the content, so an action waiting for the
 * field is waiting while the page moves.
 */
const LATE_FIELD = 1_200;

/** One block of the height a shift is measured in, so a diagnostic's distance is a number known here. */
const BLOCK = 60;

/** A block of content below whatever moves, which is what a shift's sources name. */
const CONTENT = `<main id="content">the content</main>`;

/** A script that appends a field and a select at the foot of the page, where they move nothing. */
const LATE_CONTROLS = `for (const [tag, id] of [["input", "field"], ["select", "pick"]]) { const c = document.createElement(tag); c.id = id; c.setAttribute("aria-label", id); if (tag === "select") c.innerHTML = "<option>a</option><option>b</option>"; document.body.append(c); }`;

/** A script that adds a `BLOCK`-high element above the content. */
const PUSH = `const b = document.createElement("div"); b.id = "banner"; b.style.height = "${BLOCK}px"; document.body.prepend(b);`;

/**
 * What the fixture server answers, by path. Each page is one invariant broken
 * one way, or a page that breaks none. `embed` is the *other* origin's, which
 * is what makes a cross-origin frame cross-origin.
 */
function pagesFor(embed: string): Map<string, { readonly type: string; readonly body: string }> {
  return new Map(
    Object.entries({
      "/clean": {
        type: "text/html",
        body: html(`<p>nothing wrong here</p><a href="/overflow">go</a>`),
      },
      "/overflow": {
        type: "text/html",
        body: html(
          `<div id="wide" style="width:${TOO_WIDE}px;height:10px;background:#333"></div><a href="/clean">back</a>`,
        ),
      },
      "/console": {
        type: "text/html",
        body: html(`<script>console.error("a request this page depends on failed")</script>`),
      },
      "/throws": { type: "text/html", body: html(`<script>window.nothing.atAll()</script>`) },
      // The console error arrives from a script of its own, which is what lets the
      // allowlist name a third-party embed rather than the page carrying it.
      "/embedded": { type: "text/html", body: html(`<script src="/embed.js"></script>`) },
      "/embed.js": { type: "text/javascript", body: `console.error("the embed is unhappy")` },
      // Overflow that appears after the document has loaded and without a
      // navigation: an SPA route change, or anything that renders on the client.
      "/late": {
        type: "text/html",
        body: html(
          `<script>setTimeout(() => { const d = document.createElement("div"); d.style.cssText = "width:${TOO_WIDE}px;height:10px"; document.body.append(d); }, 50)</script>`,
        ),
      },
      // Overflow laid out on a timer started by the page's own `load` event.
      // Nothing has measured it when `goto` resolves, so a spec that navigates
      // on that instant destroys the document before the layout it would fail on.
      "/after-load": {
        type: "text/html",
        body: html(
          `<script>addEventListener("load", () => setTimeout(() => { const d = document.createElement("div"); d.style.cssText = "width:${TOO_WIDE}px;height:10px"; document.body.append(d); }, ${AFTER_LOAD}))</script>`,
        ),
      },
      // Our own console error, wearing the vendor's name. `sourceURL` is a
      // comment: any script can claim any URL, and the console reports the claim.
      "/forged-source": {
        type: "text/html",
        body: html(
          `<script>console.error("this one is ours");\n//# sourceURL=https://cdn.vendor/vendor-embed.js</script>`,
        ),
      },
      // A frame from another origin, calling the fixture's own reporting bridge —
      // beside a real violation of the top page's, so a run that dropped both
      // cannot be told from one that dropped only the forgery.
      "/hostile-frame": {
        type: "text/html",
        body: html(
          `<iframe src="${embed}/forge.html" style="width:10px;height:10px"></iframe><div id="wide" style="width:${TOO_WIDE}px;height:10px"></div>`,
        ),
      },
      // A frame from another origin that throws, so the error is not the top page's.
      "/frame-throws": {
        type: "text/html",
        body: html(`<iframe src="${embed}/throws.html" style="width:10px;height:10px"></iframe>`),
      },
      // Navigates out from under any measurement the runner tries to take.
      "/self-navigating": {
        type: "text/html",
        body: html(
          `<script>setTimeout(() => { location.href = "/self-navigating?n=" + Date.now(); }, 25)</script><div id="wide" style="width:${TOO_WIDE}px;height:10px"></div>`,
        ),
      },
      // A real, top-frame violation whose *description* carries what a page
      // should not be able to put into a CI annotation: an ANSI escape, a
      // newline, and a workflow command.
      "/noisy-overflow": {
        type: "text/html",
        body: html(
          `<div id="wide" style="width:${TOO_WIDE}px;height:10px"></div><script>document.getElementById("wide").className = String.fromCharCode(27) + "[31m" + String.fromCharCode(10) + "::error title=x::y";</script>`,
        ),
      },
      // Overflow that arrives with the bytes of a subresource, well after first
      // paint.
      "/late-image": { type: "text/html", body: html(`<img id="slow" src="/slow.svg" alt="">`) },
      // A popup onto a page that breaks nothing, so a run that records it is
      // graded on its videos and not on a violation.
      "/opens-clean": {
        type: "text/html",
        body: html(`<a id="open" href="/clean" target="_blank">open</a>`),
      },
      // Opened in a tab of its own, which is a page no `page` fixture ever sees.
      "/popup": {
        type: "text/html",
        body: html(`<a id="open" href="/console" target="_blank">open</a>`),
      },
      // The route log's own endpoint, answered the way the protocol says an app
      // answers it — so the spec that imports the constant reaches a real one
      // with it rather than asserting the string against itself.
      [ENDPOINT]: {
        type: "application/json",
        body: JSON.stringify({ routeTable: [{ method: "GET", path: "/clean" }], counts: [] }),
      },
      // A popup with no URL of its own, written into by its opener: its document
      // carries `about:blank`, the URL the page every context starts on carries
      // too, and it is swept and drained like any other all the same.
      "/opens-blank": {
        type: "text/html",
        body: html(
          `<button id="open">open</button><script>document.getElementById("open").addEventListener("click", () => { const w = window.open(); w.document.write('<div id="wide" style="width:${TOO_WIDE}px;height:10px"></div>'); })</script>`,
        ),
      },
      // Writes a style forever, faster than the quiet window: a document that
      // has nothing more to say and no gap in which to say so.
      "/animated": {
        type: "text/html",
        body: html(
          `<div id="spinner" style="height:10px;background:#333"></div><script>let n = 0; setInterval(() => { document.getElementById("spinner").style.width = ((++n % 40) + 1) + "px"; }, ${EVERY})</script>`,
        ),
      },
      // Opens the page below in a tab of its own, which is the only way a page
      // that closes itself is not the page the spec is standing on.
      "/opens-self-closing": {
        type: "text/html",
        body: html(`<a id="open" href="/self-closing" target="_blank">open</a>`),
      },
      // A real violation, and then the page goes — while the drain that would
      // have flushed it is still waiting. What it measured has already crossed;
      // what must not happen is the run reporting the closure instead.
      "/self-closing": {
        type: "text/html",
        body: html(
          `<script>console.error("the popup is unhappy"); setTimeout(() => window.close(), ${BEFORE_QUIET})</script>`,
        ),
      },
      // Two page names, one a prefix of the other: what an unanchored pattern
      // cannot tell apart.
      "/cleanish": {
        type: "text/html",
        body: html(`<script>console.error("the almost-clean page is unhappy")</script>`),
      },
      // Each popup has its error written into it by its opener before Playwright
      // has finished reporting the popup, which is the moment a listener on the
      // page is too late for (dev-config#144).
      "/opens-written-errors": {
        type: "text/html",
        body: html(
          `<button id="open">open</button><script>document.getElementById("open").addEventListener("click", () => { for (let n = 0; n < ${WRITTEN}; n++) window.open().console.error("written popup " + n + " is unhappy"); })</script>`,
        ),
      },
      // An image with no size of its own above the content: when its bytes
      // arrive, before the document's `load`, it takes its height and pushes
      // the content down.
      "/image-shift": {
        type: "text/html",
        body: html(`<img id="hero" src="/slow-block.svg" alt="">${CONTENT}`),
      },
      // A banner that arrives after the page has loaded, pushing the content
      // down: data that came back late.
      "/late-shift": {
        type: "text/html",
        body: html(
          `${CONTENT}<a href="/clean">on</a><script>addEventListener("load", () => setTimeout(() => { ${PUSH} }, ${LATE_SHIFT}))</script>`,
        ),
      },
      // Everything here moves the content when the page is acted on: a click
      // opens a panel, typing grows a textarea, and a field that is filled or a
      // select that is chosen shows a line above it. Each control on a line of
      // its own: side by side, a slow renderer settling one moves the others.
      "/acted": {
        type: "text/html",
        body: html(
          `<style>button, input, select, textarea { display: block }</style><div id="panel"></div><button id="open">open</button><input id="field" aria-label="field"><select id="pick" aria-label="pick"><option>a</option><option>b</option></select><input id="file" type="file" aria-label="file"><textarea id="grow" aria-label="grow" rows="1"></textarea>${CONTENT}<script>const line = (text) => { const d = document.createElement("p"); d.textContent = text; document.getElementById("panel").append(d); }; document.getElementById("open").addEventListener("click", () => line("opened")); document.getElementById("field").addEventListener("input", () => line("filled")); document.getElementById("pick").addEventListener("change", () => line("picked")); document.getElementById("file").addEventListener("change", () => line("attached")); document.getElementById("grow").addEventListener("input", (e) => { e.target.style.height = e.target.scrollHeight + "px"; });</script>`,
        ),
      },
      // The line a filled field asks for arrives after the action's half-second.
      "/slow-fill": {
        type: "text/html",
        body: html(
          `<input id="field" aria-label="field">${CONTENT}<script>document.getElementById("field").addEventListener("input", () => setTimeout(() => { ${PUSH} }, ${LONG_AFTER}))</script>`,
        ),
      },
      // The page dispatches the event a filled field would, with nobody acting.
      "/self-input": {
        type: "text/html",
        body: html(
          `<input id="field" aria-label="field">${CONTENT}<script>const field = document.getElementById("field"); field.addEventListener("input", () => { ${PUSH} }); addEventListener("load", () => setTimeout(() => field.dispatchEvent(new Event("input", { bubbles: true })), ${LATE_SHIFT}))</script>`,
        ),
      },
      // Replaces the sweep's reporter with one that drops everything, then
      // overflows.
      "/rebinds": {
        type: "text/html",
        body: html(
          `<script>window.__invariantSweep = () => {};</script><div id="wide" style="width:${TOO_WIDE}px;height:10px"></div>`,
        ),
      },
      // A field there from the start, a banner that moves the content well
      // after a fill of that field has returned, and a second field arriving
      // after the banner.
      "/late-form": {
        type: "text/html",
        body: html(
          `<input id="now" aria-label="now">${CONTENT}<script>addEventListener("load", () => { setTimeout(() => { ${PUSH} }, ${LONG_AFTER}); setTimeout(() => { ${LATE_CONTROLS} }, ${LATE_FIELD}); })</script>`,
        ),
      },
      // The page dispatches an `input` event of its own and moves its content,
      // and the field and the select a spec acts on arrive long after.
      "/self-input-wait": {
        type: "text/html",
        body: html(
          `<input id="other" aria-label="other">${CONTENT}<script>addEventListener("load", () => { setTimeout(() => { document.getElementById("other").dispatchEvent(new Event("input", { bubbles: true })); ${PUSH} }, ${LATE_SHIFT}); setTimeout(() => { ${LATE_CONTROLS} }, ${LATE_FIELD}); })</script>`,
        ),
      },
      // The click asks for a panel that arrives after the user's half-second is
      // over, which is the page moving on its own.
      "/slow-panel": {
        type: "text/html",
        body: html(
          `<button id="open">open</button>${CONTENT}<script>document.getElementById("open").addEventListener("click", () => setTimeout(() => { ${PUSH} }, ${LONG_AFTER}))</script>`,
        ),
      },
      // Three elements below a late banner, each with more class names than a
      // diagnostic carries and every one of them long.
      "/long-names-shift": {
        type: "text/html",
        body: html(
          `${["one", "two", "three"].map((n) => `<div id="moved-${n}" class="${["display", "spacing", "colour", "border"].map((what) => `${what}-utility-class-name-from-a-long-design-system-${n}`).join(" ")}">${n}</div>`).join("")}<script>addEventListener("load", () => setTimeout(() => { ${PUSH} }, ${LATE_SHIFT}))</script>`,
        ),
      },
      // A third-party embed that asks its host for more room once it has loaded
      // what it shows, the way an oEmbed widget does, and pushes the host's
      // content down when it gets it.
      "/shifting-embed": {
        type: "text/html",
        body: html(
          `<iframe id="widget" src="${embed}/resizing.html" style="display:block;border:0;width:300px;height:20px"></iframe>${CONTENT}<script>addEventListener("message", (event) => { if (event.origin === ${JSON.stringify(embed)}) document.getElementById("widget").style.height = event.data + "px"; })</script>`,
        ),
      },
    }),
  );
}

/** The other origin: a second server, so a frame from it is genuinely cross-origin. */
function embedding(): { origin: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/forge.html") {
        // Everything a page should not be able to put into a test's failure
        // message: a violation it invented, an ANSI escape, and a GitHub
        // workflow command. Built with fromCharCode so the escape survives every
        // layer of quoting between here and the browser.
        const forged = [
          `const esc = String.fromCharCode(27);`,
          `window.__invariantSweep({`,
          `  kind: "console.error",`,
          `  at: "https://cdn.vendor/vendor-embed.js",`,
          `  detail: esc + "[31mforged" + esc + "[0m" + String.fromCharCode(10) + "::error title=forged::a frame wrote this",`,
          `});`,
        ].join("");
        return new Response(html(`<script>${forged}</script>`), {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/resizing.html") {
        return new Response(
          html(
            `<script>addEventListener("load", () => setTimeout(() => parent.postMessage(${20 + BLOCK}, "*"), ${LATE_SHIFT}))</script>`,
          ),
          { headers: { "content-type": "text/html" } },
        );
      }
      if (path === "/throws.html") {
        return new Response(html(`<script>window.nothing.atAll()</script>`), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("no such fixture page", { status: 404 });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}

export interface Serving {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** The fixture pages on ports nobody chose, so two runs on one box never collide. */
export function serving(): Serving {
  const other = embedding();
  const pages = pagesFor(other.origin);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/sandboxed") {
        // A policy that sandboxes the document without allowing scripts.
        return new Response(html(`<p>nothing runs here</p>`), {
          headers: { "content-type": "text/html", "content-security-policy": "sandbox" },
        });
      }
      if (path === "/slow-block.svg") {
        // An image whose height arrives with its bytes, after first paint.
        await Bun.sleep(LATE);
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="${BLOCK}"><rect width="100%" height="100%" fill="#333"/></svg>`,
          { headers: { "content-type": "image/svg+xml" } },
        );
      }
      if (path === "/slow.svg") {
        // Bytes that arrive long after first paint, carrying the width with them.
        await Bun.sleep(LATE);
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${TOO_WIDE}" height="10"><rect width="100%" height="100%" fill="#333"/></svg>`,
          { headers: { "content-type": "image/svg+xml" } },
        );
      }
      const page = pages.get(path);
      if (page === undefined) return new Response("no such fixture page", { status: 404 });
      return new Response(page.body, { headers: { "content-type": page.type } });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      await server.stop(true);
      await other.stop();
    },
  };
}

/** How one spec came out, as the reporter said it. */
export interface Outcome {
  readonly ok: boolean;
  /** Everything the run wrote about why it failed, joined — what a diagnostic is asserted against. */
  readonly said: string;
  /** What each departure the case measured asked the page's timer to sleep, in ms, in the order it left: what a drain cost, as the drain asked for it. */
  readonly asked: readonly number[];
  /** Whether each run of the case passed, one entry per repetition the run asked for. */
  readonly verdicts: readonly boolean[];
  /** Every video the case left under the run's output directory. */
  readonly videos: readonly Video[];
}

/** One recording: how many bytes the file holds, and the size of the frames encoded into it. */
export interface Video {
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The start code every VP8 key frame carries, followed by its width and its
 * height as two little-endian 16-bit fields whose low 14 bits are the pixels
 * (RFC 6386, section 9.1). Playwright encodes its recordings as VP8.
 */
const KEY_FRAME = [0x9d, 0x01, 0x2a] as const;

/** What a recording holds, read out of its first key frame; a file with none throws. */
async function videoAt(path: string): Promise<Video> {
  const held = await Bun.file(path).bytes();
  const at = held.findIndex(
    (_, index) =>
      index + 7 <= held.length && KEY_FRAME.every((byte, k) => held[index + k] === byte),
  );
  if (at === -1) throw new Error(`${path} holds no VP8 key frame, so it is not a recording`);
  const view = new DataView(held.buffer, held.byteOffset + at + KEY_FRAME.length, 4);
  return {
    bytes: held.length,
    width: view.getUint16(0, true) & 0x3f_ff,
    height: view.getUint16(2, true) & 0x3f_ff,
  };
}

/**
 * The reporter's JSON is a file another program wrote, so it is read the way
 * every gate here reads one: through `_lib`'s boundary readers, which answer
 * "not that shape" rather than asserting it was.
 */
export function listAt(node: ConfigObject, name: string): ConfigObject[] {
  const held = node[name];
  return isList(held) ? held.map(record) : [];
}

/** Every spec in the report, however deeply the reporter nested the files it ran. */
function specsIn(node: ConfigObject): ConfigObject[] {
  return [...listAt(node, "specs"), ...listAt(node, "suites").flatMap((suite) => specsIn(suite))];
}

/** Every result the reporter wrote for one spec, however many retries there were. */
export function resultsOf(spec: ConfigObject): ConfigObject[] {
  return listAt(spec, "tests").flatMap((each) => listAt(each, "results"));
}

/** What one spec's results said went wrong, joined — the whole of what a diagnostic is asserted against. */
function saidBy(spec: ConfigObject): string {
  return resultsOf(spec)
    .map((result) => {
      const message = record(result["error"])["message"];
      return typeof message === "string" ? message : "";
    })
    .join("\n");
}

/**
 * The videos one spec's report names, read off the disk. The switch says a
 * recording lands under the run's output directory, so one the report places
 * anywhere else throws with its path, and so does one that is not there.
 */
async function videosOf(spec: ConfigObject, output: string): Promise<Video[]> {
  const named = resultsOf(spec)
    .flatMap((result) => listAt(result, "attachments"))
    .filter((attachment) => attachment["contentType"] === "video/webm")
    .map((attachment) => String(attachment["path"]));
  for (const path of named) {
    if (relative(output, path).startsWith("..")) {
      throw new Error(`a video landed at ${path}, outside the run's output directory ${output}`);
    }
  }
  return await Promise.all(named.map(videoAt));
}

/** The annotation a spec notes one measured departure under, its description the ms that departure asked for. One constant, two ends. */
export const ASKED = "asked";

/** Every departure one spec measured, as its results noted them. */
function askedBy(spec: ConfigObject): number[] {
  return resultsOf(spec)
    .flatMap((result) => listAt(result, "annotations"))
    .filter((annotation) => annotation["type"] === ASKED)
    .map((annotation) => Number(annotation["description"]));
}

/** Whether each repetition of one spec came out as expected, which is how the reporter says it passed. */
function verdictsOf(spec: ConfigObject): boolean[] {
  return listAt(spec, "tests").map((each) => each["status"] === "expected");
}

/** The options a config's `use` block or a spec's `test.use` may set. */
export type Use = Partial<PlaywrightTestOptions & PlaywrightWorkerOptions & InvariantSweep>;

/** The fixture's config, with whatever a case adds to its `use` block, run `repeatEach` times. */
function configWith(use: Use, repeatEach: number): string {
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 4,
  repeatEach: ${repeatEach},
  use: {
    baseURL: process.env.SWEEP_ORIGIN,
    viewport: { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} },
    ...${JSON.stringify(use)},
  },
});
`;
}

/**
 * What a run sets beyond the specs: variables for its environment, options for
 * the config's `use`, and how many times each spec runs.
 */
interface Run {
  readonly env?: Readonly<Record<string, string>>;
  readonly use?: Use;
  readonly repeatEach?: number;
}

/**
 * The fixture's `node_modules`, holding this repo's own installs and this
 * package beside them.
 *
 * The installs are linked and the package is **copied**, and the difference is
 * the point: node resolves a module to its real path before it decides anything
 * about it, so a link would put this package's real path outside any
 * `node_modules` and node would strip types from a `.ts` under it — the one
 * thing it refuses to do for a consumer. Only a copy is what a consumer has.
 *
 * What is copied is what the manifest ships, so the fixture installs the package
 * as published rather than a list kept in step with `files` by hand.
 */
export async function install(root: string): Promise<void> {
  const modules = join(root, "node_modules");
  const installed = join(HERE, "node_modules");
  const manifest = record(await Bun.file(join(HERE, "package.json")).json());
  const name = String(manifest["name"]);
  const [scope = name] = name.split("/");

  // The package's own scope is a real directory holding links to whatever the
  // install already has under it, rather than a link to the scope itself: the
  // day a second `@gokayo43/*` package is installed here, a link would put the
  // copy below inside this repo's own `node_modules`.
  await mkdir(join(modules, scope), { recursive: true });
  const link = async (entry: string): Promise<void> => {
    await symlink(join(installed, entry), join(modules, entry), "dir");
  };
  await Promise.all(
    (await readdir(installed)).map(async (entry) => {
      if (entry !== scope) return await link(entry);
      const siblings = await readdir(join(installed, entry));
      await Promise.all(siblings.map(async (child) => await link(join(entry, child))));
    }),
  );

  const shipped = join(modules, name);
  await mkdir(shipped, { recursive: true });
  const files = isList(manifest["files"]) ? manifest["files"].map(String) : [];
  await Promise.all(
    ["package.json", ...files].map(
      async (entry) => await cp(join(HERE, entry), join(shipped, entry), { recursive: true }),
    ),
  );
}

/**
 * One Playwright run over a fixture tree, as its JSON reporter tells it: every
 * spec the run collected.
 *
 * A run that collected no spec at all is the fixture having failed, not a case
 * having come out badly — a spec whose imports do not load is reported here
 * and nowhere else, and reading it as "every case is missing" would hide the
 * one message that says why — so that throws with what the runner said.
 */
export async function playwrightRun(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<ConfigObject[]> {
  const proc = Bun.spawn(
    [join(root, "node_modules", ".bin", "playwright"), "test", "--reporter=json", ...args],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  let report: unknown;
  try {
    report = JSON.parse(out);
  } catch {
    throw new Error(`the Playwright run wrote no report:\n${out}\n${err}`);
  }
  const specs = specsIn(record(report));
  if (specs.length === 0) {
    const refused = listAt(record(report), "errors")
      .map((error) => (typeof error["message"] === "string" ? error["message"] : ""))
      .join("\n");
    throw new Error(`the Playwright run collected no spec:\n${refused}`);
  }
  return specs;
}

/**
 * Runs every spec given, and reports how each came out by its title. One
 * Playwright process for all of them: starting the runner costs more than the
 * cases do, and nothing here depends on a case running alone.
 *
 * The video switch is taken out of the environment the suite was started with,
 * so a developer who left it on in their shell does not record every run; a run
 * that wants it says so in `env`.
 */
export async function sweeping(
  origin: string,
  specs: Readonly<Record<string, string>>,
  run: Run = {},
): Promise<Map<string, Outcome>> {
  const root = await materialise({
    "playwright.config.ts": configWith(run.use ?? {}, run.repeatEach ?? 1),
    ...specs,
  });
  await install(root);
  const output = join(root, "results");
  const { E2E_VIDEO: _left, ...inherited } = plainly(Bun.env);

  const collected = await playwrightRun(root, ["--output", output], {
    ...inherited,
    SWEEP_ORIGIN: origin,
    ...run.env,
  });
  const outcomes = new Map<string, Outcome>();
  for (const spec of collected) {
    const title = spec["title"];
    outcomes.set(typeof title === "string" ? title : "", {
      ok: spec["ok"] === true,
      said: saidBy(spec),
      asked: askedBy(spec),
      verdicts: verdictsOf(spec),
      videos: await videosOf(spec, output),
    });
  }
  return outcomes;
}
