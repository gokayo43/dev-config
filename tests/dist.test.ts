/**
 * The committed `dist/`, held equal to a fresh build. Which two exports are built
 * and why is `tsdown.config.ts`; that the result is committed rather than built
 * on install is STACK.md's bargain for a git dependency.
 *
 * A committed artifact is a second copy of the source, so something has to hold
 * the two together — and it is a test rather than a CI step because the pre-push
 * hook runs `bun test` and does not run CI. A stale `dist/` is then caught before
 * it is pushed rather than after, which is the whole difference between this and
 * a red build.
 */
import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { plainly } from "../.github/actions/_lib/gate.ts";
import { scratch } from "./tree.ts";

const HERE = join(import.meta.dir, "..");

/** What refreshes it, which is the whole of what a failure here has to say. */
const REFRESH = "`bun run build`, then commit dist/";

/** Every file under a directory, by its path relative to that directory. */
async function written(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of await readdir(root, { recursive: true })) {
    const path = join(root, name);
    if ((await stat(path)).isFile()) found.set(name, await Bun.file(path).text());
  }
  return found;
}

describe("the committed dist", () => {
  test("is what the build writes", async () => {
    const fresh = await scratch();
    const build = Bun.spawn([join(HERE, "node_modules", ".bin", "tsdown"), "--out-dir", fresh], {
      cwd: HERE,
      env: plainly(Bun.env),
      // The build's own progress is not this case's evidence, and what it writes
      // to the directory is; only what it says when it fails is kept.
      stdout: "ignore",
      stderr: "pipe",
    });
    const said = await new Response(build.stderr).text();
    expect(await build.exited, said).toBe(0);

    const [built, committed] = await Promise.all([written(fresh), written(join(HERE, "dist"))]);
    expect(
      [...committed.keys()].toSorted(),
      `dist/ holds other files than the build writes — ${REFRESH}`,
    ).toEqual([...built.keys()].toSorted());
    for (const [name, contents] of built) {
      expect(committed.get(name), `dist/${name} is not what the build writes — ${REFRESH}`).toBe(
        contents,
      );
    }
  }, 60_000);
});
