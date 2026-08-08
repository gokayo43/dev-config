import { describe, expect, test } from "bun:test";

import { contract, manifestWith, withSpec } from "./repo-contract-fixture.ts";
import { containing } from "./matchers.ts";

/**
 * How a manifest's dependency specs are graded — the pin check over what this
 * repo installs, and the inverse rule over what it declares a consumer may
 * bring. Its own file because it is its own vocabulary, and because the rest of
 * the contract is about files rather than about version grammar.
 */
describe("how a dependency spec is graded", () => {
  test.each([
    "^0.61.0",
    "~0.61.0",
    ">=0.61.0",
    "0.61.0 - 0.62.0",
    "0.61.0 || 0.62.0",
    "*",
    "x",
    "latest",
    "next",
    "18",
    "1.x",
    "1.2",
    "v1.2.3",
    "npm:bar",
    "npm:@scope/pkg",
    "npm:bar@^1.2.3",
  ])("a floating spec (%s) is refused", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([
      containing(`devDependencies.oxfmt is declared as '${spec}'`),
    ]);
  });

  test.each([
    "0.61.0",
    "1.0.0-rc.3",
    "1.0.0+build.7",
    "workspace:*",
    "file:../local",
    "link:../local",
    "catalog:default",
    "github:gokayo43/dev-config#04d2938c7e1368d79169426d944107c9a0674fbc",
    "git+ssh://git@github.com/o/r.git#04d2938c7e1368d79169426d944107c9a0674fbc",
    "npm:@scope/other@1.2.3",
  ])("a spec that resolves to one thing (%s) passes", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([]);
  });

  // A tag can be repointed at any commit, `#main` moves by design, and
  // `#semver:` is a range wearing a fragment. Only a commit names one tree.
  test.each([
    "github:gokayo43/dev-config",
    "github:gokayo43/dev-config#",
    "github:gokayo43/dev-config#main",
    "github:gokayo43/dev-config#v0.8.3",
    "github:gokayo43/dev-config#semver:^1.0.0",
    "git+ssh://git@github.com/o/r.git#3f9a1c2",
  ])("a git ref that is not a commit (%s) is refused", async (spec) => {
    expect(await contract(withSpec("oxfmt", spec))).toEqual([containing("devDependencies.oxfmt")]);
  });

  async function peer(spec: unknown): Promise<string[]> {
    return await contract(
      manifestWith((contents) => (contents["peerDependencies"] = { react: spec })),
    );
  }

  // The field where a range is the point, so anything that constrains is fine —
  // including the two that read like wildcards and are not: `^0` and `0.x` both
  // exclude 1.x, which is the whole of what a caret on a zero major means.
  const CONSTRAINING = [
    ">=19",
    "^1.2.3 || ^2",
    "1.x",
    ">=1.2.3 <2",
    "19",
    "19.0.0",
    "^0",
    "0.x",
    "0 - 999",
    "v1.2.3",
  ];

  test.each(CONSTRAINING)("a peer range that constrains something (%s) passes", async (spec) => {
    expect(await peer(spec)).toEqual([]);
  });

  // A protocol names a source rather than a range, and floating is the point of
  // declaring one as a peer.
  test.each(["workspace:*", "github:owner/repo", "npm:other@^1"])(
    "a peer spec that names a source (%s) passes",
    async (spec) => {
      expect(await peer(spec)).toEqual([]);
    },
  );

  // The oracle rather than the author's opinion: whatever the gate lets through,
  // ask the resolver that will actually read it whether it would take any
  // version at all. A fixture list is only as good as whoever wrote it, and this
  // is the property the list is trying to stand for.
  test.each(CONSTRAINING)(
    "nothing the gate accepts (%s) is one bun would satisfy twice",
    (spec) => {
      expect(Bun.semver.satisfies("0.0.0", spec) && Bun.semver.satisfies("999999.0.0", spec)).toBe(
        false,
      );
    },
  );

  // What these accept is every version there is, which is what declaring no peer
  // says. The unions are the reason this is not a list of spellings: an `||`
  // takes everything as soon as ONE of its operands does, and a leading `v` is
  // legal range grammar that a pattern over the digits does not know.
  test.each([
    "*",
    "x",
    "X",
    "x.x",
    "x.x.x",
    ">=0",
    ">= 0",
    ">=0.0",
    ">=0.0.0",
    ">=0.0.0-0",
    ">=v0",
    ">=v0.0.0-0",
    ">0.0.0-0",
    "x || 1",
    "* || ^1",
    ">=0.0.0 || *",
  ])("a peer range that accepts every version (%s) is refused", async (spec) => {
    expect(await peer(spec)).toEqual([
      containing(`peerDependencies.react is declared as '${spec}' — a peer range that accepts`),
    ]);
  });

  // What `bun add <pkg>` writes when the manifest already lists <pkg> as an
  // optional peer (bun 1.3.11): the range is blanked and no devDependency is
  // added. Its own diagnostic, because it is the one of these with a cause the
  // author did not choose.
  test.each(["", " ", "\n"])(
    "an emptied peer range (%p) says where empty comes from",
    async (spec) => {
      const problems = await peer(spec);
      expect(problems).toEqual([containing("peerDependencies.react is empty")]);
      expect(problems[0]).toContain("optional peer");
    },
  );

  // Not a range at all: what it points at is not in this manifest, and it moves.
  test.each(["latest", "next", "beta", "latest || 1"])(
    "a peer range with a dist tag in it (%s) is refused",
    async (spec) => {
      expect(await peer(spec)).toEqual([
        containing(`peerDependencies.react is declared as '${spec}' — a peer range names versions`),
      ]);
    },
  );

  // A manifest is JSON and can hold anything. The bun diagnostic would be a lie
  // here: nothing wrote a number into this field by accident.
  test.each([19, null, true, { major: 19 }])(
    "a peer spec that is not a string (%p) says so",
    async (spec) => {
      expect(await peer(spec)).toEqual([containing("a peer range is a string")]);
    },
  );
});
