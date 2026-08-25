/**
 * Every bun on this machine, so a case can be run under each of them.
 *
 * A gate step is shell that calls `bun`, and what bun does with a given
 * invocation is not fixed across the versions this fleet runs: `bun run <script>
 * ""` dropped an empty argument on 1.3.11 and forwarded it on 1.4.0, and
 * `bun --print 'require("./package.json")…'` throws on 1.4.0 where 1.3.11 prints
 * the word `undefined`. Both of those shipped, and both were graded under one
 * version only. A runner has a single bun — the one `packageManager` names — so
 * CI is one of these runs and this list is what makes the other one happen
 * before the release rather than after it.
 *
 * Shared because two suites now ask it. The list is by version rather than by
 * path: `/usr/local/bin/bun` and a symlink to it are one bun, and running a case
 * twice under it proves nothing.
 */
import { join } from "node:path";

async function versionOf(bun: string): Promise<string> {
  const proc = Bun.spawn([bun, "--version"], { stdout: "pipe", stderr: "ignore" });
  const version = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return version;
}

export const BUNS = await (async (): Promise<string[]> => {
  const onPath = (process.env["PATH"] ?? "").split(":").map((entry) => join(entry, "bun"));
  const candidates = [process.execPath, ...onPath];
  const there = await Promise.all(candidates.map((path) => Bun.file(path).exists()));
  const found = candidates.filter((_, at) => there[at] === true);
  const versions = await Promise.all(found.map(versionOf));
  return [...new Map(versions.map((version, at) => [version, found[at] ?? ""])).values()];
})();
