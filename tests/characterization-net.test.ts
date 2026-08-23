/**
 * The characterization-net harness, driven over a fixture net whose app the
 * case controls.
 *
 * Every discipline the module claims is attacked here by the run that would
 * pass if it were absent: a re-baseline that wrote the raw capture, a
 * comparison against committed bytes, a rewrite that touched an unchanged file,
 * an overwrite nobody blessed, a golden that pinned a body without its status,
 * a fixture whose case was deleted, and a shard split that is not a function of
 * the case list.
 */
import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";

import { assertNet, type Net, type Rebaseline, rebaselineNet } from "../characterization-net.ts";
import { containing } from "./matchers.ts";
import { materialise, type Tree } from "./tree.ts";

/** What the fixture app is doing right now — the half a case changes to make behaviour move. */
interface World {
  readonly status: number;
  readonly greeting: string;
}

const CASES = ["alpha", "beta", "gamma", "delta", "epsilon"];

/** The volatile field every capture carries and every golden must not. */
const VOLATILE = "at";

const SETTLED = "<when>";

/**
 * A net over five cases, whose app answers out of `world` and whose normaliser
 * replaces the one field that would differ between two runs a millisecond apart.
 */
/** What the fixture app answers with, including the one field two runs disagree about. */
interface Answer {
  readonly greeting: string;
  readonly name: string;
  readonly [VOLATILE]: number | string;
}

function netOver(
  dir: string,
  world: () => World,
  cases: readonly string[] = CASES,
): Net<string, Answer> {
  return {
    cases,
    dir,
    nameOf: (subject) => subject,
    capture: async (subject) => {
      const { status, greeting } = world();
      return await Promise.resolve({
        status,
        body: { greeting, name: subject, [VOLATILE]: Date.now() },
      });
    },
    // Typed all the way through, which is the point of the body being a type
    // parameter: a consuming repo's normaliser narrows nothing and casts nothing.
    normalize: ({ status, body }) => ({ status, body: { ...body, [VOLATILE]: SETTLED } }),
  };
}

const CALM: World = { status: 200, greeting: "hello" };

/** A fixture directory, optionally already holding files. */
async function goldens(tree: Tree = {}): Promise<string> {
  return await materialise(tree);
}

async function golden(dir: string, name: string): Promise<string> {
  return await readFile(`${dir}/${name}.json`, "utf8");
}

/** A net recorded once, which is where every case below starts. */
async function recorded(world: World = CALM): Promise<{ dir: string; report: Rebaseline }> {
  const dir = await goldens();
  const report = await rebaselineNet(netOver(dir, () => world));
  return { dir, report };
}

describe("recording a net", () => {
  test("a first run creates every golden and needs no blessing", async () => {
    const { report } = await recorded();
    expect(report.failures).toEqual([]);
    expect(report.wrote).toEqual(CASES);
  });

  // The one build path, seen from outside: what a re-baseline puts on disk is
  // what the asserting path would compare, normaliser and all. A re-baseline
  // that wrote the raw capture would leave a real timestamp here.
  test("what it writes is what the assert path compares", async () => {
    const { dir } = await recorded();
    expect(await golden(dir, "alpha")).toContain(`"${VOLATILE}": "${SETTLED}"`);
  });

  test("and the run it recorded then passes", async () => {
    const { dir } = await recorded();
    const report = await assertNet(netOver(dir, () => CALM));
    expect(report.failures).toEqual([]);
    expect(report.ran).toEqual(CASES);
  });
});

describe("what the net refuses", () => {
  test("a case with no golden fails rather than passing quietly", async () => {
    const { dir } = await recorded();
    const report = await assertNet(netOver(dir, () => CALM, [...CASES, "zeta"]));
    expect(report.failures).toEqual([containing("zeta has no golden")]);
  });

  test("a body that changed fails, and the diagnostic shows both", async () => {
    const { dir } = await recorded();
    const [failure = ""] = (await assertNet(netOver(dir, () => ({ ...CALM, greeting: "goodbye" }))))
      .failures;
    expect(failure).toContain("alpha does not match its golden");
    expect(failure).toContain("goodbye");
    expect(failure).toContain("hello");
  });

  // Status is in the golden by construction. A net whose fixture held only the
  // body would call this run identical.
  test("a status that changed fails on a body that did not", async () => {
    const { dir } = await recorded();
    const report = await assertNet(netOver(dir, () => ({ ...CALM, status: 500 })));
    expect(report.failures).toHaveLength(CASES.length);
    expect(report.failures[0]).toContain("does not match its golden");
  });

  // A case that was deleted and a fixture that was not. Nothing else in the run
  // ever looks at that file again.
  test("a golden no case claims fails", async () => {
    const { dir } = await recorded();
    await writeFile(`${dir}/omega.json`, `{ "status": 200, "body": null }\n`, "utf8");
    const report = await assertNet(netOver(dir, () => CALM));
    expect(report.failures).toEqual([containing("omega.json is a golden no case claims")]);
  });

  test.each(["", "nested/name", "back\\slash"])(
    "a golden name that cannot be a file in one directory (%p) fails",
    async (name) => {
      const dir = await goldens();
      const report = await assertNet(netOver(dir, () => CALM, [name]));
      expect(report.failures).toHaveLength(1);
      expect(report.ran).toEqual([]);
    },
  );

  // A capture is a request against the app. A case whose golden could never be
  // found is not one to send a request for, so the name is checked first.
  test("a case with an unusable name is never captured", async () => {
    const dir = await goldens();
    const asked: string[] = [];
    const net = netOver(dir, () => CALM, ["nested/name", "alpha"]);
    await assertNet({
      ...net,
      capture: async (subject) => {
        asked.push(subject);
        return await net.capture(subject);
      },
    });
    expect(asked).toEqual(["alpha"]);
  });

  test.each([
    ['{ "body": { "greeting": "hello" } }', "an object with no status"],
    ['[{ "status": 200 }]', "a list"],
    ['"just a string"', "a scalar"],
    ["{ not json", "not JSON at all"],
  ])("a golden that is %p (%s) is refused rather than parsed around", async (written) => {
    const { dir } = await recorded();
    await writeFile(`${dir}/alpha.json`, `${written}\n`, "utf8");
    const report = await assertNet(netOver(dir, () => CALM));
    expect(report.failures).toEqual([containing("alpha's golden is not a capture")]);
  });

  // A net nobody has recorded yet: every case is missing its golden, and the
  // directory that would hold them is not there either.
  test("a net with no directory reports every case rather than throwing", async () => {
    const report = await assertNet(netOver(`${await goldens()}/never-recorded`, () => CALM));
    expect(report.failures).toHaveLength(CASES.length);
    expect(report.failures[0]).toContain("has no golden");
  });
});

describe("the committed golden is re-normalised, not trusted", () => {
  // Hand-written with the volatile field still in it, as a golden recorded
  // before the normaliser learned about that field would be. Comparing bytes
  // fails here; comparing what today's normaliser makes of it does not.
  test("a golden the normaliser would still change compares equal", async () => {
    const { dir } = await recorded();
    await writeFile(
      `${dir}/alpha.json`,
      `${JSON.stringify({
        status: CALM.status,
        body: { greeting: CALM.greeting, name: "alpha", [VOLATILE]: 1712345678901 },
      })}\n`,
      "utf8",
    );
    expect((await assertNet(netOver(dir, () => CALM))).failures).toEqual([]);
  });
});

describe("re-baselining an existing net", () => {
  // The diff of a re-baseline has to be exactly the behaviour delta, and a file
  // rewritten byte-for-byte is a line of noise in it.
  test("a golden that would not change is not written", async () => {
    const { dir } = await recorded();
    const before = await stat(`${dir}/alpha.json`);
    const report = await rebaselineNet(netOver(dir, () => CALM));
    expect(report.wrote).toEqual([]);
    expect((await stat(`${dir}/alpha.json`)).mtimeMs).toBe(before.mtimeMs);
  });

  test("a golden that would change is refused when nothing blessed it", async () => {
    const { dir } = await recorded();
    const was = await golden(dir, "alpha");
    const report = await rebaselineNet(netOver(dir, () => ({ ...CALM, greeting: "goodbye" })));
    expect(report.wrote).toEqual([]);
    expect(report.failures).toHaveLength(CASES.length);
    expect(report.failures[0]).toContain("blessed nothing");
    expect(await golden(dir, "alpha")).toBe(was);
  });

  test.each(["", "   "])("a blessing that says nothing (%p) blesses nothing", async (blessing) => {
    const { dir } = await recorded();
    const report = await rebaselineNet(
      netOver(dir, () => ({ ...CALM, greeting: "goodbye" })),
      blessing,
    );
    expect(report.wrote).toEqual([]);
  });

  test("a blessed change is written", async () => {
    const { dir } = await recorded();
    const report = await rebaselineNet(
      netOver(dir, () => ({ ...CALM, greeting: "goodbye" })),
      "the greeting copy changed in #412",
    );
    expect(report.failures).toEqual([]);
    expect(report.wrote).toEqual(CASES);
    expect(await golden(dir, "alpha")).toContain("goodbye");
  });

  // The two refusals a re-baseline shares with an assert, since a re-baseline is
  // the run that would otherwise entrench either of them.
  test("a golden no case claims fails a re-baseline too", async () => {
    const { dir } = await recorded();
    await writeFile(`${dir}/omega.json`, `{ "status": 200, "body": null }\n`, "utf8");
    const report = await rebaselineNet(netOver(dir, () => CALM));
    expect(report.failures).toEqual([containing("omega.json is a golden no case claims")]);
  });

  test("a golden name that cannot be a file fails a re-baseline too", async () => {
    const dir = await goldens();
    const report = await rebaselineNet(netOver(dir, () => CALM, ["nested/name"]));
    expect(report.failures).toEqual([containing("path separator")]);
    expect(report.wrote).toEqual([]);
  });

  // A new case has no behaviour to regress, so recording it is not a blessing.
  test("a case added to a recorded net is created without one", async () => {
    const { dir } = await recorded();
    const report = await rebaselineNet(netOver(dir, () => CALM, [...CASES, "zeta"]));
    expect(report.failures).toEqual([]);
    expect(report.wrote).toEqual(["zeta"]);
  });
});

describe("sharding is a function of the case list", () => {
  async function ranAt(dir: string, count: number): Promise<string[][]> {
    const net = netOver(dir, () => CALM);
    return await Promise.all(
      Array.from(
        { length: count },
        async (_, index) => (await assertNet(net, { index, count })).ran,
      ),
    );
  }

  test.each([1, 2, 3, 5, 8])("%i shards cover every case exactly once", async (count) => {
    const { dir } = await recorded();
    const shards = await ranAt(dir, count);
    expect(shards.flat().toSorted()).toEqual(CASES.toSorted());
  });

  test.each([2, 3])("each shard keeps the order the case list had (%i shards)", async (count) => {
    const { dir } = await recorded();
    for (const shard of await ranAt(dir, count)) {
      expect(shard).toEqual(CASES.filter((name) => shard.includes(name)));
    }
  });

  test("the same split comes out of two runs at the same parallelism", async () => {
    const { dir } = await recorded();
    expect(await ranAt(dir, 3)).toEqual(await ranAt(dir, 3));
  });

  // A shard sees a fraction of the cases, so every golden the other shards own
  // would look like an orphan to it.
  test("a shard reconciles nothing, because it cannot", async () => {
    const { dir } = await recorded();
    const report = await assertNet(
      netOver(dir, () => CALM),
      { index: 0, count: 2 },
    );
    expect(report.failures).toEqual([]);
    expect(report.ran.length).toBeLessThan(CASES.length);
  });
});

describe("every run answers with a summary", () => {
  test.each([
    ["a passing run", CALM],
    ["a failing one", { status: 500, greeting: "goodbye" } satisfies World],
  ])("%s says how many cases and how many failures", async (_, world) => {
    const { dir } = await recorded();
    const { summary, failures } = await assertNet(netOver(dir, () => world));
    expect(summary).toBe(
      `characterization net: ${CASES.length} cases, ${failures.length} failures`,
    );
  });

  // The blessing is what justified overwriting a golden, and a re-baseline is
  // reviewed as the delta it wrote — so the sentence lands beside the count
  // rather than only in whoever typed it.
  test("a blessed re-baseline says what blessed it", async () => {
    const { dir } = await recorded();
    const { summary } = await rebaselineNet(
      netOver(dir, () => ({ ...CALM, greeting: "goodbye" })),
      "the greeting copy changed in #412",
    );
    expect(summary).toContain(
      `wrote ${CASES.length}, blessed: "the greeting copy changed in #412"`,
    );
  });

  // Creating goldens is not blessing anything, and the summary has to say which
  // of the two happened.
  test("a first run says it needed no blessing", async () => {
    const { report } = await recorded();
    expect(report.summary).toContain(`wrote ${CASES.length} new, none of which needed blessing`);
  });

  test("a run that changed nothing says so", async () => {
    const { dir } = await recorded();
    expect((await rebaselineNet(netOver(dir, () => CALM))).summary).toContain("no golden changed");
  });

  test("a shard says which shard it was", async () => {
    const { dir } = await recorded();
    const { summary } = await assertNet(
      netOver(dir, () => CALM),
      { index: 1, count: 4 },
    );
    expect(summary).toContain("shard 2 of 4");
  });

  // A net with nothing in it still reports, because the sentence a driver reads
  // has to exist whether or not there was anything to run.
  test("a net with no cases still reports", async () => {
    const dir = await goldens();
    const { summary, failures } = await assertNet(netOver(dir, () => CALM, []));
    expect(summary).toBe("characterization net: 0 cases, 0 failures");
    expect(failures).toEqual([]);
  });
});
