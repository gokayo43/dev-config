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

import { type Outcome, serving, sweeping, type Use, WRITTEN } from "./sweep-fixture.ts";

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
 * What one departure from a page may cost, in ms.
 *
 * The drain is the document's own answer, and a document that is changing
 * without pause gives it at twice the quiet window — a second, whatever the page
 * is doing. The rest of the budget is the browser's own navigation and enough
 * slack that a loaded box does not decide a verdict. What it is a bound against
 * is the shape that had the runner hold the clock: a page that never went quiet
 * cost the runner's whole cap every time it was left, which measured 5s a
 * departure and 25s across the five below.
 */
const A_DEPARTURE = 2_000;

/** How many times the animated case leaves the page, which is what its budget multiplies. */
const DEPARTURES = 5;

/**
 * How long a spec stays on a page that does nothing before acting on it, in ms:
 * twice the quiet window, so whatever the spec does next happens on a page that
 * has settled, and a sweep that counted it would have to say so.
 */
const SETTLED = 1_000;

/** Every case's spec; the reporter's outcome for each is found by its title. */
const CASES = [
  spec(
    "a page that breaks nothing passes",
    `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
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
  // by a cap the runner holds. What this asserts is the cost, since the page
  // breaks no invariant either way.
  spec(
    "leaving an animated page costs no more than its budget",
    Array.from({ length: DEPARTURES }, () => `  await page.goto("/animated");`).join("\n"),
  ),
  // The middle one is a fragment: a navigation with no new document behind it.
  // Nothing re-runs in the page, so a drain waiting on anything the runner arms
  // per navigation waits for a word that can no longer be spoken.
  spec(
    "a same-document navigation does not stall the next one",
    `  await page.goto("/clean");\n  await page.goto("/clean#section");\n  await page.goto("/clean");`,
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
  // The bar grows before the page settles, every time and at the latest moment
  // it was measured at on the stats site. A sweep that counted the whole load
  // fails this.
  spec(
    "a shift before the page settled is not counted",
    `  await page.goto("/early-shift?at=415");\n  await expect(page.locator("#bar")).toHaveCSS("height", "48px");`,
  ),
  // The page as it was measured: whether the bar grows, and when, is drawn on
  // every load, and the verdict may not depend on the draw.
  spec(
    "a page whose early shift comes and goes passes",
    `  await page.goto("/early-shift");\n  await page.waitForTimeout(${SETTLED});`,
  ),
  spec(
    "a shift after the page settled fails",
    `  await page.goto("/late-shift");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  // Left by a click, so nothing drains the page: what it saw has to have
  // crossed as it happened. A sweep that read the page's shifts once, at the
  // end, reads the clean page this spec ends on.
  spec(
    "a page the test left by a link still reports its shift",
    `  await page.goto("/late-shift");\n  await expect(page.locator("#banner")).toBeAttached();\n  await page.getByRole("link").click();\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
  // Input the browser counts: a click and keys. A sweep that took every shift
  // without asking whether the user had just acted fails this.
  spec(
    "a page that moves because the user clicked or typed passes",
    `  await page.goto("/acted");\n  await page.waitForTimeout(${SETTLED});\n  await page.click("#open");\n  await page.locator("#grow").pressSequentially("a\\nb\\nc");\n  await expect(page.locator("#panel p")).toHaveCount(1);`,
  ),
  // Input the browser does not count, because Playwright changes the field
  // directly and dispatches the events a person's typing would have: `fill`
  // and `selectOption`. A sweep that asked only the browser fails this.
  spec(
    "a page that moves because the spec filled a field or chose an option passes",
    `  await page.goto("/acted");\n  await page.waitForTimeout(${SETTLED});\n  await page.fill("#field", "x");\n  await page.selectOption("#pick", "b");\n  await expect(page.locator("#panel p")).toHaveCount(2);`,
  ),
  // The click is the user's, and the panel it asked for arrives after their
  // half-second is up. A sweep that stopped counting once the user had acted at
  // all passes this.
  spec(
    "a shift that arrives long after the click fails",
    `  await page.goto("/slow-panel");\n  await page.waitForTimeout(${SETTLED});\n  await page.click("#open");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  // Never quiet, so never settled, so its late shift is never counted: pinned,
  // because counting from the cutoff a restless page is drained at instead is a
  // boundary a shift lands either side of from one run to the next.
  spec(
    "a page that never goes quiet is not held to the shift invariant",
    `  await page.goto("/restless-shift");\n  await expect(page.locator("#banner")).toBeAttached();`,
  ),
  spec(
    "an embed that shifts its host fails the host",
    `  await page.goto("/shifting-embed");\n  await expect(page.locator("#widget")).toHaveCSS("height", "80px");`,
  ),
  spec(
    "an allowlisted page's embed may shift it",
    `  await page.goto("/shifting-embed");\n  await expect(page.locator("#widget")).toHaveCSS("height", "80px");`,
    { sweepAllowlist: { "/shifting-embed$": "the widget sizes itself once it has loaded" } },
  ),
  spec(
    "an entry for a shifting embed covers no other page",
    `  await page.goto("/late-shift");\n  await expect(page.locator("#banner")).toBeAttached();`,
    { sweepAllowlist: { "/shifting-embed$": "the widget sizes itself once it has loaded" } },
  ),
  spec("an entry no test reaches costs nothing", `  await page.goto("/clean");`, {
    sweepAllowlist: { "/shifting-embed$": "the widget sizes itself once it has loaded" },
  }),
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
    "a shift before the page settled is not counted",
    "a page whose early shift comes and goes passes",
    "a page that moves because the user clicked or typed passes",
    "a page that moves because the spec filled a field or chose an option passes",
    "a page that never goes quiet is not held to the shift invariant",
    "an allowlisted page's embed may shift it",
    "an entry no test reaches costs nothing",
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
    ["a shift after the page settled fails", "layout-shift", "/late-shift"],
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
    const { said } = outcome("a shift after the page settled fails");
    expect(said).toContain("main#content moved 60px down");
    expect(said).toContain("with no input in the 500ms before");
    expect(said).toContain("reserve the space for whatever arrived late");
  });

  // What to do, not what went wrong: the allowlist is the other half of the fix.
  test("the diagnostic says what to do about it", () => {
    expect(outcome("a page wider than its viewport fails").said).toContain("sweepAllowlist");
  });
});

// Draining is a wait, and a wait nobody bounds is a suite nobody runs. Both
// cases here are about what leaving a page costs, and both were minutes rather
// than seconds when the runner held the clock instead of the document.
describe("what leaving a page costs", () => {
  test("an animated page is bounded by its cutoff, not by a cap", () => {
    const { ok, took } = outcome("leaving an animated page costs no more than its budget");
    expect(ok).toBe(true);
    expect(took).toBeLessThan(DEPARTURES * A_DEPARTURE);
  });

  test("and a same-document navigation waits for nothing", () => {
    const { ok, took } = outcome("a same-document navigation does not stall the next one");
    expect(ok).toBe(true);
    expect(took).toBeLessThan(A_DEPARTURE);
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
