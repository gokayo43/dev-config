/**
 * Serves a built TanStack Start fixture on a free loopback port, in a process
 * of its own, and writes its address as the first line of stdout:
 * `bun tests/request-timing-start-serve.ts <server entry>`. The fixture reads
 * how it runs from the environment it is given, once, when it loads, so the
 * differential's oracle, the same build with timing off, is a process of its
 * own beside the suite's.
 */
import { startServer } from "./request-timing-start-server.ts";

const [entry] = process.argv.slice(2);
if (entry === undefined) throw new Error("usage: request-timing-start-serve.ts <server entry>");
const { server } = await startServer(entry);
process.stdout.write(`${server.url.href}\n`);
