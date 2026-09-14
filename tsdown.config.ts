/**
 * Why these two entries, and why no others.
 *
 * `invariant-sweep.ts` and `route-log.ts` are imported by a repo's Playwright
 * specs. Playwright's runner is node, and node refuses to strip types from
 * anything under `node_modules` — `--experimental-strip-types` excludes that
 * directory outright, which is where every consumer has this package — so a
 * specifier resolving to a `.ts` there cannot load at all (dev-config#113).
 * Everything else here is imported by `bun test`, which strips types, and its
 * source is what ships.
 *
 * That `dist/` is committed rather than built on install is STACK.md's bargain
 * for a git dependency, under the shared UI library; `tests/dist.test.ts` is
 * this repo's half of it.
 *
 * `deps.dts.neverBundle` because the declaration pass resolves a type it is
 * handed rather than leaving it to the peer: without it `@playwright/test`'s
 * whole type surface — 2.3MB of it — is inlined into a 1KB declaration.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["invariant-sweep.ts", "route-log.ts"],
  platform: "neutral",
  dts: true,
  deps: { dts: { neverBundle: true } },
});
