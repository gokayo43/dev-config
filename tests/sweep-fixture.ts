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
 * the fixture directory is given this repo's `node_modules` as a symlink — the
 * same thing `mutation-lane.test.ts` does to run Stryker against a fixture tree,
 * and for the same reason: the tool has to be the installed one.
 */
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { type ConfigObject, isList, plainly, record } from "../.github/actions/_lib/gate.ts";
import { materialise } from "./tree.ts";

/** The viewport every case is measured in, so "overflow" is a number and not a machine's. */
const VIEWPORT = { width: 800, height: 600 } as const;

/** Wide enough that no rounding argument can explain it away. */
const TOO_WIDE = VIEWPORT.width * 2;

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title><style>body{margin:0}</style></head><body>${body}</body></html>`;
}

/**
 * What the fixture server answers, by path. Each page is one invariant broken
 * one way, or a page that breaks none.
 */
const PAGES = {
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
};

/** The same pages, keyed the way a request arrives: any path at all, most of them not ours. */
const SERVED = new Map(Object.entries(PAGES));

export interface Serving {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** The fixture pages on a port nobody chose, so two runs on one box never collide. */
export function serving(): Serving {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const page = SERVED.get(new URL(request.url).pathname);
      if (page === undefined) return new Response("no such fixture page", { status: 404 });
      return new Response(page.body, { headers: { "content-type": page.type } });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      await server.stop(true);
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
 * Runs every spec given, and reports how each came out by its title. One
 * Playwright process for all of them: starting the runner costs more than the
 * cases do, and nothing here depends on a case running alone.
 */
export async function sweeping(
  origin: string,
  specs: Readonly<Record<string, string>>,
): Promise<Map<string, Outcome>> {
  const root = await materialise({ "playwright.config.ts": CONFIG, ...specs });
  await symlink(join(import.meta.dir, "..", "node_modules"), join(root, "node_modules"), "dir");

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
  return outcomes;
}
