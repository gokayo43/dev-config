import type { Case } from "./lint-fixture.ts";

/**
 * The cases of `no-unfailable-assertions`, a module of their own because the
 * table outgrew the suite that runs it beside the other test-smell rules,
 * whose wiring checks it shares.
 */
export const UNFAILABLE_ASSERTIONS: readonly Case[] = [
  {
    name: "an assertion inside an if runs only when the condition holds",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  }
});`,
    reports: ["5:5"],
  },
  {
    name: "the else arm alone is the same skip from the other side",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    console.log(value);
  } else {
    expect(value).toBeLessThanOrEqual(0.5);
  }
});`,
    reports: ["7:5"],
  },
  {
    name: "a ternary arm, and the right side of each of the three logical operators",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  const found: number | undefined = value > 0.5 ? value : undefined;
  value > 0.5 ? expect(value).toBe(1) : undefined;
  found && expect(found).toBe(1);
  found || expect(found).toBeUndefined();
  found ?? expect(found).toBeUndefined();
});`,
    reports: ["5:17", "6:12", "7:12", "8:12"],
  },
  {
    name: "a switch case runs only on its own value",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const kind = String(Math.random());
  switch (kind) {
    case "a":
      expect(kind).toBe("a");
      break;
    default:
      break;
  }
});`,
    reports: ["6:7"],
  },
  {
    name: "both arms asserting is an assertion on every path, in an if and in a ternary",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else {
    expect(value).toBeLessThanOrEqual(0.5);
  }
  value > 0.5 ? expect(value).toBeGreaterThan(0.5) : expect(value).toBeLessThanOrEqual(0.5);
});`,
    reports: [],
  },
  {
    name: "an else-if chain asserts on every path only when it ends in an else that does",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.6) {
    expect(value).toBeGreaterThan(0.6);
  } else if (value > 0.3) {
    expect(value).toBeGreaterThan(0.3);
  }
  if (value > 0.6) {
    expect(value).toBeGreaterThan(0.6);
  } else if (value > 0.3) {
    expect(value).toBeGreaterThan(0.3);
  } else {
    expect(value).toBeLessThanOrEqual(0.3);
  }
});`,
    reports: ["5:5", "7:5"],
  },
  {
    name: "an arm whose only assertion is itself conditional does not assert on every path",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else {
    value > 0.1 && expect(value).toBeGreaterThan(0.1);
  }
});`,
    reports: ["5:5", "7:20"],
  },
  {
    name: "an arm that leaves has the statements after the branch as its other path",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  for (const value of [0.2, 0.8]) {
    if (value > 0.5) {
      expect(value).toBeGreaterThan(0.5);
      continue;
    }
    expect(value).toBeLessThanOrEqual(0.5);
  }
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
    return;
  }
  console.log(value);
});`,
    reports: ["12:5"],
  },
  {
    name: "an other arm that throws is no path a passing run takes",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else {
    throw new Error("the value never reached the half");
  }
});`,
    reports: [],
  },
  {
    name: "an arm that asserts and leaves beside an else that does not takes what follows as the else's path",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
    return;
  } else {
    console.log(value);
  }
  expect(value).toBeLessThan(1);
});`,
    reports: [],
  },
  {
    name: "an else that leaves too ends the other path before what follows",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
    return;
  } else {
    return;
  }
  expect(value).toBeLessThan(1);
});`,
    reports: ["5:5", "10:3"],
  },
  {
    name: "an other arm with a path that returns early is no path to what follows",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const first = Math.random() > 0.5;
  const second = Math.random() > 0.5;
  if (first) {
    expect(first).toBe(true);
    return;
  } else {
    if (second) return;
  }
  expect(second).toBe(false);
});`,
    reports: ["6:5", "11:3"],
  },
  {
    name: "an other arm counts as throwing only when every path through it throws",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  const quit = value > 0.9;
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else {
    if (quit) return;
    throw new Error("the value never reached the half");
  }
});`,
    reports: ["6:5"],
  },
  {
    name: "an else-if chain whose every other arm throws is no path a passing run takes",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else if (value > 0.2) {
    throw new Error("between");
  } else {
    throw new Error("below");
  }
});`,
    reports: [],
  },
  {
    name: "a return with a value answers a caller, and is no guard",
    source: `import { expect, test } from "bun:test";
import { retry } from "./retry.ts";
test("reads", async () => {
  await retry(() => {
    const value = Math.random();
    if (value < 0.5) return false;
    expect(value).toBeGreaterThan(0.4);
    return true;
  });
});`,
    reports: [],
  },
  {
    name: "a return in an array method's callback ends one element's turn, and is no guard",
    source: `import { expect, test } from "bun:test";
test("walks", () => {
  [1, 2, 3].forEach((row) => {
    if (row > 1) return;
    expect(row).toBe(1);
  });
});`,
    reports: [],
  },
  {
    name: "a guard whose condition an earlier assertion pins cannot be taken by a passing run",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const found = Math.random() > 0.5 ? { size: 1 } : undefined;
  expect(found).toBeDefined();
  if (found === undefined) return;
  expect(found.size).toBe(1);
});`,
    reports: [],
  },
  {
    name: "a guard is pinned by an earlier assertion on its root name, never on a property name",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const response = { status: 200 };
  const body = { status: Math.random() > 0.5 ? "ok" : "late", items: [1] };
  expect(response.status).toBe(200);
  if (body.status !== "ok") return;
  expect(body.items).toHaveLength(1);
});`,
    reports: ["7:3"],
  },
  {
    name: "a property the condition reads is no name an earlier assertion can pin",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const status = 200;
  const body = { status: Math.random() > 0.5 ? "ok" : "late", items: [1] };
  expect(status).toBe(200);
  if (body.status !== "ok") return;
  expect(body.items).toHaveLength(1);
});`,
    reports: ["7:3"],
  },
  {
    name: "a length read off one name pins no guard on another",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const rows = [1, 2];
  const other: number[] = Math.random() > 0.5 ? [1] : [];
  expect(rows.length).toBe(2);
  if (other.length === 0) return;
  expect(other[0]).toBe(1);
});`,
    reports: ["7:3"],
  },
  {
    name: "a return inside a loop in the other arm is a path that leaves before what follows",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const first = Math.random() > 0.5;
  const flags = [first, !first];
  if (first) {
    expect(first).toBe(true);
    return;
  } else {
    for (const flag of flags) {
      if (flag) return;
    }
  }
  expect(flags).toHaveLength(2);
});`,
    reports: ["6:5", "13:3"],
  },
  {
    name: "an other arm whose switch decides how it ends is one the rule cannot read, and says nothing about",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  } else {
    switch (value) {
      default:
        throw new Error("the value never reached the half");
    }
  }
});`,
    reports: [],
  },
  {
    name: "an arm that leaves through a try is one the rule cannot read, and says nothing about",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
    try {
      return;
    } finally {
      console.log(value);
    }
  }
  expect(value).toBeLessThanOrEqual(0.5);
});`,
    reports: [],
  },
  {
    name: "a guard that returns puts every assertion after it behind a branch",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const found = Math.random() > 0.5 ? 1 : undefined;
  if (found === undefined) return;
  expect(found).toBe(1);
});`,
    reports: ["5:3"],
  },
  {
    name: "a guard that throws, or asserts before it returns, lets no passing run go without what follows",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const found = Math.random() > 0.5 ? 1 : undefined;
  if (found === undefined) throw new Error("nothing found");
  expect(found).toBe(1);
  if (found > 1) {
    expect(found).toBeGreaterThan(1);
    return;
  }
  expect(found).toBe(1);
});`,
    reports: [],
  },
  {
    name: "an arm that falls through has no other path, whatever follows the branch",
    source: `import { expect, test } from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) {
    expect(value).toBeGreaterThan(0.5);
  }
  expect(value).toBeLessThan(1);
});`,
    reports: ["5:5"],
  },
  {
    name: "an assertion in a catch runs only when something throws",
    source: `import { expect, test } from "bun:test";
function run(): void {
  throw new RangeError("out");
}
test("throws", () => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
  }
});`,
    reports: ["9:5"],
  },
  {
    name: "a promise's rejection handler is a catch, whether .catch or .then's second argument",
    source: `import { expect, test } from "bun:test";
test("rejects", async () => {
  const pending = Promise.reject(new RangeError("out"));
  await pending.catch((error: unknown) => expect(error).toBeInstanceOf(RangeError));
  await pending.then(undefined, (error: unknown) => expect(error).toBeInstanceOf(RangeError));
});`,
    reports: ["4:43", "5:53"],
  },
  {
    name: "an assertion in an event callback runs when nothing waits for it",
    source: `import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
test("emits", () => {
  const emitter = new EventEmitter();
  const target = new EventTarget();
  const stream = { subscribe: (next: (value: number) => void) => next(1) };
  emitter.on("done", (value: number) => expect(value).toBe(1));
  emitter.once("done", (value: number) => expect(value).toBe(1));
  target.addEventListener("done", () => expect(target).toBeDefined());
  stream.subscribe((value) => expect(value).toBe(1));
  emitter.emit("done", 1);
});`,
    reports: ["7:41", "8:43", "9:41", "10:31"],
  },
  {
    name: "a throw matcher with nothing to compare passes on any error, on expect or after rejects",
    source: `import { expect, test } from "bun:test";
function run(): void {
  throw new RangeError("out");
}
test("throws", async () => {
  expect(run).toThrow();
  expect(run).toThrowError();
  await expect(Promise.reject(new RangeError("out"))).rejects.toThrow();
});`,
    reports: ["6:15", "7:15", "8:63"],
  },
  {
    name: "a throw matcher given what to expect, and the negated one, discriminate",
    source: `import { expect, test } from "bun:test";
function run(): void {
  throw new RangeError("out");
}
test("throws", async () => {
  expect(run).toThrow(RangeError);
  expect(run).toThrow("out");
  expect(run).toThrowError(/out/u);
  expect(() => undefined).not.toThrow();
  await expect(Promise.reject(new RangeError("out"))).rejects.toThrow(RangeError);
});`,
    reports: [],
  },
  {
    name: "a loop and an array method's callback walk a table, and are not branches",
    source: `import { expect, test } from "bun:test";
test("walks", () => {
  const rows = [1, 2, 3];
  for (const row of rows) {
    expect(row).toBeGreaterThan(0);
  }
  let index = 0;
  while (index < rows.length) {
    expect(rows[index]).toBeGreaterThan(0);
    index += 1;
  }
  rows.forEach((row) => expect(row).toBeGreaterThan(0));
});`,
    reports: [],
  },
  {
    name: "then, finally, the runner, a retry helper and a property each run what they are given",
    source: `import { expect, test } from "bun:test";
import fc from "fast-check";
import { check } from "@gokayo43/dev-config/property";
import { retry } from "./retry.ts";
test.each([1, 2])("reads %d", async (row) => {
  await Promise.resolve(row).then((value) => expect(value).toBe(row));
  await Promise.resolve(row).finally(() => expect(row).toBeGreaterThan(0));
  await retry(() => expect(row).toBeGreaterThan(0));
  check(fc.property(fc.integer(), (value) => expect(value).toBe(value)));
});`,
    reports: [],
  },
  {
    name: "a callback that runs is as skippable as the call it is handed to",
    source: `import { expect, test } from "bun:test";
test("reads", async () => {
  const value = Math.random();
  if (value > 0.5) {
    await Promise.resolve(value).then((seen) => expect(seen).toBe(value));
  }
});`,
    reports: ["5:49"],
  },
  {
    name: "a helper's own branch is a branch, and a helper with none is not",
    source: `import { expect } from "bun:test";
export function positive(value: number): void {
  expect(value).toBeGreaterThan(0);
}
export function positiveWhenSet(value: number | undefined): void {
  if (value !== undefined) expect(value).toBeGreaterThan(0);
}`,
    reports: ["6:28"],
  },
  {
    name: "a test registered on some runs is a skipped test, not a skipped assertion",
    source: `import { expect, test } from "bun:test";
if (process.platform === "linux") {
  test("reads", () => {
    expect(process.platform).toBe("linux");
  });
}`,
    reports: [],
  },
  {
    name: "expect is the runner's under an alias, a namespace and as a runner global",
    source: `import { expect as check, test } from "bun:test";
import * as bt from "bun:test";
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) check(value).toBeGreaterThan(0.5);
  if (value > 0.5) bt.expect(value).toBeGreaterThan(0.5);
  if (value > 0.5) expect(value).toBeGreaterThan(0.5);
});`,
    reports: ["5:20", "6:20", "7:20"],
  },
  {
    name: "a function of the file's own called expect, and one imported from elsewhere, are not the runner's",
    source: `import { test } from "bun:test";
import { expect as assertThat } from "./assert.ts";
function expect(value: number): { toBe: (other: number) => void } {
  return { toBe: (other) => console.log(value === other) };
}
test("reads", () => {
  const value = Math.random();
  if (value > 0.5) expect(value).toBe(1);
  if (value > 0.5) assertThat(value).toBe(1);
  expect(value).toBe(1);
});`,
    reports: [],
  },
];
