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
 * The last block is a different subject, run on its own: the two exports a spec
 * imports, reached through a `node_modules` of the fixture's own under the
 * runner Playwright actually brings. Every case above imports the sweep by path,
 * which is the one way a consumer never has it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Outcome, serving, sweeping } from "./sweep-fixture.ts";

const SWEEP = JSON.stringify(`${import.meta.dir}/../invariant-sweep.ts`);

/**
 * One spec: the fixture's `test` under an optional allowlist, doing whatever the
 * body does. `expect` comes from Playwright's own package rather than through
 * this one, which is the import pair a consuming repo writes.
 */
function spec(title: string, body: string, allowlist?: Record<string, string>): string {
  const use =
    allowlist === undefined ? "" : `test.use({ sweepAllowlist: ${JSON.stringify(allowlist)} });\n`;
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

/** Each case's spec, by the title the reporter will call it. */
const CASES = {
  "a page that breaks nothing passes": spec(
    "a page that breaks nothing passes",
    `  await page.goto("/clean");\n  await expect(page.locator("p")).toHaveText("nothing wrong here");`,
  ),
  "a console error fails the test that visited it": spec(
    "a console error fails the test that visited it",
    `  await page.goto("/console");`,
  ),
  "a page that throws fails the test that visited it": spec(
    "a page that throws fails the test that visited it",
    `  await page.goto("/throws");`,
  ),
  "a page wider than its viewport fails": spec(
    "a page wider than its viewport fails",
    `  await page.goto("/overflow");`,
  ),
  // Overflow that appears after `load`, with no navigation of any kind: what a
  // client-rendered route change looks like from the outside.
  "overflow that appears after the page loaded fails": spec(
    "overflow that appears after the page loaded fails",
    `  await page.goto("/late");\n  await page.waitForTimeout(300);`,
  ),
  // Overflow the page lays out on a timer started by its own `load` event, on a
  // page the spec leaves at once. Nothing has measured it when `goto` resolves,
  // so what has to hold is that the outgoing document is given its say before
  // the navigation replaces it — a flush of the frames already scheduled finds
  // nothing here, because the layout that breaks has not happened yet.
  "a page that overflows after load and is left at once is swept": spec(
    "a page that overflows after load and is left at once is swept",
    `  await page.goto("/after-load");\n  await page.goto("/clean");`,
  ),
  // A document that is changing without pause has nothing more to say and no
  // gap in which to say so, so leaving it is bounded by the cutoff rather than
  // by a cap the runner holds. What this asserts is the cost, since the page
  // breaks no invariant either way.
  "leaving an animated page costs no more than its budget": spec(
    "leaving an animated page costs no more than its budget",
    Array.from({ length: DEPARTURES }, () => `  await page.goto("/animated");`).join("\n"),
  ),
  // The middle one is a fragment: a navigation with no new document behind it.
  // Nothing re-runs in the page, so a drain waiting on anything the runner arms
  // per navigation waits for a word that can no longer be spoken.
  "a same-document navigation does not stall the next one": spec(
    "a same-document navigation does not stall the next one",
    `  await page.goto("/clean");\n  await page.goto("/clean#section");\n  await page.goto("/clean");`,
  ),
  // The popup logs its violation and then goes, while the drain that would have
  // flushed it is still waiting. What it measured has already crossed; the run
  // must report that and not the closure.
  "a popup that closes itself still reports what it measured": spec(
    "a popup that closes itself still reports what it measured",
    `  await page.goto("/opens-self-closing");\n  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);\n  await popup.waitForLoadState();`,
  ),
  // A popup its opener wrote into carries the URL of the page every context
  // starts on, and nothing about the sweep reads that URL: it is watched,
  // measured and drained like any other document.
  "an opener-written blank popup is swept like any other": spec(
    "an opener-written blank popup is swept like any other",
    `  await page.goto("/opens-blank");\n  await Promise.all([context.waitForEvent("page"), page.click("#open")]);`,
  ),
  // The page the spec ended on is clean. A sweep that looked once, at the end,
  // reports nothing here.
  "a page the test navigated away from is still swept": spec(
    "a page the test navigated away from is still swept",
    `  await page.goto("/overflow");\n  await page.getByRole("link").click();\n  await expect(page.locator("p")).toBeVisible();`,
  ),
  // Arrived at by a click, so nothing called `goto` for it.
  "a page reached by clicking a link is swept": spec(
    "a page reached by clicking a link is swept",
    `  await page.goto("/clean");\n  await page.getByRole("link").click();\n  await expect(page.locator("#wide")).toBeAttached();`,
  ),
  // The console error comes from /embed.js, so the allowlist names the embed
  // rather than every page that carries it.
  "an allowlisted embed's console error is tolerated": spec(
    "an allowlisted embed's console error is tolerated",
    `  await page.goto("/embedded");`,
    { "/embed\\.js$": "the embed logs a failed beacon on every load; it is not ours to fix" },
  ),
  // The keys are written by hand in a config file, so a bad one has to say
  // which key and which option rather than surfacing as a bare SyntaxError.
  "an allowlist key that is not a pattern says so": spec(
    "an allowlist key that is not a pattern says so",
    `  await page.goto("/clean");`,
    { "(unclosed": "a pattern nobody balanced" },
  ),
  // A `//# sourceURL=` comment is a claim any script can make about itself, and
  // the console repeats the claim. Honouring it unchecked lets an inline script
  // of *ours* wear a vendor's name and land in the vendor's allowlist bucket.
  "our own error cannot wear a vendor's name": spec(
    "our own error cannot wear a vendor's name",
    `  await page.goto("/forged-source");`,
    { "cdn\\.vendor": "the vendor embed logs a failed beacon on every load" },
  ),
  // A frame from another origin calling the bridge: it can neither invent a
  // violation nor choose which bucket one lands in.
  "a frame cannot report a violation for the page carrying it": spec(
    "a frame cannot report a violation for the page carrying it",
    `  await page.goto("/hostile-frame");\n  await page.waitForTimeout(300);`,
  ),
  // An embed's own thrown error is the embed's, and the allowlist has to be able
  // to reach it by the embed's address rather than by the page's.
  "an embed's thrown error is attributed to the embed": spec(
    "an embed's thrown error is attributed to the embed",
    `  await page.goto("/frame-throws");\n  await page.waitForTimeout(300);`,
    { "throws\\.html$": "the embed throws on load; it is not ours to fix" },
  ),
  // A page that navigates out from under the flush still gets its verdict.
  "a page that navigates on a timer still reports what it measured": spec(
    "a page that navigates on a timer still reports what it measured",
    `  await page.goto("/self-navigating");\n  await page.waitForTimeout(200);`,
  ),
  // Opened in a tab of its own: a page fixture never sees it, and a context one
  // does.
  "a popup is swept like any other page": spec(
    "a popup is swept like any other page",
    `  await page.goto("/popup");\n  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);\n  await popup.waitForLoadState();`,
  ),
  // A real violation whose description is hostile: the page writes the escape
  // codes and the workflow command, and the annotation must carry neither.
  "a violation's own text cannot carry an escape or a workflow command": spec(
    "a violation's own text cannot carry an escape or a workflow command",
    `  await page.goto("/noisy-overflow");\n  await page.waitForTimeout(200);`,
  ),
  // Overflow that arrives with an image's bytes, long after load and without a
  // single change to the DOM.
  "overflow that arrives with a subresource is swept": spec(
    "overflow that arrives with a subresource is swept",
    `  await page.goto("/late-image");\n  await page.waitForTimeout(700);`,
  ),
  // The keys are regular expressions and nothing anchors them, so a page name
  // is a prefix of its neighbour's. Pinned in both directions, because the
  // alternative — anchoring a key that happens to contain no metacharacter —
  // would anchor exactly the keys that are not URLs, every real one having a dot.
  "an unanchored key reaches the page next door": spec(
    "an unanchored key reaches the page next door",
    `  await page.goto("/cleanish");`,
    { "/clean": "the clean page's own embed" },
  ),
  "an anchored key stops at the page it names": spec(
    "an anchored key stops at the page it names",
    `  await page.goto("/cleanish");`,
    { "/clean$": "the clean page's own embed" },
  ),
  // ...and an allowlist that names something else does not quietly cover it.
  "an allowlist that matches nothing tolerates nothing": spec(
    "an allowlist that matches nothing tolerates nothing",
    `  await page.goto("/embedded");`,
    { "/analytics\\.js$": "a pattern for an embed this page does not carry" },
  ),
};

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

let outcomes = new Map<string, Outcome>();
let installed = new Map<string, Outcome>();
let stop = async (): Promise<void> => {};

beforeAll(async () => {
  const server = serving();
  stop = server.stop;
  outcomes = await sweeping(
    server.origin,
    Object.fromEntries(
      Object.values(CASES).map((written, index) => [`case-${index}.spec.ts`, written]),
    ),
  );
  installed = await sweeping(server.origin, { "consumer.spec.ts": INSTALLED });
}, 180_000);

afterAll(async () => {
  await stop();
});

function outcome(title: string): Outcome {
  const found = outcomes.get(title);
  if (found === undefined) {
    throw new Error(
      `the Playwright run reported nothing for ${title}; it reported ${[...outcomes.keys()].join(", ")}`,
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
