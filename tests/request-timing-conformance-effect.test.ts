/**
 * The conformance kit's Effect check (invariants 3 and 9), and dev-config
 * shipping no Effect at runtime but in the interleaving export, which declares
 * the optional peer (invariant 10). The check must pass on this
 * repo's Effect, and fail, saying why, on an Effect that resumes a woken fiber
 * on the waker's stack, which is what Effect does when its one lookup of
 * `node:async_hooks` finds nothing. Effect makes that lookup when its module
 * loads, so the failing run is a process of its own that hides the lookup
 * before it imports Effect.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as effect from "effect";

import { isList, record } from "../.github/actions/_lib/gate.ts";
import { requestTimingEffectConforms } from "../request-timing-conformance-effect.ts";

const ROOT = join(import.meta.dir, "..");

describe("the kit's Effect check", () => {
  test("passes on this repo's effect", () => requestTimingEffectConforms(effect));

  /**
   * The check run in a process where `process.getBuiltinModule` finds no
   * `node:async_hooks` until Effect has loaded, as on Node before 20.16.
   * Answers what the process printed and its exit status.
   */
  const withoutAsyncHooks = async () => {
    const script = [
      "const original = process.getBuiltinModule.bind(process);",
      'process.getBuiltinModule = (id) => (id === "node:async_hooks" || id === "async_hooks" ? undefined : original(id));',
      'const effect = await import("effect");',
      `const { requestTimingEffectConforms } = await import(${JSON.stringify(join(ROOT, "request-timing-conformance-effect.ts"))});`,
      "await requestTimingEffectConforms(effect).then(() => console.log('passed'), (error) => console.log(error.message));",
    ].join("\n");
    const run = Bun.spawn(["bun", "--eval", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [said, status] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return { said, status };
  };

  test("fails, saying why, where Effect resumes a fiber on the stack of the fiber that woke it", async () => {
    const { said, status } = await withoutAsyncHooks();
    expect(status).toBe(0);
    expect(said).toStartWith(
      "Effect resumed a fiber in another request's context, so a wait was counted in the wrong record or in none; request timing needs effect 4.0.1 or later",
    );
    // Every row but the detached fiber's, which starts on its parent's stack
    // and so counts right even here, is a row this Effect gets wrong.
    const rows = [
      "a shared semaphore",
      "a shared pool",
      "a shared deferred",
      "a shared queue",
      "a shared pubsub",
      "a shared stream",
      "an interrupt whose finalizer waits",
    ];
    const failed = said
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(failed).toEqual(
      ["runPromise", "managedRuntime"].flatMap((entry) =>
        rows.map((through) => `through ${through}, run by ${entry}`),
      ),
    );
  });

  test("refuses an effect without Effect 4's modules, as Effect 3 is", async () => {
    const three = { ...effect };
    Reflect.deleteProperty(three, "Semaphore");
    await expect(requestTimingEffectConforms(three)).rejects.toThrow(
      "was handed an effect with no Semaphore, so it is older than Effect 4: request timing needs effect 4.0.1 or later",
    );
  });
});

/** Every file `package.json`'s `files` ships, by its path from the root. */
async function shipped(): Promise<string[]> {
  const manifest = record(await Bun.file(join(ROOT, "package.json")).json());
  const found: string[] = [];
  for (const entry of isList(manifest["files"]) ? manifest["files"].map(String) : []) {
    const isDirectory = (await readdir(join(ROOT, entry)).catch(() => undefined)) !== undefined;
    if (!isDirectory) {
      found.push(entry);
      continue;
    }
    for (const name of await readdir(join(ROOT, entry), { recursive: true })) {
      found.push(join(entry, name));
    }
  }
  return found;
}

describe("dev-config ships Effect at runtime in the interleaving export alone", () => {
  // The contract's own reading of an import: Bun's parser, which erases a
  // type-only import as the runtime does. A declaration file runs nothing.
  test("no shipped module but the interleaving export's two imports effect except as types", async () => {
    const modules = (await shipped()).filter(
      (file) => /\.(?:[cm]?[jt]sx?)$/u.test(file) && !file.endsWith(".d.ts"),
    );
    expect(modules).toContain("dist/request-timing-conformance-effect.js");
    const importing: string[] = [];
    for (const file of modules) {
      const loader = file.endsWith("x") ? "tsx" : file.endsWith(".ts") ? "ts" : "js";
      // A bin's `#!` line is the shell's, which the parser refuses.
      const source = (await Bun.file(join(ROOT, file)).text()).replace(/^#!.*/u, "");
      const imports = new Bun.Transpiler({ loader }).scanImports(source);
      if (imports.some(({ path }) => path === "effect" || path.startsWith("effect/"))) {
        importing.push(file);
      }
    }
    expect(importing).toEqual(["interleaving.ts", "interleaving-runtime.ts"]);
  });

  test("and package.json installs no effect for an app: a devDependency, and a peer only as optional", async () => {
    const manifest = record(await Bun.file(join(ROOT, "package.json")).json());
    const naming = Object.entries(manifest)
      .filter(([, value]) => "effect" in record(value))
      .map(([field]) => field);
    expect(naming).toEqual(["devDependencies", "peerDependencies", "peerDependenciesMeta"]);
    expect(record(manifest["peerDependenciesMeta"])["effect"]).toEqual({ optional: true });
  });
});
