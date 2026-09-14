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
import { dirname, join } from "node:path";

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

/** How long the slow subresource takes, in ms — long past `load` and past two frames. */
const LATE = 400;

/**
 * How long after its own `load` event the late page lays its overflow out, in ms
 * — the delay the gap was reported at (dev-config#113's review): past every
 * frame a flush could wait for, and inside the window a document goes quiet in.
 */
const AFTER_LOAD = 100;

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
      // Overflow that arrives with the bytes of a subresource, well after load.
      "/late-image": { type: "text/html", body: html(`<img id="slow" src="/slow.svg" alt="">`) },
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
      // Two page names, one a prefix of the other: what an unanchored pattern
      // cannot tell apart.
      "/cleanish": {
        type: "text/html",
        body: html(`<script>console.error("the almost-clean page is unhappy")</script>`),
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
      if (path === "/slow.svg") {
        // Bytes that arrive long after `load`, carrying the width with them.
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
}

/**
 * The reporter's JSON is a file another program wrote, so it is read the way
 * every gate here reads one: through `_lib`'s boundary readers, which answer
 * "not that shape" rather than asserting it was.
 */
function listAt(node: ConfigObject, name: string): ConfigObject[] {
  const held = node[name];
  return isList(held) ? held.map(record) : [];
}

/** Every spec in the report, however deeply the reporter nested the files it ran. */
function specsIn(node: ConfigObject): ConfigObject[] {
  return [...listAt(node, "specs"), ...listAt(node, "suites").flatMap((suite) => specsIn(suite))];
}

/** What one spec's results said went wrong, joined — the whole of what a diagnostic is asserted against. */
function saidBy(spec: ConfigObject): string {
  return listAt(spec, "tests")
    .flatMap((each) => listAt(each, "results"))
    .map((result) => {
      const message = record(result["error"])["message"];
      return typeof message === "string" ? message : "";
    })
    .join("\n");
}

const CONFIG = `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 4,
  use: {
    baseURL: process.env.SWEEP_ORIGIN,
    viewport: { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} },
  },
});
`;

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
async function install(root: string): Promise<void> {
  const modules = join(root, "node_modules");
  await mkdir(modules, { recursive: true });
  const installed = join(HERE, "node_modules");
  await Promise.all(
    (await readdir(installed)).map(
      async (entry) => await symlink(join(installed, entry), join(modules, entry), "dir"),
    ),
  );

  const manifest = record(await Bun.file(join(HERE, "package.json")).json());
  const shipped = join(modules, String(manifest["name"]));
  await mkdir(dirname(shipped), { recursive: true });
  const files = isList(manifest["files"]) ? manifest["files"].map(String) : [];
  await Promise.all(
    ["package.json", ...files].map(
      async (entry) => await cp(join(HERE, entry), join(shipped, entry), { recursive: true }),
    ),
  );
}

/**
 * Runs every spec given, and reports how each came out by its title. One
 * Playwright process for all of them: starting the runner costs more than the
 * cases do, and nothing here depends on a case running alone.
 */
export async function sweeping(
  origin: string,
  specs: Readonly<Record<string, string>>,
): Promise<Map<string, Outcome>> {
  const root = await materialise({ "playwright.config.ts": CONFIG, ...specs });
  await install(root);

  const proc = Bun.spawn(
    [join(root, "node_modules", ".bin", "playwright"), "test", "--reporter=json"],
    {
      cwd: root,
      env: { ...plainly(Bun.env), SWEEP_ORIGIN: origin },
      stdout: "pipe",
      stderr: "pipe",
    },
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

  const outcomes = new Map<string, Outcome>();
  for (const spec of specsIn(record(report))) {
    const title = spec["title"];
    outcomes.set(typeof title === "string" ? title : "", {
      ok: spec["ok"] === true,
      said: saidBy(spec),
    });
  }
  // A run that collected no spec at all is the fixture having failed, not a case
  // having come out badly — a spec whose imports do not load is reported here
  // and nowhere else, and reading it as "every case is missing" would hide the
  // one message that says why.
  if (outcomes.size === 0) {
    const refused = listAt(record(report), "errors")
      .map((error) => (typeof error["message"] === "string" ? error["message"] : ""))
      .join("\n");
    throw new Error(`the Playwright run collected no spec:\n${refused}`);
  }
  return outcomes;
}
