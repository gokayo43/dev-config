/**
 * The conformance kit against a booted server whose handler is plain and one
 * whose handler runs an Effect program, which must pass it, and against each
 * wrong adoption the kit names, which must fail it; and its
 * route-tree check against the Next.js fixture app's `app/` directory, which
 * must pass it, and against a tree per wrong wrapping, which must fail it
 * naming the file.
 */
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import {
  requestTimingConforms,
  requestTimingRoutesConform,
} from "../request-timing-conformance.ts";
import { type Adoption, DB_WAITS, PATTERN, presetServer } from "./request-timing-fixture.ts";
import { APP } from "./request-timing-next-fixture.ts";
import { scratch } from "./tree.ts";

const conforms = async (adoption: Adoption) => {
  await using server = presetServer(adoption);
  await requestTimingConforms({
    method: "GET",
    operation: PATTERN,
    dbWaits: DB_WAITS,
    drive: server.drive,
    next: server.next,
    sentinel: server.sentinel,
  });
};

describe("the conformance kit", () => {
  test("passes a plain async server", () => conforms("plain"));

  test("passes an Effect server", () => conforms("effect"));

  for (const adoption of ["uncounted", "doubled", "misnamed"] as const) {
    test(`fails a ${adoption} adoption`, async () => {
      await expect(conforms(adoption)).rejects.toThrow("the records one request was answered by");
    });
  }

  for (const adoption of ["echoed", "twice"] as const) {
    test(`fails a server that writes two records for one request: ${adoption}`, async () => {
      await expect(conforms(adoption)).rejects.toThrow("the records one request was answered by");
    });
  }

  test("refuses a sentinel named as the operation it reads up to", async () => {
    await expect(
      requestTimingConforms({
        method: "GET",
        operation: PATTERN,
        dbWaits: DB_WAITS,
        drive: async () => undefined,
        next: async () => "",
        sentinel: { operation: PATTERN, drive: async () => undefined },
      }),
    ).rejects.toThrow("as both");
  });
});

/** The repository's own sources, which a route file in a scratch tree imports by absolute path. */
const ROOT = dirname(import.meta.dir);

/** A route module whose `GET` is wrapped with `pattern`, or left bare where `pattern` is undefined. */
const routeFile = (pattern?: string) =>
  pattern === undefined
    ? 'export function GET() { return new Response("bare"); }\n'
    : [
        `import { requestTimingRoute } from "${join(ROOT, "request-timing-next.ts")}";`,
        `import { requestTiming } from "${join(ROOT, "request-timing.ts")}";`,
        "const timedRoute = requestTimingRoute(requestTiming({ fault: (error) => { throw error; }, sink: () => undefined }));",
        `export const GET = timedRoute("${pattern}", () => new Response("timed"));`,
        "",
      ].join("\n");

/** An `app` directory of the route files `files` names, under a scratch root. */
async function appTree(files: Readonly<Record<string, string>>): Promise<string> {
  const app = join(await scratch(), "app");
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(app, path), contents);
  return app;
}

/** Every route file a tree that passes holds: a group, an escaped underscore, a dynamic segment, a private folder and a build directory. */
const PASSING = {
  "route.ts": routeFile("/"),
  "(shop)/api/presets/[id]/route.ts": routeFile("/api/presets/[id]"),
  "%5F%5Froute-log/route.ts": routeFile("/__route-log"),
  "api/files/[...path]/route.tsx": routeFile("/api/files/[...path]"),
  "_lib/route.ts": routeFile(),
  ".next/server/app/api/route.js": routeFile(),
};

describe("the conformance kit's route-tree check", () => {
  test("passes the Next.js fixture app", () => requestTimingRoutesConform(join(APP, "app")));

  test("passes every way Next.js routes a file, and skips what it routes nothing from", async () => {
    await requestTimingRoutesConform(await appTree(PASSING));
  });

  const failing: [string, string, string, string][] = [
    ["an unwrapped handler", "api/plain/route.ts", routeFile(), "GET is not wrapped"],
    [
      "a pattern other than the file's place gives",
      "api/presets/[id]/route.ts",
      routeFile("/api/presets/:id"),
      'GET is wrapped with the pattern "/api/presets/:id", but its place under app/ routes it at "/api/presets/[id]"',
    ],
    [
      "an envelope left unmarked",
      "api/trpc/[trpc]/route.ts",
      "const handler = (request: Request) => new Response(request.url);\nexport { handler as GET, handler as POST };\n",
      "POST is not wrapped",
    ],
    [
      "a handler that answers with a status its record cannot see",
      "api/gone/route.ts",
      routeFile("/api/gone").replace(
        "import {",
        'import { notFound, redirect as away } from "next/navigation";\nimport {',
      ),
      "imports notFound, redirect from next/navigation",
    ],
    [
      "a route that takes the whole of next/navigation",
      "api/elsewhere/route.ts",
      `import * as navigation from "next/navigation";\n${routeFile("/api/elsewhere")}`,
      "imports notFound, redirect, permanentRedirect, forbidden, unauthorized from next/navigation",
    ],
  ];
  for (const [wrong, file, contents, problem] of failing) {
    test(`fails ${wrong}, naming the file`, async () => {
      const app = await appTree({ ...PASSING, [file]: contents });
      const checked = requestTimingRoutesConform(app);
      await expect(checked).rejects.toThrow(`${join(app, file)}: ${problem}`);
    });
  }
});
