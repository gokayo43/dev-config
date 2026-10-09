import { expect, test } from "bun:test";

import { MINIMUM_RELEASE_AGE } from "../.github/actions/repo-contract/repo-contract.ts";
import { record } from "../.github/actions/_lib/gate.ts";

const PRESET = record(await Bun.file(new URL("../default.json", import.meta.url)).json());

const BUNFIG = record(
  Bun.TOML.parse(await Bun.file(new URL("../bunfig.toml", import.meta.url)).text()),
);

/** The preset's window in seconds, from the `<n> days` Renovate reads. */
function presetWindow(): number {
  const written = String(PRESET["minimumReleaseAge"]);
  const days = /^(\d+) days?$/.exec(written)?.[1];
  if (days === undefined) throw new Error(`default.json's minimumReleaseAge is ${written}`);
  return Number(days) * 86_400;
}

// A Renovate PR holding a version younger than a consumer's own bunfig window
// fails that consumer's `bun install`. The repo contract's floor is the least a
// consumer may declare, so a preset below it fails every consumer that
// declares the floor, this repo first, since it extends the preset too. Whether
// it fails a consumer declaring more is the slowest-bunfig rule in README's
// Version policy, and that consumer's bunfig is outside this suite. The wrong
// implementation is a preset moved below the bunfigs it serves.
test("the preset waits no less than any bunfig it serves", () => {
  expect(presetWindow()).toBeGreaterThanOrEqual(MINIMUM_RELEASE_AGE);
  expect(presetWindow()).toBeGreaterThanOrEqual(
    Number(record(BUNFIG["install"])["minimumReleaseAge"]),
  );
});
