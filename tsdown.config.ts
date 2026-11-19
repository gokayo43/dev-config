/**
 * Why these fourteen entries, and why no others.
 *
 * `count-budget.ts`, `invariant-sweep.ts`, `narrowing.ts` and `route-log.ts`
 * are imported by a repo's Playwright specs. Playwright's runner is node, and node refuses to
 * strip types from anything under `node_modules` — `--experimental-strip-types`
 * excludes that directory outright, which is where every consumer has this
 * package — so a specifier resolving to a `.ts` there cannot load at all
 * (dev-config#113). `request-timing.ts` and the eight
 * `request-timing-<connector>.ts` are imported by an app's own code, which
 * Next.js and Vite bundle, and neither strips types under `node_modules`
 * either; the modules they share become chunks beside them.
 * `request-timing-conformance-effect.ts` is imported by an app's suite, but
 * it runs the core's `within` and `measure`, and `request-timing.ts` ships
 * built alone: built, the check takes them from the chunk the app's own
 * `request-timing` import loads, so one copy of the core, and of its
 * `AsyncLocalStorage`, serves both.
 * Everything else here is imported by `bun test` or
 * run by Bun, which strips types, and its source is what ships.
 *
 * That `dist/` is committed rather than built on install is STACK.md's bargain
 * for a git dependency, under the shared UI library; `tests/dist.test.ts` is
 * this repo's half of it.
 *
 * `deps.neverBundle` leaves every package import as it was written: node's
 * built-in modules, which the neutral platform resolves none of, and every
 * other package, since the build would otherwise inline a devDependency a
 * built file imports at runtime. A connector is written to import its
 * framework, and the kit's Effect check `effect`, as types alone; should one
 * of them import it at runtime, that import stays an import in `dist/`, where
 * `tests/request-timing-conformance-effect.test.ts` reads it, rather than
 * becoming a second copy of the package inside the file.
 *
 * `deps.dts.neverBundle` because the declaration pass resolves a type it is
 * handed rather than leaving it to the peer: without it `@playwright/test`'s
 * whole type surface — 2.3MB of it — is inlined into a 1KB declaration.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "count-budget.ts",
    "invariant-sweep.ts",
    "narrowing.ts",
    "request-timing.ts",
    "request-timing-bun-redis.ts",
    "request-timing-bun-sql.ts",
    "request-timing-conformance-effect.ts",
    "request-timing-elysia.ts",
    "request-timing-fetch.ts",
    "request-timing-mysql2.ts",
    "request-timing-next.ts",
    "request-timing-trpc.ts",
    "request-timing-tanstack-start.ts",
    "route-log.ts",
  ],
  platform: "neutral",
  dts: true,
  deps: { neverBundle: [/^[^./]/], dts: { neverBundle: true } },
});
