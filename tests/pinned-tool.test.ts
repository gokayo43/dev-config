import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { pinnedK6, Unmeasured } from "../capacity-ramp-ladder.ts";
import { scratch } from "./tree.ts";

/**
 * The verified fetch every pinned binary here goes through, sourced the way
 * its callers source it. `curl` is a stand-in first on PATH that serves the
 * archive a case chose, so no case reaches a network and each can hand the
 * loader what a substituted release or a dropped connection would.
 */

const LIBRARY = new URL("../.github/actions/_lib/pinned-tool.sh", import.meta.url).pathname;
const MEMBER = "tool-v1/tool";

/** A release archive holding `member`, a script that prints `said`, or holding nothing of that name. */
async function archive(
  root: string,
  name: string,
  said: string | null,
  wanted = MEMBER,
): Promise<string> {
  const tree = join(root, `${name}.tree`);
  const member = said === null ? `${wanted}.other` : wanted;
  await mkdir(dirname(join(tree, member)), { recursive: true });
  await Bun.write(join(tree, member), `#!/bin/sh\necho ${said ?? "nothing"}\n`);
  await chmod(join(tree, member), 0o755);
  const file = join(root, `${name}.tar.gz`);
  const tar = Bun.spawn(["tar", "-czf", file, "-C", tree, member]);
  expect(await tar.exited).toBe(0);
  return file;
}

function sha256Of(bytes: ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A `curl` that writes `served` wherever `-o` points and exits `status`, writing only its first 64 bytes when it fails. */
async function standInCurl(root: string, served: string, status: number): Promise<string> {
  const bin = join(root, `curl-${status}`);
  await mkdir(bin);
  const copy = status === 0 ? `cp '${served}' "$out"` : `head -c 64 '${served}' > "$out"`;
  await Bun.write(
    join(bin, "curl"),
    `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n${copy}\nexit ${status}\n`,
  );
  await chmod(join(bin, "curl"), 0o755);
  return bin;
}

/** The loader sourced as `form` names it, with no errexit, so only its own status can stop it. */
async function loaded(
  form: "statement" | "and-list",
  dir: string,
  sha256: string,
  curl: string,
): Promise<{ status: number; ran: string }> {
  const call = `pinned_tool '${dir}' https://releases.invalid/tool.tar.gz ${sha256} ${MEMBER}`;
  const script =
    form === "statement" ? `. '${LIBRARY}'\n${call}` : `. '${LIBRARY}' && ${call} && echo loaded`;
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { PATH: `${curl}:${Bun.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { status, ran: out };
}

describe("a pinned tool that did not arrive verified", () => {
  // Security 1 and failure 1: sourced under `&&` or without errexit, the loader
  // used to stop on a failure only where the caller's shell had errexit on, so
  // a checksum that failed still extracted the archive and wrote the receipt
  // that makes every later call trust it, and a fetch that failed wrote the
  // receipt over no binary. The likeliest wrong loaders are that one and one
  // that writes its receipt before the last step, and each leaves a receipt or
  // a tool behind in one of these rows.
  test.each([
    ["the checksum fails", "substituted", 0],
    ["the fetch fails part way", "pinned", 22],
    ["the archive holds no such member", "memberless", 0],
  ] as const)(
    "fails by itself, leaving nothing it vouches for, when %s",
    async (_, served, status) => {
      const root = await scratch();
      const pinned = await archive(root, "pinned", "the pinned tool");
      const substituted = await archive(root, "substituted", "not the pinned tool");
      const memberless = await archive(root, "memberless", null);
      const files = { pinned, substituted, memberless };
      // The pin is the archive the row expects to be served, so the memberless
      // archive passes its checksum and fails only its extract.
      const sha256 = sha256Of(
        await Bun.file(served === "memberless" ? memberless : pinned).arrayBuffer(),
      );
      const curl = await standInCurl(root, files[served], status);

      for (const form of ["statement", "and-list"] as const) {
        const dir = join(root, form);
        await mkdir(dir);
        const { status: loader, ran } = await loaded(form, dir, sha256, curl);
        expect(loader).not.toBe(0);
        expect(ran).not.toContain("loaded");
        expect(await readdir(dir)).toEqual([]);
      }
    },
  );

  // The receipt is what a later call trusts without fetching, so it is
  // written only once the tool is in place: the case above is the wrong half,
  // and this is the half that must keep working.
  test("a verified tool lands with its receipt and is reused without a fetch", async () => {
    const root = await scratch();
    const pinned = await archive(root, "pinned", "the pinned tool");
    const sha256 = sha256Of(await Bun.file(pinned).arrayBuffer());
    const dir = join(root, "tools");
    await mkdir(dir);

    const fetched = await loaded("and-list", dir, sha256, await standInCurl(root, pinned, 0));
    expect(fetched.status).toBe(0);
    expect(fetched.ran).toEndWith("loaded\n");
    expect((await readdir(dir)).toSorted()).toEqual(["tool", "tool.pinned"]);
    expect(await Bun.file(join(dir, "tool.pinned")).text()).toBe(sha256);

    // A curl that fails every call: the second load is the receipt's alone.
    const reused = await loaded("and-list", dir, sha256, await standInCurl(root, pinned, 22));
    expect(reused).toEqual({ status: 0, ran: "loaded\n" });
    const tool = Bun.spawn([join(dir, "tool")], { stdout: "pipe" });
    expect(await new Response(tool.stdout).text()).toBe("the pinned tool\n");
  });
});

describe("the k6 the capacity-ramp command runs", () => {
  const PATH = Bun.env["PATH"] ?? "";
  const signal = new AbortController().signal;

  // Security 1 on the command's own path, which sources the k6 loader with no
  // errexit: the substituted k6 ran, and every later run trusted it. A
  // substituted release is an archive at the pinned name whose k6 is
  // something else.
  test("a download that fails its checksum is refused, and nothing is left to trust", async () => {
    const root = await scratch();
    const { version } = await pinnedK6(Bun.env, signal);
    const member = `k6-${version}-linux-amd64/k6`;
    const curl = await standInCurl(root, await archive(root, "k6", "not k6", member), 0);
    const cache = join(root, "cache");
    const refused = pinnedK6({ PATH: `${curl}:${PATH}`, XDG_CACHE_HOME: cache }, signal);
    await expect(refused).rejects.toThrow(Unmeasured);
    await expect(refused).rejects.toThrow("did NOT match");
    expect(await readdir(join(cache, "dev-config", "k6"))).toEqual([]);
  });

  // Security 3: with no cache named, the cache fell under whatever directory
  // the command ran in, where a checkout could carry a k6 and the receipt
  // that makes it trusted. A relative `XDG_CACHE_HOME` is not a cache either.
  test.each([[{}], [{ XDG_CACHE_HOME: ".cache", HOME: "" }]])(
    "an environment naming no absolute cache (%j) is refused",
    async (named) => {
      await expect(pinnedK6({ PATH, ...named }, signal)).rejects.toThrow(
        "neither XDG_CACHE_HOME nor HOME names an absolute directory",
      );
    },
  );
});
