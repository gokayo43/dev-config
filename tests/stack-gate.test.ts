import { describe, expect, test } from "bun:test";

import { allowlistFrom, type Problem } from "../.github/actions/_lib/gate.ts";
import { denies, denylistIn, stackGate } from "../.github/actions/stack-gate/stack-gate.ts";
import { materialise, trackThenDelete, type Tree } from "./tree.ts";
import { containing } from "./matchers.ts";

const DENYLIST = new URL("../.github/actions/stack-gate/stack-denylist.json", import.meta.url);

/** The real file, read the way the gate reads it — so the suite grades what ships, parsed. */
const DENYLIST_ENTRIES = denylistIn(await Bun.file(DENYLIST).json(), String(DENYLIST));

const CLEAN: Tree = {
  ".gitignore": "node_modules/\n",
  "package.json": JSON.stringify({
    name: "clean",
    dependencies: { "drizzle-orm": "0.44.7", sonner: "2.0.7", clsx: "2.1.1" },
    devDependencies: { "drizzle-kit": "0.31.6", "jest-expo": "54.0.0" },
  }),
};

async function gate(tree: Tree, allowlist = ""): Promise<string[]> {
  const root = await materialise(tree);
  const problems = await stackGate(root, DENYLIST, allowlistFrom(allowlist, "stack-allowlist"));
  return problems.map(({ file, message }) => `${file ?? ""}: ${message}`);
}

function withDependency(name: string, version = "1.0.0"): Tree {
  const contents = JSON.parse(CLEAN["package.json"] ?? "") as {
    dependencies: Record<string, string>;
  };
  contents.dependencies[name] = version;
  return { ...CLEAN, "package.json": JSON.stringify(contents) };
}

describe("stack gate", () => {
  test("a tree that only names house picks passes", async () => {
    expect(await gate(CLEAN)).toEqual([]);
  });

  test.each([
    ["prisma", "Drizzle"],
    ["ioredis", "Redis"],
    ["valibot", "zod"],
    ["@radix-ui/react-dialog", "Base UI"],
    ["react-hot-toast", "sonner"],
    ["classnames", "clsx"],
    ["@emotion/react", "Tailwind"],
    ["dayjs", "Temporal"],
    ["recharts", "dataviz"],
    ["next-auth", "Better Auth"],
    ["nodemailer", "Resend"],
    ["node-cron", "Effect Schedule"],
    ["vitest", "bun test"],
    ["nativewind", "StyleSheet"],
    ["@react-native-async-storage/async-storage", "expo-secure-store"],
  ])("%s is refused and the diagnostic names the pick", async (name, pick) => {
    const problems = await gate(withDependency(name));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`dependencies.${name}`);
    expect(problems[0]).toContain(pick);
  });

  // JSON.parse answers null as readily as an object, and the walk below goes
  // straight to a dependency field of one.
  test("a manifest that is JSON but not an object is named, not crashed on", async () => {
    expect(await gate({ ...CLEAN, "package.json": "null" })).toEqual([
      containing("package.json: is not a JSON object"),
    ]);
  });

  test("a name entry does not take its prefixed neighbours with it", async () => {
    // jest-expo is the Expo test preset and is the only way to run a
    // React Native suite; the bare `jest` entry must not reach it.
    expect(await gate(CLEAN)).toEqual([]);
    expect(await gate(withDependency("jest"))).toHaveLength(1);
  });

  test("a pattern entry takes the whole scope", async () => {
    expect(await gate(withDependency("@radix-ui/react-tooltip"))).toHaveLength(1);
    expect(await gate(withDependency("@nivo/bar"))).toHaveLength(1);
  });

  test("a workspace package is read too", async () => {
    const problems = await gate({
      ...CLEAN,
      "apps/api/package.json": JSON.stringify({ dependencies: { redis: "5.9.1" } }),
    });
    expect(problems).toEqual([containing("apps/api/package.json: dependencies.redis")]);
  });

  test("an ignored directory is not read", async () => {
    const problems = await gate({
      ...CLEAN,
      "node_modules/left-pad/package.json": JSON.stringify({ dependencies: { mobx: "6.15.0" } }),
    });
    expect(problems).toEqual([]);
  });

  test("node_modules is never read, however the repo's .gitignore is written", async () => {
    // `--others` lists whatever git would keep, so a repo whose .gitignore
    // forgets node_modules used to hand the gate every third-party manifest —
    // and denouncing a dependency's dependency is worse than not looking.
    const problems = await gate({
      ...CLEAN,
      ".gitignore": "dist\n",
      "node_modules/mobx/package.json": JSON.stringify({ dependencies: { mobx: "6.15.0" } }),
      "apps/web/node_modules/zustand/package.json": JSON.stringify({
        dependencies: { zustand: "5.0.8" },
      }),
    });
    expect(problems).toEqual([]);
  });

  test("a manifest deleted from the worktree is not read out of the index", async () => {
    // The scaffolder's last act is to delete itself and its staging tree, so a
    // scaffolded repo's index still lists package.json files that are gone.
    const root = await materialise({
      ...CLEAN,
      "setup/monorepo/apps/api/package.json": JSON.stringify({
        dependencies: { ioredis: "5.9.1" },
      }),
    });
    await trackThenDelete(root, "setup");
    expect(await stackGate(root, DENYLIST, allowlistFrom("", "stack-allowlist"))).toEqual([]);
  });

  test("a denied pick nobody allowlisted is refused, and the diagnostic names the hatch", async () => {
    const problems = await gate(withDependency("zustand", "5.0.8"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dependencies.zustand");
    expect(problems[0]).toContain("TanStack Query");
    expect(problems[0]).toContain("stack-allowlist");
  });

  test("an allowlisted package with a reason is kept", async () => {
    expect(
      await gate(
        withDependency("zustand", "5.0.8"),
        "zustand -- the editor's transient selection, agreed as the one client-state deviation",
      ),
    ).toEqual([]);
  });

  test("an allowlist entry with no reason is refused, and still waives its subject", async () => {
    // One diagnostic for one mistake: the missing reason. Reporting the package
    // as well would say the entry both did and did not waive anything.
    expect(await gate(withDependency("zustand", "5.0.8"), "zustand")).toEqual([
      containing("stack-allowlist waives zustand without saying why"),
    ]);
  });

  test("a waiver reaches only the package it names", async () => {
    const tree = {
      ...CLEAN,
      "package.json": JSON.stringify({
        name: "clean",
        dependencies: { prisma: "6.18.0", zustand: "5.0.8" },
      }),
    };
    expect(await gate(tree, "zustand -- the editor's transient selection")).toEqual([
      containing("dependencies.prisma"),
    ]);
  });

  test("a waiver for a dependency that is gone is refused", async () => {
    // The fossil: the deviation was dropped and the waiver outlived it, which
    // is the case a check against the denylist alone cannot see — zustand is
    // denied, so the entry looks live, and it stands for nobody.
    expect(await gate(CLEAN, "zustand -- the editor's transient selection")).toEqual([
      containing("stack-allowlist waives zustand, which nothing here declares"),
    ]);
  });

  test("a waiver spelled differently from the dependency is refused", async () => {
    // The typo, which reads the same way from here: `Zustand` matches nothing
    // this tree declares, and the package it was written for is still refused.
    const problems = await gate(withDependency("zustand", "5.0.8"), "Zustand -- transient state");
    expect(problems).toEqual([
      containing("dependencies.zustand is not the house pick"),
      containing("stack-allowlist waives Zustand, which nothing here declares"),
    ]);
  });

  test("a waiver the denylist has stopped answering for says so, not 'fix the name'", async () => {
    // The other fossil, and the one a retiring denylist entry produces across
    // every consumer at once: the package is right there in the manifest, so a
    // diagnostic sending its author name-hunting is a diagnostic that lies.
    expect(
      await gate(withDependency("react", "19.2.0"), "react -- kept from when it was denied"),
    ).toEqual([
      containing("stack-allowlist waives react, which the denylist no longer answers for"),
    ]);
  });

  test("one reasonless line does not silence what the other entries are told", async () => {
    // Whole-input incompleteness is the manifest's business. A reasonless entry
    // is one entry's fault, and suppressing every other entry's verdict over it
    // is how a second round-trip gets spent on a diagnostic that was ready.
    expect(await gate(CLEAN, "zustand\nrecoil -- gone with the editor rewrite")).toEqual([
      containing("stack-allowlist waives zustand without saying why"),
      containing("stack-allowlist waives recoil, which nothing here declares"),
    ]);
  });

  test("an entry that says nothing and matches nothing is one mistake, not two", async () => {
    // The reasonless refusal already sends its author back to the line, and a
    // fossil reported over an input the gate has refused to grade is noise on
    // the way to the same edit.
    expect(await gate(CLEAN, "zustand")).toEqual([
      containing("stack-allowlist waives zustand without saying why"),
    ]);
  });

  test("a manifest that will not parse is not buried under waivers it declared", async () => {
    // The list of denied declarations is short by whatever that file held, so
    // every waiver written for it would read as dead — findings that are
    // artefacts of the one problem that has to be fixed first.
    expect(
      await gate(
        { ...CLEAN, "apps/api/package.json": "{" },
        "zustand -- the editor's transient selection",
      ),
    ).toEqual([containing("apps/api/package.json: is not valid JSON")]);
  });

  test("a waiver covers the package wherever the tree declares it", async () => {
    // Repo-wide, because what was agreed is a fact about the repo rather than
    // about the workspace that happens to have taken the dependency.
    expect(
      await gate(
        { ...CLEAN, "apps/api/package.json": JSON.stringify({ dependencies: { redis: "5.9.1" } }) },
        "redis -- the one cache this API talks to is somebody else's, and it speaks RESP",
      ),
    ).toEqual([]);
  });

  test("a package installed under an npm: alias is refused under its own name", async () => {
    // The evasion a key-only reading let through: what is installed is prisma,
    // and nothing in the manifest says the word until the spec is read.
    const problems = await gate(withDependency("db", "npm:prisma@6.18.0"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dependencies.db");
    expect(problems[0]).toContain("an npm: alias for prisma");
    expect(problems[0]).toContain("Drizzle");
  });

  test("a waiver for an aliased package reaches it under either spelling", async () => {
    const aliased = withDependency("db", "npm:prisma@6.18.0");
    expect(await gate(aliased, "prisma -- the one legacy service still speaks it")).toEqual([]);
    expect(await gate(aliased, "db -- the one legacy service still speaks it")).toEqual([]);
  });

  test.each([
    ["db", "npm:prisma", "prisma"],
    ["ui", "npm:@radix-ui/react-dialog", "@radix-ui/react-dialog"],
  ])(
    "a versionless alias (%s) is refused under the package it installs",
    async (key, spec, installed) => {
      // `npm:prisma` names no version, which is a spec the pin gate refuses on
      // its own terms — but the package it installs is the denylist's business
      // whether or not the version is anyone's.
      const problems = await gate(withDependency(key, spec));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`an npm: alias for ${installed}`);
    },
  );

  test("a key that happens to name a denied package is not itself the package", async () => {
    // The repo installs exactly the house pick and calls it something
    // unfortunate. Refusing that is refusing a repo for its own vocabulary.
    expect(await gate(withDependency("prisma", "npm:drizzle-orm@0.44.7"))).toEqual([]);
  });

  test("an aliased refusal carries the installed package's reason, not the key's", async () => {
    const problems = await gate(withDependency("zustand", "npm:prisma@6.18.0"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Drizzle over Bun.sql is the data layer");
    expect(problems[0]).not.toContain("TanStack Query");
  });

  test("an alias to a package the denylist is silent about passes", async () => {
    expect(await gate(withDependency("orm", "npm:drizzle-orm@0.44.7"))).toEqual([]);
  });

  test("a refusal survives an input the gate cannot grade whole", async () => {
    // The fossil half goes quiet on an unreadable manifest; the refusals must
    // not go with it, or one bad package.json turns the gate off for the tree.
    expect(
      await gate({ ...withDependency("prisma", "6.18.0"), "apps/api/package.json": "{" }),
    ).toEqual([
      containing("apps/api/package.json: is not valid JSON"),
      containing("dependencies.prisma is not the house pick"),
    ]);
  });

  test("a waiver may name a package a pattern entry denies", async () => {
    expect(
      await gate(
        withDependency("@radix-ui/react-dialog", "1.1.16"),
        "@radix-ui/react-dialog -- the one primitive Base UI has no answer for yet",
      ),
    ).toEqual([]);
  });
});

/**
 * The gate credits a package to the first entry that denies it, which is only
 * honest while no package has two. That is a property of the shipped denylist
 * rather than of the code, so it is asserted against the file itself.
 *
 * The names are enumerable; a `patterns` entry is not, so each one is sampled
 * by a name its own expression is built to catch. Deriving the sample from the
 * file rather than listing scopes here is what keeps a pattern added tomorrow
 * inside the property — and each sample is checked against the pattern that
 * produced it, so a pattern shape this derivation cannot sample fails loudly
 * instead of quietly testing nothing.
 */
describe("the shipped denylist", () => {
  const NAMES = [...new Set(DENYLIST_ENTRIES.flatMap((entry) => entry.names))];
  const PATTERNS = [...new Set(DENYLIST_ENTRIES.flatMap((entry) => entry.patterns))];
  /**
   * Each pattern with a package it is meant to reach: its literal prefix — the
   * anchor dropped and the escapes taken out, since `source` re-escapes the
   * slash a scope is written with — and something to be the rest.
   */
  const SAMPLED = PATTERNS.map((pattern) => {
    const prefix = pattern.source.replace(/^\^/, "").replaceAll(/\\(.)/g, "$1");
    return [pattern, `${prefix}a-package-of-theirs`] as const;
  });

  test("is the file the gate ships, read whole", () => {
    // Guards the three ways this suite could assert nothing: a denylist that
    // did not load, and either field this reader stopped finding.
    expect(NAMES.length).toBeGreaterThan(50);
    expect(PATTERNS.length).toBeGreaterThan(4);
  });

  test.each(SAMPLED)("%s is sampled by a name it catches", (pattern, sample) => {
    expect(pattern.test(sample)).toBe(true);
  });

  test.each([...NAMES, ...SAMPLED.map(([, sample]) => sample)])(
    "no package is denied twice (%s)",
    (name) => {
      const answering = DENYLIST_ENTRIES.filter((entry) => denies(entry, name));
      expect(answering.map(({ reason }) => reason)).toHaveLength(1);
    },
  );
});

describe("a denylist that is not one", () => {
  const ENTRY = { names: ["dayjs"], reason: "Temporal on the server" };

  async function against(denylist: unknown): Promise<Problem[]> {
    const root = await materialise({ ...CLEAN, "denylist.json": JSON.stringify(denylist) });
    return await stackGate(root, `${root}/denylist.json`, allowlistFrom("", "stack-allowlist"));
  }

  /** What the gate refused a denylist with, so a case can assert on the whole sentence. */
  async function refusalOf(denylist: unknown): Promise<string> {
    try {
      await against(denylist);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "the gate read it without complaint";
  }

  test("a well-formed one is read", async () => {
    expect(await against({ entries: [ENTRY] })).toEqual([]);
  });

  test("an entry whose reason key is misspelt is refused, not read as no answer", async () => {
    // The whole point of the check: `reason` is what says a package is denied
    // at all, so a typo used to disarm the rule and report nothing.
    expect(await refusalOf({ entries: [{ names: ["dayjs"], reasonn: "Temporal" }] })).toContain(
      "entry 0 (dayjs) carries reasonn, which no rule here reads",
    );
  });

  test("a disarmed entry cannot shadow the one that would have caught the package", async () => {
    // find-first is honest only over entries that all deny something. Before
    // the shape check, a malformed entry matched, answered nothing, and took
    // the well-formed entry behind it down with it.
    expect(await refusalOf({ entries: [{ names: ["dayjs"] }, ENTRY] })).toContain(
      "entry 0 (dayjs) has no reason",
    );
  });

  test("an entry that denies nothing is refused", async () => {
    expect(await refusalOf({ entries: [{ reason: "a rule about nothing" }] })).toContain(
      'entry 0 ({"reason":"a rule about nothing"}) denies nothing',
    );
  });

  test("a reason that is blank is no reason", async () => {
    expect(await refusalOf({ entries: [{ names: ["dayjs"], reason: "  " }] })).toContain(
      "entry 0 (dayjs) has no reason",
    );
  });

  test("names that are not a list of names are refused", async () => {
    expect(await refusalOf({ entries: [{ names: "dayjs", reason: "Temporal" }] })).toContain(
      "declares names or patterns as something other than a list of non-empty strings",
    );
  });

  test("every fault in the file is named, not just the first", async () => {
    const refusal = await refusalOf({
      entries: [{ names: ["dayjs"] }, { reason: "about nothing" }],
    });
    expect(refusal).toContain("entry 0 (dayjs) has no reason");
    expect(refusal).toContain("denies nothing");
  });

  test("a pattern that will not compile is refused here, not thrown from the walk", async () => {
    // Left to the walk it is a SyntaxError from inside a loop over somebody's
    // dependencies: attributed to no entry, and reached only on the repos that
    // declare enough to get there.
    expect(
      await refusalOf({ entries: [{ patterns: ["^@scope/("], reason: "a scope" }] }),
    ).toContain("entry 0 (^@scope/() declares ^@scope/(, which is not an expression");
  });

  test("an entry that is not an object is labelled by what it actually is", async () => {
    // The label has no names to read, and the value it prints has to be the one
    // in the file rather than the empty object the reader stood in for it.
    expect(await refusalOf({ entries: ["prisma"] })).toContain(
      'entry 0 ("prisma") is a string, not an object',
    );
  });

  test("a file that is not a denylist at all says what it is instead", async () => {
    expect(await refusalOf([ENTRY])).toContain("is not a denylist: the top level is an array");
    expect(await refusalOf({ entries: {} })).toContain("declares entries as an object");
  });
});
