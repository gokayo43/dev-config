import { describe, expect, test } from "bun:test";

import { containing } from "./matchers.ts";
import { contract, withReleaseAge } from "./repo-contract-fixture.ts";

/**
 * How a bunfig's release-age window and its exclusions are graded. Its own file
 * because it is its own pair of keys, and because the contract's main suite
 * sits at the line ceiling.
 */
describe("the release-age window", () => {
  // The fleet's window is 3 days, and it is a floor: a repo holding releases for
  // a week passes, and one a second short of 3 days does not. Two wrong
  // implementations die here: a gate asking only for a window above zero, which
  // passes a single second, and one asking for the fleet's number exactly, which
  // refuses the week.
  test.each([
    ["3 days", "minimumReleaseAge = 259200\n", []],
    ["7 days", "minimumReleaseAge = 604800\n", []],
    [
      "a second short of 3 days",
      "minimumReleaseAge = 259199\n",
      [containing("minimumReleaseAge must hold new releases for at least 3 days")],
    ],
    [
      "a duration bun cannot read",
      'minimumReleaseAge = "3 days"\n',
      [containing("minimumReleaseAge must hold new releases for at least 3 days")],
    ],
  ])("a release-age window of %s", async (_what, window, expected) => {
    expect(await contract(withReleaseAge(window))).toEqual([...expected]);
  });

  // Bun matches an exclusion against a whole package name: under `"@types/*"`,
  // `"@types/"` and `"@types"` alike `@types/bun` stays held (probed, bun
  // 1.4.0). So the wrong implementations are a gate that never reads the list,
  // which passes the patterns below, one that refuses any exclusion, which
  // fails the exact names, and one that looks only for a `*`.
  test("exclusions pass when each names a package exactly", async () => {
    const excludes = 'minimumReleaseAgeExcludes = ["@types/node", "typescript"]\n';
    expect(await contract(withReleaseAge(`minimumReleaseAge = 259200\n${excludes}`))).toEqual([]);
  });

  test("every exclusion that names no package is refused by name", async () => {
    const excludes =
      'minimumReleaseAgeExcludes = ["@gokayo43/*", "typescript", "@types/", "@types"]\n';
    expect(await contract(withReleaseAge(`minimumReleaseAge = 259200\n${excludes}`))).toEqual([
      containing('lists "@gokayo43/*", which exempts nothing'),
      containing('lists "@types/", which exempts nothing'),
      containing('lists "@types", which exempts nothing'),
    ]);
  });
});
