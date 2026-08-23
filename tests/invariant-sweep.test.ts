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

${use}test(${JSON.stringify(title)}, async ({ page }) => {
${body}
});
`;
}

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
  // ...and an allowlist that names something else does not quietly cover it.
  "an allowlist that matches nothing tolerates nothing": spec(
    "an allowlist that matches nothing tolerates nothing",
    `  await page.goto("/embedded");`,
    { "/analytics\\.js$": "a pattern for an embed this page does not carry" },
  ),
};

let outcomes = new Map<string, Outcome>();
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
    ["a page reached by clicking a link is swept", "overflow", "/overflow"],
    [
      "an allowlist that matches nothing tolerates nothing",
      "console.error",
      "the embed is unhappy",
    ],
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
