/**
 * Builds the TanStack Start fixture app in `request-timing-start-app` with
 * Vite and the Start plugin, as `vite build` builds the template, and answers
 * where its server entry landed.
 *
 * The output goes under `node_modules/.cache`, which git ignores and from
 * which the bundle's imports of `react` and the rest resolve. Start's build
 * reads its route manifest from the router generator, which writes a route
 * tree of its own; the fixture's routes are code, so the generator is pointed
 * at a scratch directory holding only a root route, and what it writes there
 * is read by nothing.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { createBuilder } from "vite";

const FIXTURE = join(import.meta.dir, "request-timing-start-app");

/** The built app, removed on disposal. `server` is the server entry's module. */
export async function builtStartFixture() {
  const out = join(
    import.meta.dir,
    "..",
    "node_modules",
    ".cache",
    `request-timing-start-${process.pid}`,
  );
  const generated = await mkdtemp(join(tmpdir(), "request-timing-start-routes-"));
  await mkdir(join(generated, "routes"));
  await writeFile(
    join(generated, "routes", "__root.ts"),
    'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute();\n',
  );
  const builder = await createBuilder({
    root: FIXTURE,
    configFile: false,
    logLevel: "error",
    // `bun` is a runtime built-in with no package behind it, which the
    // bundler would otherwise fail on; the template's config says the same.
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { external: ["bun"] } },
    plugins: [
      tanstackStart({
        router: {
          routesDirectory: join(generated, "routes"),
          generatedRouteTree: join(generated, "routeTree.gen.ts"),
        },
      }),
    ],
  });
  await builder.buildApp();
  await rm(generated, { recursive: true });
  return {
    server: join(out, "server", "server.js"),
    [Symbol.asyncDispose]: () => rm(out, { recursive: true }),
  };
}
