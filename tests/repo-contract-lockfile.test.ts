import { describe, expect, test } from "bun:test";

import { containing } from "./matchers.ts";
import { CLEAN, contract } from "./repo-contract-fixture.ts";
import type { Tree } from "./tree.ts";

/**
 * The `oxlint-tsgolint` a repo's `bun.lock` resolved, held to the range the
 * resolved `oxlint` declares for it. Its own file because it mirrors
 * `lockfile.ts`: what an install resolved is a subject of its own beside what
 * a manifest declares.
 *
 * Every lock here is a `bun.lock` that `bun install` (1.4.0) wrote for a
 * manifest declaring the pair its name gives, never one typed by hand: the
 * reading is of a format bun owns. oxlint 1.80.0 declares `>=7.0.2001` for
 * tsgolint and 1.88.0 declares `>=7.0.2003`, so the two locks put the same
 * tsgolint on both sides of a range. A check against a constant floor, or
 * against the manifest's own spec, passes or fails both alike.
 */
describe("the oxlint-tsgolint bun.lock resolved", () => {
  async function withLock(captured: string): Promise<Tree> {
    return {
      ...CLEAN,
      "bun.lock": await Bun.file(new URL(`./bun-lock-${captured}.lock`, import.meta.url)).text(),
    };
  }

  test("passes inside the range the resolved oxlint declares for it", async () => {
    expect(await contract(await withLock("oxlint-1.80.0-tsgolint-7.0.2001"))).toEqual([]);
  });

  test("is refused outside that range, naming the range to move into", async () => {
    expect(await contract(await withLock("oxlint-1.88.0-tsgolint-7.0.2001"))).toEqual([
      containing(
        "bun.lock resolves oxlint-tsgolint 7.0.2001 beside oxlint 1.88.0, which declares >=7.0.2003 for it — move oxlint-tsgolint to a version inside >=7.0.2003",
      ),
    ]);
  });

  // A lock with no tsgolint in it holds nothing to compare. Whether the repo
  // owes the package is the manifest check's question, which this tree's
  // manifest answers by declaring it.
  test("holds nothing where the lock resolved no tsgolint", async () => {
    expect(await contract(await withLock("oxlint-1.88.0"))).toEqual([]);
  });

  test("a lock that will not parse is named, never passed", async () => {
    expect(
      await contract({ ...CLEAN, "bun.lock": '{\n  "lockfileVersion": 1,\n  "packages": {' }),
    ).toEqual([containing("is not valid JSON with comments")]);
  });
});
