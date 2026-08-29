import { describe, expect, test } from "bun:test";

import { baseConfig, type Case, cases, lines, underBase } from "./lint-fixture.ts";

/**
 * The four rules the base enables only over test files, because every one of
 * them is ordinary code anywhere else: a source file counts calls, sleeps,
 * reads a `.mock` property off something of its own and passes a function to
 * `expect` in a helper, and none of that is a smell until it is a test's whole
 * evidence.
 *
 * Every one of them recognises its subject through the import rather than
 * through the name written at the call site, so most of what is below is the
 * spellings that would otherwise turn a rule off: an `as` on an import, a
 * namespace, an optional link, a global reached the long way round.
 */
const SENT = `import { expect, mock, test } from "bun:test";
const send = mock(() => 1);
`;

const IN_TESTS = {
  "no-call-log-assertions": [
    {
      name: "the count matcher is refused",
      source: `${SENT}test("sends", () => {
  expect(send).toHaveBeenCalledTimes(1);
});`,
      reports: ["4:16"],
    },
    {
      name: "the order matchers go with it — a rule that knew only the count would leave them",
      source: `${SENT}test("sends", () => {
  expect(send).toHaveBeenNthCalledWith(1, "a");
  expect(send).toHaveBeenLastCalledWith("a");
  expect(send).toHaveBeenCalledOnce();
});`,
      reports: ["4:16", "5:16", "6:16"],
    },
    {
      name: "a negated one is the same assertion a member further out from expect()",
      source: `${SENT}test("sends", () => {
  expect(send).not.toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenNthCalledWith(1, "a");
});`,
      reports: ["4:20", "5:20"],
    },
    {
      name: "written in brackets it is the same name — a rule reading only `a.b` is one keystroke from off",
      source: `${SENT}test("sends", () => {
  expect(send)["toHaveBeenNthCalledWith"](1, "a");
});`,
      reports: ["4:16"],
    },
    {
      name: "an object of the test's own with a method of that name is not an assertion",
      source: `import { expect, test } from "bun:test";
const audit = { toHaveBeenCalledTimes: (n: number) => n };
test("counts", () => {
  expect(audit.toHaveBeenCalledTimes(1)).toBe(1);
});`,
      reports: [],
    },
    {
      name: "a matcher computed from a value has no name to read, and is not guessed at",
      source: `${SENT}const matcher = "toHaveBeenCalledTimes";
test("sends", () => {
  expect(send)[matcher](1);
});`,
      reports: [],
    },
    {
      name: "was it called, and with what, is the call log — and the only reach onto a stand-in from another file",
      source: `import { expect, test } from "bun:test";
import { send } from "./helpers.test-utils.ts";
test("sends", () => {
  expect(send).toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith("a");
});`,
      reports: ["4:16", "5:16"],
    },
    {
      name: "the matchers that grade the result are the ones a test is for",
      source: `${SENT}test("sends", () => {
  expect(send()).toBe(1);
  expect([send()]).toHaveLength(1);
});`,
      reports: [],
    },
  ],
  "no-mock-assertions": [
    {
      name: "a stand-in handed to expect is refused",
      source: `${SENT}test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: ["4:10"],
    },
    {
      name: "what calling it produced is not the stand-in — the rule reads the argument, not the name in it",
      source: `${SENT}test("sends", () => {
  expect(send()).toBe(1);
});`,
      reports: [],
    },
    {
      name: "an `as` on the import renames nothing the rule goes by",
      source: `import { expect, mock as m, test } from "bun:test";
const send = m(() => 1);
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: ["4:10"],
    },
    {
      name: "and neither does reaching the runner through a namespace",
      source: `import * as bt from "bun:test";
const send = bt.mock(() => 1);
bt.test("sends", () => {
  bt.expect(send).toBeDefined();
});`,
      reports: ["4:13"],
    },
    {
      name: "the other two runners spell it their own way",
      source: `import { expect, test } from "bun:test";
import { jest } from "@jest/globals";
import { vi } from "vitest";
const first = jest.fn();
const second = vi.fn();
test("sends", () => {
  expect(first).toBeDefined();
  expect(second).toBeDefined();
});`,
      reports: ["7:10", "8:10"],
    },
    {
      name: "vitest's softer openings assert exactly as much",
      source: `${SENT}test("sends", () => {
  expect.soft(send).toBeDefined();
  expect.poll(send).toBeDefined();
});`,
      reports: ["4:15", "5:15"],
    },
    {
      name: "a spy built inside the call is the same object",
      source: `import { expect, spyOn, test } from "bun:test";
test("sends", () => {
  expect(spyOn(console, "log")).toBeDefined();
});`,
      reports: ["3:10"],
    },
    {
      name: "a name the test writes to later is not the call at its declaration",
      source: `import { expect, mock, test } from "bun:test";
let send = mock(() => 1);
send = () => 2;
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "a plain function is not a stand-in",
      source: `import { expect, test } from "bun:test";
const send = () => 1;
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "the binding resolved is the one in scope, not the one with the name",
      source: `${SENT}test("sends", () => {
  const send = () => 1;
  expect(send).toBeDefined();
});
test("sends again", () => {
  expect(send).toBeDefined();
});`,
      reports: ["8:10"],
    },
    {
      name: "the call log read by hand, in every spelling a rule keyed to one chain would miss",
      source: `${SENT}test("sends", () => {
  expect(send.mock.calls.length).toBe(1);
  expect(send.mock.calls[0]).toEqual(["a"]);
  expect(send.mock.calls.at(0)).toEqual(["a"]);
  expect(send.mock.lastCall).toEqual(["a"]);
});`,
      reports: ["4:10", "5:10", "6:10", "7:10"],
    },
    {
      name: "one optional link does not hide the chain behind it",
      source: `${SENT}test("sends", () => {
  expect(send?.mock.calls.length).toBe(1);
  expect(send.mock?.calls).toBeDefined();
});`,
      reports: ["4:10", "5:10"],
    },
    {
      name: "a stand-in kept in a container is one written out, and the slot is readable",
      source: `import { expect, mock, test } from "bun:test";
const spies = { send: mock(() => 1) };
const queued = [mock(() => 2)];
test("sends", () => {
  expect(spies.send).toBeDefined();
  expect(queued[0]).toBeDefined();
  expect(spies.send.mock.calls.length).toBe(1);
});`,
      reports: ["5:10", "6:10", "7:10"],
    },
    {
      name: "a default import is the namespace too — Bun's interop makes them one object",
      source: `import bt from "bun:test";
const send = bt.mock(() => 1);
bt.test("sends", () => {
  bt.expect(send).toBeDefined();
});`,
      reports: ["4:13"],
    },
    {
      name: "a container whose slot the source cannot settle is left alone, however it was unsettled",
      source: `import { expect, mock, test } from "bun:test";
const real = (): number => 3;
const others = [1, 2];
const shifted = [...others, mock(() => 1)];
const overridden = { send: mock(() => 1), send: real };
const written: { send: () => number } = { send: mock(() => 1) };
written.send = real;
test("none of the three holds a stand-in by the time it is read", () => {
  expect(shifted[1]).toBe(2);
  expect(overridden.send).toBe(real);
  expect(written.send).toBe(real);
});`,
      reports: [],
    },
    {
      name: "a runner reached through this repo's own re-export is past what one file can see",
      source: `import { expect, mock, test } from "./barrel.ts";
const send = mock(() => 1);
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "and so is one imported at run time",
      source: `import { expect, test } from "bun:test";
const { mock } = await import("bun:test");
const send = mock(() => 1);
test("sends", () => {
  expect(send).toBeDefined();
});`,
      reports: [],
    },
    {
      name: "an object of the test's own that happens to have a mock property is not a stand-in",
      source: `${SENT}test("sends", () => {
  const recorded = { mock: { calls: [["a"]] } };
  expect(recorded.mock.calls.length).toBe(1);
  expect(recorded.mock.calls.at(0)).toEqual(["a"]);
});`,
      reports: [],
    },
    {
      name: "a container the source cannot read into is left alone rather than guessed at",
      source: `import { expect, mock, test } from "bun:test";
const spies = new Map([["send", mock(() => 1)]]);
function make(): () => number {
  return mock(() => 2);
}
const built = make();
test("sends", () => {
  expect(spies.get("send")).toBeDefined();
  expect(built).toBeDefined();
});`,
      reports: [],
    },
  ],
  "no-local-module-mocks": [
    {
      name: "a module of ours replaced wholesale is refused",
      source: `import { mock } from "bun:test";
mock.module("./service.ts", () => ({ run: () => 1 }));`,
      reports: ["2:1"],
    },
    {
      name: "a parent-relative specifier is ours as much as a sibling",
      source: `import { mock } from "bun:test";
mock.module("../db/client.ts", () => ({ query: () => [] }));`,
      reports: ["2:1"],
    },
    {
      name: "a package is the true external boundary a fake belongs at",
      source: `import { mock } from "bun:test";
mock.module("node:fs/promises", () => ({ readFile: () => "" }));
mock.module("stripe", () => ({ charge: () => 1 }));`,
      reports: [],
    },
    {
      name: "an alias and a namespace are the same two calls under other names",
      source: `import { mock as m, spyOn as sp } from "bun:test";
import * as service from "./service.ts";
m.module("./service.ts", () => ({ run: () => 2 }));
sp(service, "run");`,
      reports: ["3:1", "4:1"],
    },
    {
      name: "and so is reaching the runner through one",
      source: `import * as bt from "bun:test";
import * as service from "./service.ts";
bt.mock.module("./service.ts", () => ({ run: () => 2 }));
bt.spyOn(service, "run");`,
      reports: ["3:1", "4:1"],
    },
    {
      name: "the other runners' module mocks are the same act",
      source: `import { vi } from "vitest";
import { jest } from "@jest/globals";
vi.mock("./service.ts", () => ({ run: () => 2 }));
jest.mock("./service.ts");`,
      reports: ["3:1", "4:1"],
    },
    {
      // The hoisted call is not the only spelling either runner has, and a set
      // holding one of three is a set the next line gets past: the deferred and
      // ESM-aware forms exist because the hoisted one cannot see a runtime
      // value or an ES module, not because they replace anything less.
      name: "including the deferred and ESM-aware spellings of it",
      source: `import { vi } from "vitest";
import { jest } from "@jest/globals";
vi.doMock("./service.ts", () => ({ run: () => 2 }));
jest.doMock("./service.ts");
jest.unstable_mockModule("./service.ts", () => ({ run: () => 2 }));`,
      reports: ["3:1", "4:1", "5:1"],
    },
    {
      name: "a template with nothing to substitute is the string it looks like",
      source: `import { mock } from "bun:test";
mock.module(\`./service.ts\`, () => ({ run: () => 2 }));`,
      reports: ["2:1"],
    },
    {
      name: "and a name given that string once still says which module",
      source: `import { mock } from "bun:test";
const target = "./service.ts";
mock.module(target, () => ({ run: () => 2 }));`,
      reports: ["3:1"],
    },
    {
      name: "a specifier the source cannot read is refused, never waved through",
      source: `import { mock } from "bun:test";
mock.module(import.meta.resolve("./service.ts"), () => ({ run: () => 2 }));`,
      reports: ["2:13"],
    },
    {
      name: "a spy over a module of ours is the same move under another name",
      source: `import { spyOn } from "bun:test";
import * as service from "./service.ts";
spyOn(service, "run");`,
      reports: ["3:1"],
    },
    {
      name: "a name given to that import once is still that import",
      source: `import { spyOn } from "bun:test";
import * as service from "./service.ts";
const target = service;
spyOn(target, "run");`,
      reports: ["4:1"],
    },
    {
      name: "a spy over a package's namespace stays at the boundary",
      source: `import { spyOn } from "bun:test";
import * as fs from "node:fs";
spyOn(fs, "readFileSync");`,
      reports: [],
    },
    {
      name: "a spy over a global is not a module at all",
      source: `import { spyOn } from "bun:test";
spyOn(console, "log");`,
      reports: [],
    },
  ],
  "no-real-timers": [
    {
      name: "the timer globals are refused",
      source: `import { test } from "bun:test";
test("waits", () => {
  setTimeout(() => undefined, 10);
  setInterval(() => undefined, 10);
  setImmediate(() => undefined);
});`,
      reports: ["3:3", "4:3", "5:3"],
    },
    {
      name: "the sleeping promise is the timer written longhand",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});`,
      reports: ["3:34"],
    },
    {
      name: "Bun's sleeps are members of a global rather than globals",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await Bun.sleep(5);
  Bun.sleepSync(5);
});`,
      reports: ["3:9", "4:3"],
    },
    {
      name: "the long way round is the same function — a rule reading unresolved names alone misses it",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
  await globalThis.Bun.sleep(5);
});`,
      reports: ["3:34", "4:9"],
    },
    {
      name: "and `self` and `window` are the same object under other names",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await new Promise((resolve) => self.setTimeout(resolve, 5));
  await new Promise((resolve) => window.setTimeout(resolve, 5));
});`,
      reports: ["3:34", "4:34"],
    },
    {
      name: "an assertion or an optional link around it changes which value, not that it sleeps",
      source: `import { test } from "bun:test";
test("waits", async () => {
  await (Bun as typeof Bun).sleep(5);
  await Bun?.sleep(5);
});`,
      reports: ["3:9", "4:9"],
    },
    {
      name: "importing the same function is not a way round it",
      source: `import { setTimeout as delay } from "node:timers/promises";
import { setInterval } from "node:timers";
import { test } from "bun:test";
test("waits", async () => {
  await delay(5);
  setInterval(() => undefined, 5);
});`,
      reports: ["1:24", "2:10"],
    },
    {
      name: "a property that shares the name is not the global",
      source: `import { expect, test } from "bun:test";
const clock = { setTimeout: (at: number) => at };
test("waits", () => {
  expect(clock.setTimeout(5)).toBe(5);
});`,
      reports: [],
    },
    {
      name: "a name the file declares itself is a different function",
      source: `import { test } from "bun:test";
function setTimeout(run: () => void): void {
  run();
}
test("waits", () => {
  setTimeout(() => undefined);
});`,
      reports: [],
    },
    {
      name: "Bun's other members spend no time",
      source: `import { expect, test } from "bun:test";
test("reads", async () => {
  expect(await Bun.file("package.json").text()).toContain("name");
});`,
      reports: [],
    },
  ],
} satisfies Record<string, readonly Case[]>;

/** Every suffix the base grades as a test file — a rule enabled for one and not the rest is a hole. */
const IN_TEST_FILES = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"];

/** And the ones it does not, which is the half that keeps the four out of source files. */
const NOT_TEST_FILES = [".ts", ".tsx"];

describe("the test-smell rules", () => {
  for (const [rule, list] of Object.entries(IN_TESTS)) cases(rule, list);

  // Per suffix rather than over all four at once: the base names them one by
  // one, so a rule reaching `.test.ts` and not `.spec.tsx` is a hole a single
  // pooled assertion would report as covered.
  test.each(IN_TEST_FILES)("the base enables all four in a %s", async (suffix) => {
    const wired = (await lines(underBase(suffix, IN_TESTS))).join("\n");
    for (const rule of Object.keys(IN_TESTS)) {
      expect(wired).toContain(`anti-slop(${rule})`);
    }
  });

  // The other half of scoping one to a test file: counting calls, sleeping and
  // reaching into a module are what a source file does all day, and a rule that
  // fired on them everywhere would be one every repo turned off.
  test.each(NOT_TEST_FILES)("and says nothing about the same source in a %s", async (suffix) => {
    const wired = (await lines(underBase(suffix, IN_TESTS))).join("\n");
    for (const rule of Object.keys(IN_TESTS)) {
      expect(wired).not.toContain(`anti-slop(${rule})`);
    }
  });

  // A repo that declares the runner's globals in its own config, which is what
  // `env` and `globals` are for, was turning these rules off by doing it: the
  // name resolved to a variable the environment declared, and a rule reading
  // "did this resolve" as "does the file own it" saw somebody else's `jest`.
  test("a runner's globals declared in the config are still the runner's", async () => {
    const declared = baseConfig({ globals: { jest: "readonly", vi: "readonly" } });
    const wired = (
      await lines({
        ".oxlintrc.json": declared,
        "case.test.ts": `jest.mock("./service.ts");
vi.mock("./service.ts", () => ({ run: () => 1 }));
`,
      })
    ).join("\n");

    expect(wired).toContain("anti-slop(no-local-module-mocks)");
    expect(wired.match(/no-local-module-mocks/gu)).toHaveLength(2);
  });

  // One line is two smells here — a stand-in handed to `expect`, and its call
  // log asserted on — and a directive names rules one at a time. Someone
  // reaching for the escape writes the rule the diagnostic named and ships a
  // line still failing on the other, so the shape of the escape from both is
  // part of what this pack has to show rather than leave to be found.
  describe("the escape from a line that trips two of them", () => {
    const config = baseConfig();
    const both = `import { expect, mock, test } from "bun:test";
const send = mock(() => 1);
test("sends", () => {
  // DIRECTIVE
  expect(send).toHaveBeenCalledTimes(1);
});
`;

    /** The same line under a directive naming the rules given. */
    async function under(...rules: readonly string[]): Promise<string[]> {
      const named = rules.map((rule) => `anti-slop/${rule}`).join(", ");
      return await lines({
        ".oxlintrc.json": config,
        "case.test.ts": both.replace(
          "// DIRECTIVE",
          `// oxlint-disable-next-line ${named} -- the retry policy is the behaviour, and the count is the whole of it`,
        ),
      });
    }

    test("one name leaves the other rule reporting", async () => {
      expect((await under("no-call-log-assertions")).join("\n")).toContain(
        "anti-slop(no-mock-assertions)",
      );
    });

    test("both names in one directive is what silences the line", async () => {
      expect(await under("no-call-log-assertions", "no-mock-assertions")).toEqual([]);
    });
  });
});
