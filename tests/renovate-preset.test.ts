import { expect, test } from "bun:test";

import { MINIMUM_RELEASE_AGE } from "../.github/actions/repo-contract/repo-contract.ts";
import { isList, record } from "../.github/actions/_lib/gate.ts";

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

const NON_MAJOR = new Set(["patch", "minor", "pin", "digest"]);

/** Whether a rule can match a patch, minor, pin or digest update. */
function reachesNonMajor(rule: ReturnType<typeof record>): boolean {
  const types = rule["matchUpdateTypes"];
  return !isList(types) || types.some((type) => NON_MAJOR.has(String(type)));
}

// Renovate gives a grouped branch automerge only when every update in it has it
// (`config.upgrades.every((upgrade) => upgrade.automerge)`), so one update that
// may not merge itself, left in a group whose others may, stops the whole group
// merging itself. The wrong implementation is a rule that switches self-merge
// off for some package, such as the dev-config pins, and leaves it in
// "non-major dependencies".
test("an update that may not merge itself never rides in a group that does", () => {
  const rules = (isList(PRESET["packageRules"]) ? PRESET["packageRules"] : []).map(record);
  const held = rules.filter((rule) => rule["automerge"] === false && reachesNonMajor(rule));
  const merging = new Set(
    rules.filter((rule) => rule["automerge"] !== false).map((rule) => rule["groupName"]),
  );
  expect(held.length).toBeGreaterThan(0);
  expect(
    held
      .filter((rule) => typeof rule["groupName"] !== "string" || merging.has(rule["groupName"]))
      .map((rule) => String(rule["description"])),
  ).toEqual([]);
});
