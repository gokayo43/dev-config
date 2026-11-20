# Request timing

`@gokayo43/dev-config/request-timing` records, per operation a server app
serves, where the time went: waiting on the database (`db`), on an outside HTTP
service (`out`), on an in-memory store such as Redis (`store`), and the rest.
Each operation closes into one record, a JSON line on the app's stdout, and the
package's `request-timing-report` command reads a log of them and says which
operations are slow and why.

An **operation** is the innermost named handler the framework dispatches: a
matched route handler, one RPC procedure, one server function. A tRPC batch
produces one record per procedure and none of its own. Work outside every
operation (startup, background jobs, timers) is in no record.

## Adopting it

In this order:

1. **Switch it on with a sink and a fault handler**, once, at the app's entry
   point. Both are the app's; the export writes nothing itself. The sink writes
   the record as one JSON object on one line of stdout, with any fields of the
   app's own beside the reserved names, and spreads the record last so a
   reserved name is never overwritten. An app whose other log lines are not
   JSON still writes this one as JSON. `fault` receives what goes wrong in
   closing an operation after its response has been answered: the error a sink
   threw; the core's refusal of a name, which says what shape it refused and
   never quotes it; its refusal of a status outside 100 to 599, as the 0 of
   `Response.error()`; and its refusal of a second close. Each is one call of
   `fault`, and that operation writes no record. It logs it the app's way, and
   the response stands. A `fault` that throws is the app's own error, and
   nothing catches it.

   ```ts
   import { requestTiming } from "@gokayo43/dev-config/request-timing";

   export const timing = requestTiming({
     sink: (record) => console.log(JSON.stringify({ service: "api", ...record })),
     fault: (error) => console.error("request timing:", error),
   });
   ```

2. **Mount the entry connector** for the app's framework. It opens an operation
   per request, runs the handler under it, names it as the router registered it,
   and closes it once the response has finished. Until a connector exists for
   the framework, an app does the same by hand, as in the fixture
   `tests/request-timing-fixture.ts`.

   **Operations never nest.** An entry connector asks `inOperation()` first and
   opens nothing when an operation is already current: it runs the handler as
   it is. So a server function a page calls in-process during its own request
   counts in the page's operation, and the page's record holds every wait of
   the request.

3. **Wrap every wait**: the database client, the store client and the outbound
   `fetch` through their connectors, and any wait no connector covers (an SDK,
   SMTP) with `measure` directly:

   ```ts
   import { measure } from "@gokayo43/dev-config/request-timing";

   const sent = await measure("out", () => mailer.send(message));
   ```

4. **Build the Effect runtime before the first request**, in an app that runs
   Effect programs: await its `context()` where the runtime is made, so its
   layer is built while no operation is current.

   ```ts
   export const runtime = ManagedRuntime.make(AppLayer);
   await runtime.context();
   ```

   A fiber keeps the operation of the fiber that forked it until that
   operation's record is emitted, and a `ManagedRuntime` left to itself builds
   its layer on its first run, inside the first request's fiber, so a worker or
   a poller the layer forks would count its waits in that request's record.

5. **Run the conformance kit** in the app's own suite against its booted server,
   in a Next.js app its route-tree check over `app/`, and in an app that runs
   Effect its Effect check (below).

### Effect programs

An app that runs Effect programs adopts with the same steps as one that does
not, and builds its runtime at startup (step 4). The handler runs its program
with its runtime, `runPromise` or a
`ManagedRuntime`'s, and the program's services keep calling the app's
clients under `Effect.tryPromise` or `Effect.promise`: the clients the
connectors wrap measure every wait the program makes, in the operation of the
request that runs it. Nothing crosses into the program or back out.

That rests on Effect itself. From effect 4.0.1, a fiber keeps the async context
it suspended in and resumes in it, so `AsyncLocalStorage` names the right
operation inside a program, even for a fiber woken by another request's fiber
through a shared semaphore, Deferred, queue, PubSub or pool. Effect finds what
it needs for that through `process.getBuiltinModule("node:async_hooks")`,
once, when its module loads; on a host where that finds nothing (Node before
20.16, Node 22.0 to 22.2) and on Effect 3, a woken fiber runs in the context
of the fiber that woke it, and its waits count in that request's record or in
none. Effect states this in its 4.0.1 changelog, and no Effect page promises
it, so an app that runs Effect runs the kit's Effect check, on its own Effect
and its own runtime.

What it leaves alone:

- A wait that is itself an Effect, with no promise under it, cannot be
  measured, and is in the rest.
- An HTTP edge that is itself an Effect program has no way to open an
  operation. Every entry connector here is for a framework the app's handlers
  run under.
- Work one fiber does for several requests, such as a `RequestResolver` batch
  or an `Effect.cached` value, counts in the request whose fiber ran it.
- A runtime built on its first run, rather than at startup, forks its layer's
  fibers inside the first request's fiber: their waits count in that
  request's record until it is emitted, and in no record after. Work forked
  outside every operation, by a runtime built at startup, is in no record.

## Elysia

`@gokayo43/dev-config/request-timing/elysia` is the entry connector for an
Elysia app. Mount it once, after the error handler and ahead of every route,
since Elysia applies a hook only to the routes registered after it:

```ts
import { requestTimingPlugin } from "@gokayo43/dev-config/request-timing/elysia";

export const app = new Elysia().use(errorHandler).use(requestTimingPlugin(timing)).use(routes);
```

- Every request the app serves is one operation, from before its `onRequest`
  hooks to the end of its response, whatever plugins run around the handler.
- The name is the route as Elysia registered it. A request no route matched is
  `unmatched`, and so is every request that ends before Elysia has matched its
  route, which it does after reading the body: one whose body the route could
  not parse, one whose client left while its body was being read, and one an
  app's own `onRequest` hook answered.
- The status is the one the client received, whichever error handler made it.
  A handler of errors that throws leaves the server to answer, and the record
  says 500, which is Bun's answer; an app that sets Bun's `error` option in
  Elysia's `serve` config answers 500 there too, or its records disagree with
  its clients.
- A buffered response closes its operation when Elysia hands it to Bun. A
  streamed one, which is every generator, `ReadableStream` and `sse()` a handler
  answers and every response that says `transfer-encoding: chunked`, closes
  after its last chunk, with `streamed: true`. A handler that builds its own
  `Response` around a `ReadableStream` without that header is a buffered
  response to the connector, since Bun shows no difference: it closes when the
  response is handed over, and what the body waits on while it is read is in
  no record. Answer the stream itself, or say `transfer-encoding: chunked`.
- A client that goes away closes the operation then, with `aborted: true` and
  the status the handler had produced, or 499 where it had produced none. What
  the handler waits on after that is in no record.
- Mounting it behind a route throws, naming the route, and `listen` throws on a
  route whose pattern the core refuses, such as an optional parameter `/:id?`.
  An app served by Bun with `app.fetch`, without `listen`, meets that pattern
  at the route's first request: the refusal goes to `fault`, the response is
  served, and the request writes no record. So does a response with a status
  no response can be sent with, `Response.error()`'s 0, which Bun answers with
  its own 500.
- The connector runs the request inside Elysia's `.wrap()`, which Elysia's
  source marks as private. A change to it breaks the connector without a type
  error; this repo's Elysia suite, run on every Elysia bump, is what catches
  it.
- A WebSocket route's upgrade is one operation, recorded with the 101 the
  client received once Bun's server took the request over. The messages after
  it are in no record.
- A request the app serves in-process while an operation is current, as
  `app.handle` called from a handler, opens no operation of its own: its waits
  count in the operation of the request that made it.

## TanStack Start

`@gokayo43/dev-config/request-timing/tanstack-start` is the entry connector for
a TanStack Start app. An app mounts its two halves once each: the server
entry's handler, wrapped, and a function middleware that names the operation of
a server function called over HTTP.

```ts
// src/server.ts
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { timedStartHandler } from "@gokayo43/dev-config/request-timing/tanstack-start";

export default {
  fetch: timedStartHandler(timing, createStartHandler(defaultStreamHandler), getRouter),
};
```

```ts
// src/start.ts
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { nameServerFunction } from "@gokayo43/dev-config/request-timing/tanstack-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" }),
  ],
  functionMiddleware: [createMiddleware({ type: "function" }).server(nameServerFunction)],
}));
```

Start mounts its own CSRF check on server functions only while an app has no
`src/start.ts`, so an app that adds the file lists the check there, as above.
`nameServerFunction` goes first among the function middleware.

- Every request the app serves is one operation, from the call of the handler
  to the last byte of its response: a page, a server route, and a server
  function called over HTTP. The path that carries server-function calls opens
  no operation of its own; a call's operation is the function's.
- A page or a server route is named by the route the router matched, as it was
  registered: `/presets/$id`. `getRouter` is called once, when the handler is
  wrapped, and every route it registers is named then, so a pattern the core
  refuses throws at startup. The router is asked about the request's path as it
  arrived, so an app whose router sets a `basepath` or a `rewrite` records
  every request as `unmatched`.
- A server function is named by its file and variable as Start's compiler
  records them, `src/server/presets.ts:listPresets`, which no build changes;
  the id in its URL is a hash in a build. A name the core refuses, from a file
  path holding a space, `?` or `#` or a name longer than it takes, goes to
  `fault` when the call closes; the call is served, and writes no record.
- A request no route matched is `unmatched`, and so is a call to a server
  function that does not exist, one refused before the function ran, as by
  the CSRF check, and one whose client left before the function ran, since its
  name is known only once `nameServerFunction` has run.
- A response with a status no response can be sent with, `Response.error()`'s
  0, which Bun answers with its own 500, goes to `fault` and writes no record.
- A page that renders on the server and calls server functions in-process, from
  a loader, is one operation, the page's. The in-process calls open nothing and
  name nothing, and their waits count in the page's record. So does a request
  served in-process by calling the handler while an operation is current.
- The status is the one the client received. A page or a server route whose
  handler throws leaves the server to answer, and the record says 500, which is
  Bun's answer to a fetch that throws; a server that answers otherwise leaves
  its records disagreeing with its clients. A server function that throws is answered by Start,
  200 with the error in its body, and the record says 200.
- A response closes after the last chunk of its body. It is `streamed` when it
  is sent over time: a `text/event-stream`, a server function's framed answer
  (a stream, an async iterable or an unresolved promise it returns), or any
  response that says `transfer-encoding: chunked`. A rendered page is not
  `streamed`: its time to the last byte is its own work.
- A response whose headers name no content type, as a string or bytes answered
  bare, closes when it is handed to the server, because Bun gives its body a
  content type of its own as it sends it, which a watched copy would not get.
  What a stream answered that way waits on after the hand-over is in no record;
  name its content type.
- A client that goes away closes the operation then, with `aborted: true` and
  the status the handler had produced, or 499 where it had produced none. The
  connector reads that from `request.signal`, which Bun's server fires when the
  client goes away.
- An app that sets `serverFns.base` in the Start plugin, or a router
  `basepath`, passes the path server functions are called on as the fourth
  argument, `{ serverFnBase: "/rpc/" }`; unset, it is Start's own,
  `/_serverFn/`. A path that does not begin and end with `/` is refused, by
  throwing, when the handler is wrapped.

## Next.js route handlers

`@gokayo43/dev-config/request-timing/next` wraps each handler a `route.ts`
exports. Make the wrapper once, beside the sink, and wrap every handler with
the pattern its file's place under `app/` gives it:

```ts
import { requestTimingRoute } from "@gokayo43/dev-config/request-timing/next";

export const timedRoute = requestTimingRoute(timing);
```

```ts
// app/api/presets/[id]/route.ts
export const GET = timedRoute("/api/presets/[id]", async (request, { params }) => ...);
```

- The name is the pattern as Next.js's own route literals write it
  (`RouteContext<"/api/presets/[id]">`): each folder as written, dynamic
  segments in brackets (`[id]`, `[...path]`, `[[...path]]`), route groups
  `(name)` and slots `@name` left out, and a leading `%5F` read as the
  underscore it stands for. Next.js tells a handler nothing of its own route,
  so the app states it, and the conformance kit's route-tree check (below)
  holds every statement to its file's place.
- Next.js 16 offers no public way to see every request with its matched route
  and run the handler inside a function of ours. `instrumentation.ts`'s
  `register` runs once at boot, and its `onRequestError` sees a request only
  when it failed, after the fact. The OpenTelemetry spans carry `next.route`,
  but only to a tracer the app registers, which neither runs the handler under
  an operation nor says when a streamed body has ended. `proxy.ts` runs before
  routing and knows no route. Hence the wrapper.
- A request the handler serves is one operation, from the call to the end of
  its response: once the server has taken the last chunk of the body, or at
  once where there is no body, or the request is a HEAD, whose body Next.js
  never reads. A body's source runs in the context the handler made it in,
  so what it waits on as it is pulled counts in the operation. A body is `streamed`
  where it handed over a chunk and was not finished on the next read, so a
  buffered body, one chunk and then its end, is not.
- The status is the response's. A handler that throws is recorded with the
  500 Next.js answers.
- A client that goes away closes the operation then, with `aborted: true` and
  the status the handler had produced, or 499 where it had produced none, and
  so does a client already gone when the wrapper runs. What the handler waits
  on after that is in no record.
- A response with a status no response can be sent with, `Response.error()`'s
  0, goes to `fault` and writes no record; so does a sink that throws.
- A handler called while an operation is current runs as it is.
- A pattern the core refuses throws when the route module loads, which
  `next build` does for every route while it collects page data.
- Left alone: a URL no route matches and a method a route does not export,
  which Next.js answers without calling a handler, so this connector writes no
  `unmatched` record; the `OPTIONS` Next.js answers itself; pages and server
  components, whose render is in no record; and server actions, which no
  connector covers.
- Left alone, and wrong in the record: the status of a handler that ends by calling
  `notFound()`, `redirect()`, `permanentRedirect()`, `forbidden()` or
  `unauthorized()` from `next/navigation`. Each throws, and Next.js answers
  with 404, 307, 308, 403 or 401 by means it does not make public, so the
  record says 500 while the client received the other. The route-tree check
  below refuses a `route.ts` that imports any of them; return the response
  instead (`new Response(null, { status: 404 })`, `NextResponse.redirect(url)`).

## tRPC

`@gokayo43/dev-config/request-timing/trpc` is one middleware the app puts first
on its base procedure, and the envelope it wraps the route that serves the
router over HTTP in. tRPC's mapping of an error to an HTTP status,
`getHTTPStatusCodeFromError`, is handed over by the app, since this package
imports tRPC as types alone:

```ts
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { requestTimingProcedures } from "@gokayo43/dev-config/request-timing/trpc";

export const procedureTiming = requestTimingProcedures(timing, getHTTPStatusCodeFromError);
export const procedure = t.procedure.use(procedureTiming.middleware);
```

```ts
// app/api/trpc/[trpc]/route.ts
const handler = procedureTiming.envelope(appRouter, (request: Request) =>
  fetchRequestHandler({ endpoint: "/api/trpc", req: request, router: appRouter, createContext }),
);

export { handler as GET, handler as POST };
```

- Every call of a procedure built on the base procedure that arrives through
  the envelope is one operation, alone or in a batch: a batch of three calls is
  three records, and the envelope's route writes none. A call made in-process,
  `createCaller` from a test, a page or a background job, opens none, and nor
  does a call made while an operation is current.
- The name is the procedure's path, `presets.byId`. The envelope checks every
  path of the router when its route module loads, so a path the core refuses
  fails `next build`. A lazily loaded router's paths are met when a call
  closes: a refused one goes to `fault`, the call is answered, and it writes
  no record.
- The method is what an HTTP reader expects of the call's type, whatever the
  client sent it with: a query is `GET`, also when sent as a POST for a long
  input, a mutation `POST`, a subscription `GET`.
- A call closes when its procedure has answered, with 200, or with the status
  `getHTTPStatusCodeFromError` gives its error, which is the status the call
  receives when sent alone. Inside a batch the response's own status is the
  batch's, and each record still carries its own call's. A status an app's `responseMeta` sets is not seen.
- Since the middleware is first, everything after it is inside the operation:
  each middleware, the input's validation, and the procedure. A refusal there
  is recorded with its status (403 for a `FORBIDDEN` a role check throws, 400
  for an input its validator refused).
- A client that goes away before the answer closes the call then, `aborted`,
  with 499, and so does a client already gone when the middleware runs, as
  while tRPC was still creating the context; what the procedure waits on after
  that is in no record.
- A procedure that answers an async iterable, every subscription and a query
  streamed over `httpBatchStreamLink`, closes when the iteration ends, with
  200 and `streamed: true`, and each step of the iteration runs under the
  operation, so the waits between two events count. A client that goes away
  closes it `aborted`, and so does tRPC's own `sse.maxDurationMs`, which aborts
  the same signal. A subscription that answers an observable, tRPC's older
  form, closes when it is answered, and what it emits is in no record; so are
  the promises a streamed answer settles after it was answered.
- Left alone: a call tRPC refuses before any procedure runs, an unknown path, a
  context that throws, a method the procedure does not take, writes no record;
  tRPC's `onError` sees it.

## mysql2

`@gokayo43/dev-config/request-timing/mysql2` wraps a pool `mysql2/promise`
made. Use the answer wherever the pool was used, drizzle included:

```ts
import { timedPool } from "@gokayo43/dev-config/request-timing/mysql2";

export const pool = timedPool(mysql.createPool(options));
export const db = drizzle(pool, { schema, mode: "default" });
```

One `db` wait each:

- `pool.query` and `pool.execute`, with the checkout they make inside;
- `pool.getConnection`, the checkout itself, which answers a connection whose
  waits are counted in turn: `query`, `execute`, `beginTransaction`, `commit`,
  `rollback`, `ping`, `reset`, `changeUser` and `prepare`, and the prepared
  statement's `execute`. A named lock taken with `GET_LOCK` on such a
  connection is one of its queries.

So a drizzle transaction on the pool is its checkout, `begin`, each statement
and `commit` or `rollback`. Streamed rows, drizzle's `.iterator()`, are the
checkout alone: the rows are read through the callback connection beneath, and
the time between them is in the rest. Everything else is the pool's own, so
`release`, `releaseConnection`, the events and the escapes are what they were.

## Bun.sql

`@gokayo43/dev-config/request-timing/bun-sql` wraps an `SQL` client. Use the
answer wherever the client was used, drizzle and Better Auth's drizzle adapter
included:

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { timedSql } from "@gokayo43/dev-config/request-timing/bun-sql";

const client = timedSql(new SQL(env.DATABASE_URL));
export const db = drizzle({ client, schema });
```

One `db` wait each:

- a query, made by calling the client as a tagged template or with a string,
  by `unsafe` or by `file`, from when it starts running until it settles, which
  includes waiting for a pooled connection. A query starts on its first
  `await`, `then`, `catch`, `finally` or `execute`, so one made and never run
  counts nothing and one awaited twice counts once;
- opening a transaction (`begin`, `transaction`, `beginDistributed`,
  `distributed`), which takes the connection and sends BEGIN, until its
  callback runs, and closing it, COMMIT or ROLLBACK, from when the callback's
  answer settles. The queries of the client the callback is handed count one
  each, and a savepoint on it is two more, opening and closing;
- `reserve`, the checkout, answering a reserved connection whose queries count
  one each;
- `connect`, `listen` until the server confirms it, `notify`,
  `commitDistributed` and `rollbackDistributed`.

So a drizzle transaction of one insert is three, a savepoint inside it adds two
beside its own queries, and a transaction that answers an array of queries is
two and one per query. Every query is
the driver's own object, with the members that start it standing in on it, so
its type, `values`, `raw`, `simple`, `cancel` and every result are the
driver's. The helpers a call makes of an object or an array, `array`, `json`,
`release`, `close`, `end` and `flush` are the client's own, and so are a query's
`readable` and `writable` copy streams, whose time is in the rest.

## Bun's Redis client

`@gokayo43/dev-config/request-timing/bun-redis` wraps a `Bun.RedisClient`:

```ts
import { timedBunRedis } from "@gokayo43/dev-config/request-timing/bun-redis";

export const redis = timedBunRedis(new RedisClient(url));
```

Every method but `close` is one `store` wait: each command, `send`, `connect`,
and `duplicate`, whose client is wrapped the same way. Bun's client has no batch
object, so a MULTI sent with `send` is a wait, each command after it is one, and
so is EXEC. `subscribe` is a wait until the server confirms it, and the messages
its listener receives are not.

## fetch

`@gokayo43/dev-config/request-timing/fetch` wraps a `fetch`. An app uses the
answer at its outbound calls or installs it as the global, handing it the
global it replaces:

```ts
import { timedFetch } from "@gokayo43/dev-config/request-timing/fetch";

globalThis.fetch = timedFetch(globalThis.fetch);
```

Each call is one `out` wait, from the call until its promise settles, which is
when the response's headers have arrived or the call has failed. Reading the
body is not part of the wait, and is in the rest.

## The interface a connector builds on

| Name                                   | What it is                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestTiming({ sink, fault, now? })` | switches it on; answers `{ open(): Operation, finish(operation, ended) }`. `now` is the clock, epoch milliseconds, for a test's virtual one                                                                              |
| `timing.finish(operation, ended)`      | how a connector closes: builds the ending with `ended()` and closes `operation` with it, handing anything either throws to `fault`                                                                                       |
| `Operation.close(ending)`              | emits the record through the sink, once; throws on a second close, a refused status or a sink that throws, which a connector's own suite reads                                                                           |
| `within(operation, handler)`           | runs `handler`, a thunk, under `operation` and answers what it answers                                                                                                                                                   |
| `inOperation`                          | `inOperation(): boolean`, whether an operation is current; an entry connector opens nothing while it is true                                                                                                             |
| `measure(kind, wait)`                  | runs `wait`, a `() => PromiseLike<T>`, unchanged and adds its duration to the current operation, or to nothing                                                                                                           |
| `OperationName.registered(pattern)`    | the name a router registered; refuses, without quoting it, a pattern that is empty, longer than 256 UTF-16 code units, holds a space or a character that does not print, or holds a query string, a fragment or a scheme |
| `OperationName.unmatched`              | the fixed name of a request no route matched                                                                                                                                                                             |
| `methodOf(written)`                    | a request's method as a record carries it: `GET` `HEAD` `POST` `PUT` `PATCH` `DELETE` `OPTIONS`, or `OTHER`                                                                                                              |
| `RECORD_VERSION`, `WAIT_KINDS`, types  | the schema version, the three kinds, and `TimingRecord`, `Ending`, `Sink`, `Fault`, `Clock`, `Method`, `WaitKind`, `Waited`, `Timing`, `TimingOptions`, `Operation`                                                      |

What a connector author has to hold:

- **No nesting.** Ask `inOperation` before opening, and when it answers true
  run the handler as it is: no `open`, no `within`, no `close`.
- **Open, run, finish.** `timing.open()` starts the clock. The handler runs
  under it with `within`. `timing.finish(operation, () => ({
  method, name, status, aborted, streamed }))` is called once the response has
  finished: the last byte written, or the client gone (`aborted: true`), a
  streamed body included. The name and method are given at the close, so a
  connector that wraps the whole request before the router has matched it
  names the operation once it knows, and builds the name inside `ended`, where
  a name the core refuses goes to `fault` with the rest. `status` is the
  status the client received, a handler that threw included.
- **Nothing a connector does turns a served response into a failed one.** It
  closes with `finish`, never `close`: `finish` hands a refused name, a refused
  status (`Response.error()` has status 0), a sink that throws and a second
  close to the app's `fault`, so no rejection goes unhandled and no response
  fails for its record.
- **Close once.** A second `close` throws and emits nothing; so does a status
  outside 100 to 599. A sink that throws throws out of `close`, after the
  operation is sealed. An operation never closed writes no record, so a
  connector closes on every ending: finished, thrown and aborted.
- **Sealed at the close.** A wait still in flight at the close is counted in no
  kind's sum or count, now or when it settles, and a wait begun after it counts
  in nothing. The time it was in flight before the close is in `inFlightMs`,
  since the operation was waiting then.
- **`measure` reads the operation when it is called**, so a wait belongs to the
  operation that issued it, whoever settles it. `wait` is called once,
  synchronously; the answer is a new promise that settles as `wait`'s does, with
  its value or its rejection, and a synchronous throw is thrown on. A thenable
  `wait` answers has its `then` called once.
- **A callback handed on.** A driver that queues a callback and calls it from
  another request's stack (a pool handing a connection to its next waiter) runs
  that callback in the other request's `AsyncLocalStorage` context. Call
  `measure` at the call the app made, which covers the time queued, or bind the
  callback with `AsyncResource.bind`.
- **Cost.** No I/O and no awaited step is added to an operation, and each wait
  costs a fixed amount of work: two clock readings and a few additions.
  `measure`'s answer settles one microtask after `wait`'s promise does.

## The record

```json
{
  "requestTiming": 1,
  "at": "2026-11-18T10:00:00.000Z",
  "method": "GET",
  "operation": "/presets/:id",
  "status": 200,
  "totalMs": 41.2,
  "inFlightMs": 30.5,
  "db": { "waitMs": 28.1, "count": 3 },
  "out": { "waitMs": 0, "count": 0 },
  "store": { "waitMs": 2.4, "count": 1 },
  "aborted": false,
  "streamed": false
}
```

`requestTiming` is the schema version, and its presence is what makes a line a
record. A kind's `waitMs` is the sum of its waits, which passes `totalMs` where
they ran in parallel. `inFlightMs` is the time during which at least one wait
was in flight, so **the rest**, `totalMs - inFlightMs`, is never negative. The
rest holds the code's own time and every wait nobody measured, so it is never
called "the app's code". Durations carry microseconds.

Nothing of a person can be represented in a record: every field is a number, a
boolean, a word from a closed set, the time of emission, or the name the router
registered (`/presets/:id`, never `/presets/42`). No query text, parameter,
query string, header, body or host of an outside call reaches one, since
`measure` sees none of them and `OperationName` can only be made from a pattern.

`status` is the status the client received, a handler that threw included,
with these exceptions, each named under its connector:

- A call inside a tRPC batch carries its own call's status, the one it would
  receive sent alone, while the batch's response has one status for all; and a
  status an app's tRPC `responseMeta` sets is not seen.
- A Next.js route handler that ends by calling `notFound()` or another of
  `next/navigation`'s throwing helpers is recorded with 500, which the
  route-tree check refuses.
- An Elysia app whose Bun `error` option answers a thrown error with other
  than 500, and a TanStack Start server that answers a page's or a server
  route's throw with other than Bun's 500, are recorded with 500 all the same.

A record that is wrong is an issue on this repo: it is derived, never edited.

## Reading a log

```sh
journalctl -o cat -u my-app --since -7d | bun run request-timing-report
journalctl -o cat -u my-app --since -7d | bun run request-timing-report --json
```

`bun run` finds the command in the repo's own install. It reads stdin, keeps
the records among the lines, and skips every other line, JSON or not. A record
must be the whole line, so strip whatever prefix the log adds (`-o cat` for
journald). It prints:

- records per day (UTC);
- per operation, slowest mean first: count, aborted, mean and total time, the
  share of its summed time in each kind of wait and in the rest, and waits per
  operation by kind;
- streamed operations in a ranking of their own, so a minutes-long stream does
  not top the list.

A record is read only in the shape the export writes: an `operation` that
`OperationName.registered` would refuse, a `method` outside the closed set, or
an `at` not in `toISOString`'s form stops the reader with status 1. What it
defends is its own output: nothing it prints, in either mode, carries a
control character, a bidi override or any other text a log line chose, since
every printed name passed that rule and no error message quotes a value off a
line. What it trusts is that the lines it is given were written by the app's
sink: any line carrying `requestTiming` in a valid shape is a record, so a
forged one is summed like any other, and a log anyone else can write to is not
one to read with it. One record of a schema version it does not know stops the
whole report, by design, since a summary that skipped it would describe a
window it had not read.

`--json` prints the same summary as one JSON object, `Summary` in
`request-timing-summary.ts`, for an agent to parse.

| Status | Meaning                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 0      | the summary was printed                                                                                       |
| 1      | a record it cannot read, a schema version it does not know (named where it is a whole number), or an argument |
| 2      | the input held no record, so an empty window is never read as a fast one                                      |

## The conformance kit

`@gokayo43/dev-config/request-timing/conformance` is imported by the app's own
`bun test` suite and run against its booted server:

```ts
import { requestTimingConforms } from "@gokayo43/dev-config/request-timing/conformance";

test("request timing", () =>
  requestTimingConforms({
    method: "GET",
    operation: "/presets/:id",
    dbWaits: 2,
    drive: async () => void (await (await fetch(`${server.url}presets/1`)).text()),
    next: () => stdoutLines.next(),
    sentinel: {
      operation: "/health",
      drive: async () => void (await (await fetch(`${server.url}health`)).text()),
    },
  }));
```

`drive` sends one request for an operation that makes `dbWaits` database waits
and resolves once the response has been read to the end. `next` resolves with
the next line the server's sink wrote. `sentinel` is a second operation of the
same server, any other route, which the kit reads up to: a record carries
nothing that tells one request's from another's, so "exactly one" needs a point
after which the graded request can have written nothing more. The kit drives
the sentinel and reads to its record, so whatever the server wrote before is
behind it; drives the operation; drives the sentinel again; and requires the
records between the two sentinel records to be exactly one, of that method,
name and database count. So a server that writes two records for one request,
whatever they hold, fails it, as two copies of the export in one process do,
and so do a missed wait and a URL used as the name. It assumes a record is
written by the time the server has answered a later request, and that nothing
else reaches the server while it runs. A server that writes no record leaves
`next` waiting, and the test fails at its timeout.

A Next.js app runs the kit's route-tree check too, over its own `app`
directory, since each route states its own pattern:

```ts
import { requestTimingRoutesConform } from "@gokayo43/dev-config/request-timing/conformance";

test("every route handler is timed as its route", () =>
  requestTimingRoutesConform(join(import.meta.dir, "../app")));
```

It imports every `route.{js,jsx,ts,tsx}` under the directory, skipping private
folders `_name` and every directory whose name starts with a dot, and requires
each handler it exports for a method to be wrapped by the route wrapper with
the pattern the file's place gives it, or to be the tRPC envelope. A bare
handler, a pattern the file's place does not give, and a tRPC route left
unmarked each fail it, naming the file and the method, and so does a route file
that imports `notFound`, `redirect`, `permanentRedirect`, `forbidden` or
`unauthorized` from `next/navigation`, whose answer its record would get wrong.
It reads the imports the file itself writes, so one of those called through a
helper module is not seen.

The route modules load in the suite's own process, because the mark a
connector leaves on a handler exists only once the module has run: the
source alone cannot say what `handler` is in `export { handler as GET }`. So
whatever a module does when it loads, it does there, under the suite's own
preload, and a module that needs `server-only` or the environment needs what
the app's other suites already give it. It also puts every `route.ts` in the
suite's coverage, at what loading it executes. An app whose floor is graded
over the whole suite sees its totals move a little. An app whose floor is
Bun's per-file `coverageThreshold` sees each route below it unless a test of
its own calls the handlers; one whose handlers run only in a server it spawns
lists those routes in `coveragePathIgnorePatterns`, with the suite that grades
them, as this repo does for its fixture apps in `bunfig.toml`.

An app that runs Effect runs the kit's Effect check too, handing it the
`effect` module it has installed:

```ts
import * as effect from "effect";
import { requestTimingEffectConforms } from "@gokayo43/dev-config/request-timing/conformance/effect";

test("request timing counts an Effect program's waits", () => requestTimingEffectConforms(effect));
```

It opens overlapping operations through the real core and runs in each an
Effect program whose waits pass through a shared semaphore, pool, Deferred,
queue, PubSub and stream, an interrupt whose finalizer waits, a detached fiber
and a lazy thenable under `Effect.tryPromise`, beside work outside every
operation,
through `Effect.runPromise` and through a `ManagedRuntime` built before any
operation. It rejects unless every record carries exactly its own waits,
saying that Effect resumed a fiber in another request's context and that
request timing needs effect 4.0.1 or later on a host whose
`process.getBuiltinModule` finds `node:async_hooks`, followed by each case it
counted wrong. Handed an Effect 3 module, it rejects at once, naming the
modules Effect 4 has and it does not. It touches no server, so it runs once
per suite in tens of milliseconds, and it takes the app's `effect` rather than
importing one, so dev-config gains no runtime dependency.

## Ships built

The core and every connector ship built, like [the route log](route-log.md):
app code that Next.js and Vite bundle imports them, and neither strips types
under `node_modules`. The kit's Effect check ships built too: it runs the
core's `within` and `measure`, which ship built alone, and built it takes them
from the chunk the app's own `request-timing` import loads, so one copy of the
core and of its `AsyncLocalStorage` serves both. `tsdown.config.ts` carries
why. The rest of
the conformance kit and the command ship their source, since only Bun runs
them.
