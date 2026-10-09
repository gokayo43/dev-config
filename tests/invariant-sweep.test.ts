/**
 * The invariant sweep, driven over a real browser against pages that break each
 * invariant in each of the ways a fixture can break it.
 *
 * The claim the fixture makes is "every page this test visited", and most of
 * these cases exist to attack the word *every*: a page the spec navigated away
 * from, a page it arrived at by clicking rather than by `goto`, and a page that
 * only overflows after it has finished loading. A sweep that measured once, at
 * the end, would pass the first two and a sweep that measured on `load` would
 * pass the third — and all three would keep claiming the same sentence.
 *
 * Recording is a subject of its own too, with runs of its own, because the
 * switch is read from the environment a whole Playwright process starts with.
 *
 * The last block is a different subject, run on its own: the two exports a spec
 * imports, reached through a `node_modules` of the fixture's own under the
 * runner Playwright actually brings. Every case above imports the sweep by path,
 * which is the one way a consumer never has it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ASKED,
  LONG_AFTER,
  type Outcome,
  serving,
  sweeping,
  type Use,
  WRITTEN,
} from "./sweep-fixture.ts";

const SWEEP = JSON.stringify(`${import.meta.dir}/../invariant-sweep.ts`);

/**
 * One spec: the fixture's `test` under the options the file sets with
 * `test.use`, if any, doing whatever the body does. `expect` comes from
 * Playwright's own package rather than through this one, which is the import
 * pair a consuming repo writes.
 */
function spec(title: string, body: string, options?: Use): string {
  const use = options === undefined ? "" : `test.use(${JSON.stringify(options)});\n`;
  return `import { expect } from "@playwright/test";
import { test } from ${SWEEP};

${use}test(${JSON.stringify(title)}, async ({ page, context }) => {
${body}
});
`;
}

/**
 * The most sleep a departure from a document changing without pause asks of the
 * page's timer, in ms: twice the quiet window from when it armed, the horizon
 * `docs/exports/invariant-sweep.md` gives such a document. Asked for, not
 * measured, so a loaded box can only lower it.
 */
const HORIZON = 1_000;

/**
 * What a spec that measures a departure runs first. The drain sleeps on the
 * page's own `setTimeout`, so wrapping it lets each document tally the sleep
 * it was asked for, in the whole ms the timer takes: its delay is a WebIDL
 * `long`. `leave` navigates and notes what that departure asked for under
 * `ASKED`. The tally lives in the document and is read there, so a measured
 * departure navigates within the document. The drain runs before the call
 * whatever the call goes on to replace.
 */
const MEASURED = `  await page.addInitScript(() => {
    const sleep = window.setTimeout;
    window.__asked = 0;
    window.setTimeout = (handler, ms, ...rest) => {
      window.__asked += Math.trunc(ms);
      return sleep(handler, ms, ...rest);
    };
  });
  const asked = async () => await page.evaluate(() => window.__asked);
  const leave = async (url) => {
    const before = await asked();
    await page.goto(url);
    test.info().annotations.push({ type: ${JSON.stringify(ASKED)}, description: String((await asked()) - before) });
  };
`;

/** How many times each steady case runs, on a quiet renderer and again on a slowed one. */
const RUNS = 20;

/** How many times slower the slowed renderer runs, through Chromium's own CPU throttling: DevTools' 6x preset. */
const SLOWDOWN = 6;

/** The bodies a case and a steady run both drive, so the two never drift apart. */
const BODY = {
  imageShift: `  await page.goto("/image-shift");`,
  lateShift: `  await page.goto("/late-shift");\n  await expect(page.locator("#banner")).toBeAttached();`,
  acted: `  await page.goto("/acted");\n  await page.click("#open");\n  await page.locator("#grow").pressSequentially("a\\nb\\nc");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  filled: `  await page.goto("/acted");\n  await page.fill("#field", "x");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  slowFill: `  await page.goto("/slow-fill");\n  await page.fill("#field", "x");\n  await expect(page.locator("#banner")).toBeAttached();`,
  embedShift: `  await page.goto("/shifting-embed");\n  await expect(page.locator("#widget")).toHaveCSS("height", "80px");`,
  clean: `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
} as const;

/** The allowlist entry that covers the shifting embed's page. */
const EMBED_ALLOWED: Use = {
  sweepAllowlist: { "/shifting-embed$": "the widget sizes itself once it has loaded" },
};

/**
 * One call per wrapped method kind, each made to fail at once: Playwright names
 * a call after its own innermost frame, so a wrapper in the wrong place renames
 * every failure a consumer reads.
 */
const NAMED = [
  ["page.goto", `  await page.goto("http://127.0.0.1:1/");`],
  [
    "page.fill",
    `  await page.goto("/clean");\n  await page.fill("#nowhere", "x", { timeout: 200 });`,
  ],
  [
    "locator.fill",
    `  await page.goto("/clean");\n  await page.locator("#nowhere").fill("x", { timeout: 200 });`,
  ],
  [
    "elementHandle.fill",
    `  await page.goto("/clean");\n  await (await page.locator("p").elementHandle()).fill("x");`,
  ],
  [
    "locator.selectOption",
    `  await page.goto("/clean");\n  await page.locator("#nowhere").selectOption("a", { timeout: 200 });`,
  ],
  [
    "page.setInputFiles",
    `  await page.goto("/clean");\n  await page.setInputFiles("#nowhere", [], { timeout: 200 });`,
  ],
] as const;

/** A case whose shift lands past the half-second a marked action excuses. */
const SLOW_FILL = `a shift ${LONG_AFTER}ms after fill fails`;

/** Every case's spec; the reporter's outcome for each is found by its title. */
const CASES = [
  spec("a page that breaks nothing passes", BODY.clean),
  spec("a console error fails the test that visited it", `  await page.goto("/console");`),
  spec("a page that throws fails the test that visited it", `  await page.goto("/throws");`),
  spec("a page wider than its viewport fails", `  await page.goto("/overflow");`),
  // Overflow that appears after `load`, with no navigation of any kind: what a
  // client-rendered route change looks like from the outside.
  spec(
    "overflow that appears after the page loaded fails",
    `  await page.goto("/late");\n  await page.waitForTimeout(300);`,
  ),
  // Overflow the page lays out on a timer started by its own `load` event, on a
  // page the spec leaves at once. Nothing has measured it when `goto` resolves,
  // so what has to hold is that the outgoing document is given its say before
  // the navigation replaces it — a flush of the frames already scheduled finds
  // nothing here, because the layout that breaks has not happened yet.
  spec(
    "a page that overflows after load and is left at once is swept",
    `  await page.goto("/after-load");\n  await page.goto("/clean");`,
  ),
  // A document that is changing without pause has nothing more to say and no
  // gap in which to say so, so leaving it is bounded by the cutoff rather than
  // by a cap. What this asserts is the cost, since the page breaks no invariant
  // either way.
  spec(
    "leaving an animated page costs no more than its budget",
    `${MEASURED}  await page.goto("/animated");\n  await leave("/animated#left");`,
  ),
  // The second is a fragment: a navigation with no new document behind it.
  // Nothing re-runs in the page, so a drain waiting on anything armed per
  // navigation waits for a word that can no longer be spoken.
  spec(
    "a same-document navigation does not stall the next one",
    `${MEASURED}  await page.goto("/clean");\n  await page.goto("/clean#section");\n  await leave("/clean#next");`,
  ),
  // The popup logs its violation and then goes, while the drain that would have
  // flushed it is still waiting. What it measured has already crossed; the run
  // must report that and not the closure.
  spec(
    "a popup that closes itself still reports what it measured",
    `  await page.goto("/opens-self-closing");\n  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);\n  await popup.waitForLoadState();`,
  ),
  // A popup its opener wrote into carries the URL of the page every context
  // starts on, and nothing about the sweep reads that URL: it is watched,
  // measured and drained like any other document.
  spec(
    "an opener-written blank popup is swept like any other",
    `  await page.goto("/opens-blank");\n  await Promise.all([context.waitForEvent("page"), page.click("#open")]);`,
  ),
  // The page the spec ended on is clean. A sweep that looked once, at the end,
  // reports nothing here.
  spec(
    "a page the test navigated away from is still swept",
    `  await page.goto("/overflow");\n  await page.getByRole("link").click();\n  await expect(page.locator("p")).toBeVisible();`,
  ),
  // Arrived at by a click, so nothing called `goto` for it.
  spec(
    "a page reached by clicking a link is swept",
    `  await page.goto("/clean");\n  await page.getByRole("link").click();\n  await expect(page.locator("#wide")).toBeAttached();`,
  ),
  // The console error comes from /embed.js, so the allowlist names the embed
  // rather than every page that carries it.
  spec("an allowlisted embed's console error is tolerated", `  await page.goto("/embedded");`, {
    sweepAllowlist: {
      "/embed\\.js$": "the embed logs a failed beacon on every load; it is not ours to fix",
    },
  }),
  // The keys are written by hand in a config file, so a bad one has to say
  // which key and which option rather than surfacing as a bare SyntaxError.
  spec("an allowlist key that is not a pattern says so", `  await page.goto("/clean");`, {
    sweepAllowlist: { "(unclosed": "a pattern nobody balanced" },
  }),
  // A `//# sourceURL=` comment is a claim any script can make about itself, and
  // the console repeats the claim. Honouring it unchecked lets an inline script
  // of *ours* wear a vendor's name and land in the vendor's allowlist bucket.
  spec("our own error cannot wear a vendor's name", `  await page.goto("/forged-source");`, {
    sweepAllowlist: { "cdn\\.vendor": "the vendor embed logs a failed beacon on every load" },
  }),
  // A frame from another origin calling the bridge: it can neither invent a
  // violation nor choose which bucket one lands in.
  spec(
    "a frame cannot report a violation for the page carrying it",
    `  await page.goto("/hostile-frame");\n  await page.waitForTimeout(300);`,
  ),
  // An embed's own thrown error is the embed's, and the allowlist has to be able
  // to reach it by the embed's address rather than by the page's.
  spec(
    "an embed's thrown error is attributed to the embed",
    `  await page.goto("/frame-throws");\n  await page.waitForTimeout(300);`,
    { sweepAllowlist: { "throws\\.html$": "the embed throws on load; it is not ours to fix" } },
  ),
  // A page that navigates out from under the flush still gets its verdict.
  spec(
    "a page that navigates on a timer still reports what it measured",
    `  await page.goto("/self-navigating");\n  await page.waitForTimeout(200);`,
  ),
  // Opened in a tab of its own: a page fixture never sees it, and a context one
  // does.
  spec(
    "a popup is swept like any other page",
    `  await page.goto("/popup");\n  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);\n  await popup.waitForLoadState();`,
  ),
  // A real violation whose description is hostile: the page writes the escape
  // codes and the workflow command, and the annotation must carry neither.
  spec(
    "a violation's own text cannot carry an escape or a workflow command",
    `  await page.goto("/noisy-overflow");\n  await page.waitForTimeout(200);`,
  ),
  // Overflow that arrives with an image's bytes, long after load and without a
  // single change to the DOM.
  spec(
    "overflow that arrives with a subresource is swept",
    `  await page.goto("/late-image");\n  await page.waitForTimeout(700);`,
  ),
  // The keys are regular expressions and nothing anchors them, so a page name
  // is a prefix of its neighbour's. Pinned in both directions, because the
  // alternative — anchoring a key that happens to contain no metacharacter —
  // would anchor exactly the keys that are not URLs, every real one having a dot.
  spec("an unanchored key reaches the page next door", `  await page.goto("/cleanish");`, {
    sweepAllowlist: { "/clean": "the clean page's own embed" },
  }),
  spec("an anchored key stops at the page it names", `  await page.goto("/cleanish");`, {
    sweepAllowlist: { "/clean$": "the clean page's own embed" },
  }),
  // ...and an allowlist that names something else does not quietly cover it.
  spec("an allowlist that matches nothing tolerates nothing", `  await page.goto("/embedded");`, {
    sweepAllowlist: { "/analytics\\.js$": "a pattern for an embed this page does not carry" },
  }),
  // Every popup's error is written before Playwright has reported the popup, so
  // a sweep listening on each page as it arrives hears some of them and not
  // others (dev-config#144). One case, many popups: each is a fresh chance for
  // that race to drop one.
  spec(
    "an error a popup logs before it is reported is swept",
    `  await page.goto("/opens-written-errors");\n  await page.click("#open");\n  await expect.poll(() => context.pages().length).toBe(${WRITTEN + 1});`,
  ),
  // An image with no size of its own takes its height before `load`, under
  // the content. A sweep that counted only once the page had gone quiet passes
  // this.
  spec("a shift while the page loads fails", BODY.imageShift),
  spec("a shift after the page loaded fails", BODY.lateShift),
  // Left by a click, so nothing drains the page: what it saw has to have
  // crossed as it happened. A sweep that read the page's shifts once, at the
  // end, reads the clean page this spec ends on.
  spec(
    "a page the test left by a link still reports its shift",
    `${BODY.lateShift}\n  await page.getByRole("link").click();\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
  // Input the browser counts: a click and keys. A sweep that took every shift
  // without asking whether the user had just acted fails this.
  spec("a page that moves because the user clicked or typed passes", BODY.acted),
  // Each of these sets the field with nothing the browser counts as input, and
  // each is called on a page, on a locator and on an element handle, in specs
  // of their own: a mark from one would cover the other's shift. A sweep that
  // took the browser's word alone fails every one.
  spec("a shift under page.fill passes", BODY.filled),
  spec(
    "a shift under a locator's fill passes",
    `  await page.goto("/acted");\n  await page.locator("#field").fill("x");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  spec(
    "a shift under an element handle's fill passes",
    `  await page.goto("/acted");\n  await (await page.locator("#field").elementHandle()).fill("x");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  spec(
    "a shift under page.selectOption passes",
    `  await page.goto("/acted");\n  await page.selectOption("#pick", "b");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  spec(
    "a shift under a locator's selectOption passes",
    `  await page.goto("/acted");\n  await page.locator("#pick").selectOption("b");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  spec(
    "a shift under page.setInputFiles passes",
    `  await page.goto("/acted");\n  await page.setInputFiles("#file", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  spec(
    "a shift under a locator's setInputFiles passes",
    `  await page.goto("/acted");\n  await page.locator("#file").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  // A frame's own actions are not marked, as the page says: a frame sits
  // under every page's and locator's action, and a wrapper there renames them.
  spec(
    "a shift under a frame's own fill fails",
    `  await page.goto("/acted");\n  await page.mainFrame().fill("#field", "x");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  // The banner moves the content while `fill` is still waiting for its
  // field. A sweep that excused the whole of a marked call passes both.
  spec(
    "a shift while page.fill waits for its field fails",
    `  await page.goto("/late-form");\n  await page.fill("#field", "x");`,
  ),
  spec(
    "a shift while a locator's fill waits for its field fails",
    `  await page.goto("/late-form");\n  await page.locator("#field").fill("x");`,
  ),
  // Two fills at once: the one for a field already there returns at once, and
  // the banner lands while the other still waits. A sweep whose actions shared
  // one opening moment passes this.
  spec(
    "a shift while one of two fills waits for its field fails",
    `  await page.goto("/late-form");\n  await Promise.all([page.fill("#field", "x"), page.fill("#now", "y")]);`,
  ),
  // The page's own event, on another field, while the fill waits for its own.
  // A sweep that opened the window at the first event of the run passes this.
  spec(
    "a page's own input event while page.fill waits excuses nothing",
    `  await page.goto("/self-input-wait");\n  await page.fill("#field", "x");`,
  ),
  // The same through `selectOption`, whose own events are no more trusted than
  // the page's.
  spec(
    "a page's own input event while selectOption waits excuses nothing",
    `  await page.goto("/self-input-wait");\n  await page.selectOption("#pick", "b");`,
  ),
  // The line a filled field asked for lands past the action's half-second. A
  // sweep that excused every shift once a field had been filled passes this.
  spec(SLOW_FILL, BODY.slowFill),
  // A sweep that looked its reporter up by name on every report passes this.
  spec("a page that replaces the reporter is still swept", `  await page.goto("/rebinds");`),
  // A sweep that took an `input` event as the user acting passes this.
  spec(
    "a page that dispatches input itself and then shifts fails",
    `  await page.goto("/self-input");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  // The click is the user's, and the panel it asked for arrives after their
  // half-second is up. A sweep that stopped counting once the user had acted at
  // all passes this.
  spec(
    "a shift that arrives long after the click fails",
    `  await page.goto("/slow-panel");\n  await page.click("#open");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  // Three moved elements whose names fill the page's sentence. A sweep that
  // wrote its advice into that sentence loses it to the cut.
  spec(
    "a shift of long-named elements keeps its score and its advice",
    `  await page.goto("/long-names-shift");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  spec("an embed that shifts its host fails the host", BODY.embedShift),
  spec("an allowlisted page's embed may shift it", BODY.embedShift, EMBED_ALLOWED),
  spec("an entry for a shifting embed covers no other page", BODY.lateShift, EMBED_ALLOWED),
  spec("an entry no test reaches costs nothing", `  await page.goto("/clean");`, EMBED_ALLOWED),
  // Nothing of the sweep's runs in a page without JavaScript, so nothing may
  // wait on it to answer: each of these would wait out the test's timeout.
  spec(
    "a page without JavaScript is left alone",
    `  test.setTimeout(5_000);\n  await page.goto("/acted");\n  await page.fill("#field", "x");\n  await page.goto("/clean");`,
    { javaScriptEnabled: false },
  ),
  // Scripting is disabled for it, so nothing the sweep's script schedules is
  // ever called back. A sweep that waited on its drain runs out the test's
  // timeout, and one whose script scheduled anything fails it on the error the
  // browser logs for each blocked callback.
  spec(
    "a sandboxed page without scripts is left alone",
    `  test.setTimeout(15_000);\n  await page.goto("/sandboxed");\n  await page.goto("/clean");`,
  ),
  // Each fails at once, so that what the run reports is the name Playwright
  // gave the call.
  ...NAMED.map(([name, body]) => spec(`a failing ${name} is named ${name}`, body)),
];

/**
 * A spec exactly as a consumer writes one: both exports by the specifiers the
 * repo contract names, and `expect` from Playwright's own package. Its own
 * Playwright run, because a spec whose imports do not load takes the whole run
 * down with it — the runner collects nothing and reports no case rather than
 * failing one, so sharing a process would answer every question above with this
 * question's failure.
 */
const INSTALLED = `import { expect } from "@playwright/test";
import { test } from "@gokayo43/dev-config/invariant-sweep";
import { ENDPOINT } from "@gokayo43/dev-config/route-log";

test("a consumer's spec runs", async ({ page }) => {
  // The runner is the whole question: a bun wearing node's name on PATH — the
  // workaround this change exists to delete — loads a \`.ts\` under node_modules
  // happily, and would leave this case proving nothing.
  expect(process.versions.bun).toBeUndefined();
  const answered = await page.goto(ENDPOINT);
  expect(answered?.status()).toBe(200);
  await page.goto("/clean");
  await expect(page.locator("p")).toHaveText("nothing wrong here");
});
`;

/**
 * The specs a recorded run is graded on: one page, two pages, a page that
 * breaks an invariant, since recording must not cost the sweep, and a file that
 * sets `video` for itself, which Playwright applies after every fixture the
 * package defines.
 */
const RECORDED = [
  spec(
    "one page leaves one video",
    `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
  spec(
    "a popup leaves a video of its own",
    `  await page.goto("/opens-clean");\n  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);\n  await expect(popup.locator("p")).toHaveText("nothing wrong here");`,
  ),
  spec("a console error still fails while recording", `  await page.goto("/console");`),
  spec(
    "a spec file's own video setting wins",
    `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
    { video: "off" },
  ),
];

/**
 * The pages whose verdict must not move from run to run, each run as a spec on
 * a quiet renderer and as one on a slowed renderer. A shift while the page
 * loads lands before anything has run in the page, and one after it lands
 * while the drain waits. A shift the user caused, and one under `fill`, are
 * where a slow frame could carry the shift past the half-second it counts as
 * theirs, and a shift long after `fill` is where a slow mark could stretch that
 * half-second over it. An allowlisted shift is where the verdict rests on the
 * entry, and a page that never shifts is where a slow load could move something
 * nobody moved.
 */
const STEADY = [
  { title: "a shift while the page loads", body: BODY.imageShift, passes: false },
  { title: "a shift after the page loaded", body: BODY.lateShift, passes: false },
  { title: "a shift the user caused", body: BODY.acted, passes: true },
  { title: "a shift under fill", body: BODY.filled, passes: true },
  { title: SLOW_FILL, body: BODY.slowFill, passes: false },
  { title: "an allowlisted shift", body: BODY.embedShift, use: EMBED_ALLOWED, passes: true },
  { title: "a page that never shifts", body: BODY.clean, passes: true },
] as const satisfies readonly { title: string; body: string; use?: Use; passes: boolean }[];

/** One page that breaks nothing, for the runs that grade what decides recording rather than what is recorded. */
const PLAIN = [
  spec(
    "a plain page",
    `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
];

/** Specs as the files one run is handed, named by their position so no two collide. */
function files(prefix: string, specs: readonly string[]): Record<string, string> {
  return Object.fromEntries(specs.map((written, index) => [`${prefix}-${index}.spec.ts`, written]));
}

/** The frames a config's `video.size` asks for, which no default comes to. */
const SIZE = { width: 320, height: 240 } as const;

let outcomes = new Map<string, Outcome>();
let installed = new Map<string, Outcome>();
let recorded = new Map<string, Outcome>();
let sized = new Map<string, Outcome>();
let configured = new Map<string, Outcome>();
let blank = new Map<string, Outcome>();
let steady = new Map<string, Outcome>();
const refusals = new Map<string, string>();
let stop = async (): Promise<void> => {};

beforeAll(async () => {
  const server = serving();
  stop = server.stop;
  const on = { E2E_VIDEO: "on" };
  // The config switches video off outright, which is what a default the config
  // replaces would lose to: the switch has to win over the config, not over
  // Playwright's own default.
  recorded = await sweeping(server.origin, files("recorded", RECORDED), {
    env: on,
    use: { video: "off" },
  });
  // The config's video in its object form, off, with a size of its own: the
  // switch turns it on and keeps the size.
  sized = await sweeping(server.origin, files("sized", PLAIN), {
    env: on,
    use: { video: { mode: "off", size: SIZE } },
  });
  // No switch, and a config that asks for video itself: what decides is the
  // config, as it did before the switch existed.
  configured = await sweeping(server.origin, files("plain", PLAIN), { use: { video: "on" } });
  // A blank switch is what a CI step exporting an empty input writes, and it is
  // unset.
  blank = await sweeping(server.origin, files("plain", PLAIN), { env: { E2E_VIDEO: " " } });
  for (const value of ["true", "off"]) {
    refusals.set(
      value,
      await sweeping(server.origin, files("plain", PLAIN), { env: { E2E_VIDEO: value } }).then(
        () => "",
        (error: Error) => error.message,
      ),
    );
  }
  outcomes = await sweeping(server.origin, files("case", CASES));
  installed = await sweeping(server.origin, { "consumer.spec.ts": INSTALLED });
  steady = await sweeping(
    server.origin,
    files(
      "steady",
      STEADY.flatMap(({ title, body, ...rest }) => [
        spec(`${title}, quiet`, body, "use" in rest ? rest.use : undefined),
        spec(
          `${title}, slowed`,
          `  const cdp = await context.newCDPSession(page);\n  await cdp.send("Emulation.setCPUThrottlingRate", { rate: ${SLOWDOWN} });\n${body}`,
          "use" in rest ? rest.use : undefined,
        ),
      ]),
    ),
    { repeatEach: RUNS },
  );
}, 300_000);

afterAll(async () => {
  await stop();
});

function outcome(title: string, run = outcomes): Outcome {
  const found = run.get(title);
  if (found === undefined) {
    throw new Error(
      `the Playwright run reported nothing for ${title}; it reported ${[...run.keys()].join(", ")}`,
    );
  }
  return found;
}

describe("what the sweep lets through", () => {
  test("a page that breaks nothing passes", () => {
    expect(outcome("a page that breaks nothing passes").ok).toBe(true);
  });

  test("an allowlisted embed's console error is tolerated", () => {
    expect(outcome("an allowlisted embed's console error is tolerated").ok).toBe(true);
  });

  // Playwright hands a pageerror no frame, so the embed's own throw is placed by
  // the URL in its stack. This passing is what says the allowlist could reach it
  // by the embed's address: keyed on the page's, the pattern would not match.
  // Documented, not fixed: the keys are unanchored regular expressions.
  test("an unanchored key reaches the page next door", () => {
    expect(outcome("an unanchored key reaches the page next door").ok).toBe(true);
  });

  test("an embed's thrown error is attributed to the embed", () => {
    expect(outcome("an embed's thrown error is attributed to the embed").ok).toBe(true);
  });

  test.each([
    "a page that moves because the user clicked or typed passes",
    "a shift under page.fill passes",
    "a shift under a locator's fill passes",
    "a shift under an element handle's fill passes",
    "a shift under page.selectOption passes",
    "a shift under a locator's selectOption passes",
    "a shift under page.setInputFiles passes",
    "a shift under a locator's setInputFiles passes",
    "an allowlisted page's embed may shift it",
    "an entry no test reaches costs nothing",
    "a page without JavaScript is left alone",
    "a sandboxed page without scripts is left alone",
  ])("%s", (title) => {
    const { ok, said } = outcome(title);
    expect(said).toBe("");
    expect(ok).toBe(true);
  });
});

describe("what the sweep catches", () => {
  test.each([
    [
      "a console error fails the test that visited it",
      "console.error",
      "a request this page depends on failed",
    ],
    ["a page that throws fails the test that visited it", "pageerror", "reading 'atAll'"],
    ["a page wider than its viewport fails", "overflow", "1600px of content in a 800px viewport"],
    ["overflow that appears after the page loaded fails", "overflow", "in a 800px viewport"],
    ["a page the test navigated away from is still swept", "overflow", "/overflow"],
    ["a page that overflows after load and is left at once is swept", "overflow", "/after-load"],
    ["an opener-written blank popup is swept like any other", "overflow", "about:blank"],
    ["a page reached by clicking a link is swept", "overflow", "/overflow"],
    [
      "an allowlist that matches nothing tolerates nothing",
      "console.error",
      "the embed is unhappy",
    ],
    ["our own error cannot wear a vendor's name", "console.error", "this one is ours"],
    [
      "an anchored key stops at the page it names",
      "console.error",
      "the almost-clean page is unhappy",
    ],
    [
      "a page that navigates on a timer still reports what it measured",
      "overflow",
      "in a 800px viewport",
    ],
    [
      "a popup is swept like any other page",
      "console.error",
      "a request this page depends on failed",
    ],
    ["overflow that arrives with a subresource is swept", "overflow", "img#slow"],
    ["a shift while the page loads fails", "layout-shift", "/image-shift"],
    ["a shift after the page loaded fails", "layout-shift", "/late-shift"],
    [SLOW_FILL, "layout-shift", "/slow-fill"],
    ["a page that replaces the reporter is still swept", "overflow", "/rebinds"],
    ["a shift under a frame's own fill fails", "layout-shift", "/acted"],
    ["a shift while page.fill waits for its field fails", "layout-shift", "/late-form"],
    ["a shift while a locator's fill waits for its field fails", "layout-shift", "/late-form"],
    ["a shift while one of two fills waits for its field fails", "layout-shift", "/late-form"],
    [
      "a page's own input event while page.fill waits excuses nothing",
      "layout-shift",
      "/self-input-wait",
    ],
    [
      "a page's own input event while selectOption waits excuses nothing",
      "layout-shift",
      "/self-input-wait",
    ],
    ["a page that dispatches input itself and then shifts fails", "layout-shift", "/self-input"],
    ["a page the test left by a link still reports its shift", "layout-shift", "/late-shift"],
    ["a shift that arrives long after the click fails", "layout-shift", "/slow-panel"],
    ["an embed that shifts its host fails the host", "layout-shift", "/shifting-embed"],
    ["an entry for a shifting embed covers no other page", "layout-shift", "/late-shift"],
    [
      "an allowlist key that is not a pattern says so",
      'sweepAllowlist key "(unclosed"',
      "is not a regular expression",
    ],
  ])("%s", (title, kind, detail) => {
    const { ok, said } = outcome(title);
    expect(ok).toBe(false);
    expect(said).toContain(kind);
    expect(said).toContain(detail);
  });

  // A frame from another origin can call the bridge — nothing stops it — so what
  // has to hold is that nothing it says survives: not the violation it invented,
  // not the bucket it chose, and not the escape codes or workflow command it
  // wrote into the sentence. The page's own overflow is still reported, which is
  // how a run that dropped everything is told from one that dropped the forgery.
  test("nothing a frame invents reaches the failure", () => {
    const { ok, said } = outcome("a frame cannot report a violation for the page carrying it");
    expect(ok).toBe(false);
    expect(said).toContain("overflow at");
    expect(said).toContain("div#wide");
    for (const forged of ["forged", "cdn.vendor", "a frame wrote this"]) {
      expect(said).not.toContain(forged);
    }
  });

  // The sentence in a violation is the page's, and a CI annotation prints it. No
  // control character survives, which is what makes both attacks inert: an ANSI
  // escape needs its ESC, and a `::error::` workflow command needs a line of its
  // own. The `::error` text itself remains, mid-sentence, where it is inert —
  // and asserting it away would be asserting something this does not do.
  test("no control character a page wrote reaches the annotation", () => {
    const { ok, said } = outcome(
      "a violation's own text cannot carry an escape or a workflow command",
    );
    expect(ok).toBe(false);
    // The runner colours its own diff, so the line is stripped of *that* before
    // anything is asserted about what the page managed to write.
    const line =
      said
        // oxlint-disable-next-line eslint/no-control-regex -- the control character is the subject: this strips the runner's own colouring so the assertions below are about what the page managed to write
        .replaceAll(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .find((each) => each.includes("overflow at")) ?? "";
    const detail = line.slice(line.indexOf("— ") + 2);

    expect(detail).toContain("div#wide");
    // `[31m` survives as plain text, which is precisely what says the ESC in
    // front of it was taken out by the fixture: had it survived, the strip above
    // would have removed the whole sequence and left nothing to find.
    expect(detail).toContain("[31m");
    // The newline is gone, so the workflow command cannot begin a line — which is
    // the only thing that would make it one. It is text where it sits, and
    // asserting it away would be asserting something this does not do.
    expect(detail).not.toContain("\n");
    expect(detail.indexOf("::error")).toBeGreaterThan(0);
  });

  // The verdict is the list the sweep spent the test collecting. A page that
  // goes while its own drain is in flight has nothing left to drain — whatever
  // it measured crossed as it was measured — and the one thing that must not
  // happen is the closure being reported in place of the violation.
  test("a page closing itself does not replace the verdict", () => {
    const { ok, said } = outcome("a popup that closes itself still reports what it measured");
    expect(ok).toBe(false);
    expect(said).toContain("the popup is unhappy");
    expect(said).not.toContain("Target page, context or browser has been closed");
  });

  // The diagnostic names the element, because "something is 800px too wide" is
  // a page nobody can fix and `div#wide` is one somebody can.
  test("an overflow diagnostic names what is sticking out", () => {
    expect(outcome("a page wider than its viewport fails").said).toContain("div#wide");
  });

  // Each of them exactly once. A sweep that lost one dropped a popup's first
  // word, and one that heard one twice would be listening on the page and the
  // context both, or counting Playwright's replay of what a popup said before it
  // was reported as a second message.
  test("an error a popup logs before it is reported is swept, once", () => {
    const { ok, said } = outcome("an error a popup logs before it is reported is swept");
    expect(ok).toBe(false);
    const heard = Array.from(
      { length: WRITTEN },
      (_, n) => said.split(`written popup ${n} is unhappy`).length - 1,
    );
    expect(heard).toEqual(Array.from({ length: WRITTEN }, () => 1));
  });

  // A stranger reads this in a repo they did not write: what moved, how far, and
  // what to do about it, on the page it moved on.
  test("a shift diagnostic names what moved, how far, and what to do", () => {
    const { said } = outcome("a shift after the page loaded fails");
    expect(said).toContain("layout-shift at ");
    expect(said).toContain("with no input in the 500ms before: main#content moved 60px down");
    expect(said).toMatch(/score 0\.\d{4}/);
    expect(said).toContain("reserve the space for whatever arrives late");
  });

  // The page's sentence is cut at a length, and what to do is not the page's to
  // say: it reaches the message whatever the page wrote.
  test("a shift diagnostic keeps its score and its advice past a long description", () => {
    const { ok, said } = outcome("a shift of long-named elements keeps its score and its advice");
    expect(ok).toBe(false);
    expect(said).toContain("…");
    expect(said).toMatch(/score 0\.\d{4}/);
    expect(said).toContain("reserve the space for whatever arrives late");
  });

  // The name Playwright gives a call is the first thing a consumer reads of a
  // failing one, and a wrapper is where it can go wrong.
  test.each(NAMED.map(([name]) => name))("a failing %s keeps its name", (name) => {
    const { ok, said } = outcome(`a failing ${name} is named ${name}`);
    expect(ok).toBe(false);
    expect(said).toContain(`${name}: `);
  });

  // What to do, not what went wrong: the allowlist is the other half of the fix.
  test("the diagnostic says what to do about it", () => {
    expect(outcome("a page wider than its viewport fails").said).toContain("sweepAllowlist");
  });
});

// Every shift counts, however early, so the verdict on a page whose shift is
// fixed has to come out the same on every run. A page whose shift comes and goes
// fails on the runs it shifts, which is the trade the export's page names.
describe("the shift verdict, run after run", () => {
  test.each(STEADY.map(({ title, passes }) => [title, passes] as const))(
    "%s comes out the same every run, quiet and slowed",
    (title, passes) => {
      for (const renderer of ["quiet", "slowed"]) {
        expect({ renderer, verdicts: outcome(`${title}, ${renderer}`, steady).verdicts }).toEqual({
          renderer,
          verdicts: Array.from({ length: RUNS }, () => passes),
        });
      }
    },
  );
});

// Draining is a wait, and a wait nobody bounds is a suite nobody runs. Both
// cases here are about what leaving a page costs, counted as the sleep the drain
// asked for rather than timed: a drain that waited on a cap, or on a same-document
// navigation, asks for seconds of it, and a loaded box asks for no more.
describe("what leaving a page costs", () => {
  test("an animated page is bounded by its cutoff, not by a cap", () => {
    const { ok, asked } = outcome("leaving an animated page costs no more than its budget");
    expect(ok).toBe(true);
    expect(asked).toHaveLength(1);
    for (const sleep of asked) expect(sleep).toBeLessThanOrEqual(HORIZON);
  });

  test("and a same-document navigation waits for nothing", () => {
    const { ok, asked } = outcome("a same-document navigation does not stall the next one");
    expect(ok).toBe(true);
    expect(asked).toEqual([0]);
  });
});

describe("recording a video of every page", () => {
  test.each([
    ["one page leaves one video", 1],
    ["a popup leaves a video of its own", 2],
  ])("%s, under a config that switched video off", (title, pages) => {
    const { ok, videos } = outcome(title, recorded);
    expect(ok).toBe(true);
    expect(videos).toHaveLength(pages);
    for (const { bytes } of videos) expect(bytes).toBeGreaterThan(0);
  });

  test("a recorded page is still swept", () => {
    const { ok, said, videos } = outcome("a console error still fails while recording", recorded);
    expect(ok).toBe(false);
    expect(said).toContain("a request this page depends on failed");
    expect(videos).toHaveLength(1);
  });

  test("the config's own video size is kept", () => {
    const { videos } = outcome("a plain page", sized);
    expect(videos.map(({ width, height }) => ({ width, height }))).toEqual([SIZE]);
  });

  test("a spec file that sets video itself keeps its own setting", () => {
    const { ok, videos } = outcome("a spec file's own video setting wins", recorded);
    expect(ok).toBe(true);
    expect(videos).toEqual([]);
  });

  test("without the switch, a config that asks for video records", () => {
    expect(outcome("a plain page", configured).videos).toHaveLength(1);
  });

  test("without the switch, a config that says nothing records nothing", () => {
    expect(outcome("a page that breaks nothing passes").videos).toEqual([]);
  });

  test("a blank switch is no switch", () => {
    const { ok, videos } = outcome("a plain page", blank);
    expect(ok).toBe(true);
    expect(videos).toEqual([]);
  });

  // A value read as off is a run that was asked for a recording and left none,
  // and went green doing it. `off` among them: the switch has one value.
  test.each(["true", "off"])("E2E_VIDEO=%s refuses the run and names the one value", (value) => {
    const refused = refusals.get(value) ?? "";
    expect(refused).toContain(`E2E_VIDEO is "${value}"`);
    expect(refused).toContain('the one value it takes is "on"');
  });
});

// The one way a consumer never imports these: by path. Every case above does,
// and none of them would notice what dev-config#113 was — that under the runner
// Playwright brings, a specifier resolving to a `.ts` inside `node_modules`
// cannot load at all (`tsdown.config.ts` has why). What has to hold is that
// these two do, by the specifiers the repo contract and the base config name.
describe("the exports a spec imports", () => {
  test("load from an installed package under Playwright's own runner", () => {
    const ran = installed.get("a consumer's spec runs");
    expect(ran?.said).toBe("");
    expect(ran?.ok).toBe(true);
  });
});
