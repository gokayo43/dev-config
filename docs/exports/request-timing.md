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

1. **Switch it on with a sink**, once, at the app's entry point. The sink is the
   app's; the export writes nothing itself. It writes the record as one JSON
   object on one line of stdout, with any fields of the app's own beside the
   reserved names, and spreads the record last so a reserved name is never
   overwritten. An app whose other log lines are not JSON still writes this one
   as JSON.

   ```ts
   import { requestTiming } from "@gokayo43/dev-config/request-timing";

   export const timing = requestTiming({
     sink: (record) => console.log(JSON.stringify({ service: "api", ...record })),
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

3. **Make the crossing in**, where a plain handler (a tRPC procedure, a server
   function) runs an Effect program with a runtime. The entry connector opened
   the operation in the plain carrier, and `AsyncLocalStorage` holds it only up
   to the call that hands the program to the runtime; after that only the fiber
   is right. Wrap the program in `carryOperation` at that call, in the one module
   the app runs Effects from handlers through, its adapter:

   ```ts
   import { carryOperation } from "@gokayo43/dev-config/request-timing/effect";

   export const handle = <A>(program: Effect.Effect<A, AppError, AppServices>) =>
     runtime.runPromise(carryOperation(program.pipe(/* the app's error map */)));
   ```

   `carryOperation` reads the plain carrier's current operation when it is
   called, in the handler's context, and carries it in the program's fiber.
   With no current operation it answers the program unchanged. Call it per run,
   never once at module scope: a program carried once keeps the operation it
   was carried with.

4. **Make the crossing back out**, where an Effect program hands a
   promise-returning thunk to plain async code: the one service that wraps the
   database client, and the one outbound send. Use `tryPromiseCarried` there in
   place of `Effect.tryPromise`; it takes the same arguments and answers the
   same, and runs the thunk, and starts what it answers, under the plain carrier
   with the fiber's operation:

   ```ts
   import { tryPromiseCarried } from "@gokayo43/dev-config/request-timing/effect";

   const use = <A>(f: (client: Client) => PromiseLike<A>) =>
     tryPromiseCarried({ try: () => f(client), catch: (cause) => new DbError({ cause }) });

   const presets = use((client) => client.select().from(presetsTable));
   ```

   A drizzle query handed straight back, as `presets` does, is a lazy thenable
   that runs only when its `then` is called; `tryPromiseCarried` calls it,
   once, inside the carrier, so the query counts like one awaited inside the
   thunk.

   Every query a plain connector measures inside the thunk, across all of its
   awaits, a whole transaction included, counts in the fiber's operation, each
   as one wait. A fiber with no operation runs the thunk under none, so a wait
   in it counts nowhere, whatever `AsyncLocalStorage` holds where the fiber runs.
   Measuring with the Effect `measure` at the service instead would count one
   wait per service call, so a transaction of five queries would read as one and
   a query repeated in a loop would not show in the count.

5. **Wrap every wait**: the database client, the store client and the outbound
   `fetch` through their connectors, and any wait no connector covers (an SDK,
   SMTP) with `measure` directly:

   ```ts
   import { measure } from "@gokayo43/dev-config/request-timing";

   const sent = await measure("out", () => mailer.send(message));
   ```

   A plain connector reached from an Effect program counts correctly only
   inside a thunk run by `tryPromiseCarried`. A wait that is itself an Effect,
   with no plain code under it, is measured with the Effect `measure` from
   `@gokayo43/dev-config/request-timing/effect`:

   ```ts
   const cached = (key: string) => measure("store", cache.get(key));
   ```

6. **Run the conformance kit** in the app's own suite against its booted server
   (below).

### Which carrier

Which operation a wait belongs to is carried for it, by what the code is:

- Plain async code: `within`, `measure` and `inOperation` from
  `@gokayo43/dev-config/request-timing`, which carry the operation in
  `AsyncLocalStorage`.
- An Effect program: `within`, `measure`, `inOperation`, `carryOperation` and
  `tryPromiseCarried` from `@gokayo43/dev-config/request-timing/effect`, which
  carry it in the fiber. That file is the only one that imports `effect`, so an
  app without Effect never loads it. A fiber resumed by another (on a
  semaphore, a Deferred, a queue, or Effect's own scheduler) runs on that
  fiber's stack and holds its `AsyncLocalStorage`, so the Effect carrier never
  trusts that storage inside a program. It crosses at two places only. In:
  `carryOperation` reads the storage at the call that hands the program to the
  runtime, the last moment it is right. Out: `tryPromiseCarried` sets the
  storage from the fiber, or clears it when the fiber has no operation, while
  it calls the thunk and the `then` of what the thunk answers, and everything
  started there keeps that storage across its awaits. An edge that is itself an Effect program opens the
  operation and enters it with the Effect `within` instead of crossing in.

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
  `unmatched`, and so is one whose body the route could not parse, which Elysia
  refuses before the route's hooks run.
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
  the id in its URL is a hash in a build. A function in a file whose path the core refuses,
  one holding a space, `?` or `#`, fails on every call.
- A request no route matched is `unmatched`, and so is a call to a server
  function that does not exist, or one refused before the function ran, as by
  the CSRF check.
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
  `/_serverFn/`.

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

| Name                                                               | What it is                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestTiming({ sink, now? })`                                    | switches it on; answers `{ open(): Operation }`. `now` is the clock, epoch milliseconds, for a test's virtual one                                                                                                        |
| `Operation.close(ending)`                                          | emits the record through the sink, once                                                                                                                                                                                  |
| `within(operation, handler)`                                       | runs `handler` under `operation` and answers what it answers; one per carrier (a thunk for the plain one, an Effect for the Effect one)                                                                                  |
| `inOperation`                                                      | whether an operation is current: `inOperation(): boolean` plain, `inOperation: Effect<boolean>` Effect; an entry connector opens nothing while it is true                                                                |
| `tryPromiseCarried(evaluate)`, `tryPromiseCarried({ try, catch })` | Effect only: `Effect.tryPromise`, with the promise run under the plain carrier holding the fiber's operation, or under none when the fiber has none                                                                      |
| `carryOperation(program)`                                          | Effect only: `program` with the plain carrier's current operation, read at the call, carried in its fiber; `program` itself when none is current                                                                         |
| `measure(kind, wait)`                                              | runs `wait` unchanged and adds its duration to the current operation, or to nothing; one per carrier (`() => PromiseLike<T>` plain, an Effect for Effect)                                                                |
| `OperationName.registered(pattern)`                                | the name a router registered; refuses, without quoting it, a pattern that is empty, longer than 256 UTF-16 code units, holds a space or a character that does not print, or holds a query string, a fragment or a scheme |
| `OperationName.unmatched`                                          | the fixed name of a request no route matched                                                                                                                                                                             |
| `methodOf(written)`                                                | a request's method as a record carries it: `GET` `HEAD` `POST` `PUT` `PATCH` `DELETE` `OPTIONS`, or `OTHER`                                                                                                              |
| `RECORD_VERSION`, `WAIT_KINDS`, types                              | the schema version, the three kinds, and `TimingRecord`, `Ending`, `Sink`, `Clock`, `Method`, `WaitKind`, `Waited`, `Timing`, `TimingOptions`, `Operation`                                                               |

What a connector author has to hold:

- **No nesting.** Ask `inOperation` before opening, and when it answers true
  run the handler as it is: no `open`, no `within`, no `close`.
- **Open, run, close.** `timing.open()` starts the clock. The handler runs under
  it with the carrier's `within`. `operation.close({ method, name, status,
aborted, streamed })` is called once the response has finished: the last byte
  written, or the client gone (`aborted: true`), a streamed body included. The
  name and method are given at the close, so a connector that wraps the whole
  request before the router has matched it names the operation once it knows.
  `status` is the status the client received, a handler that threw included.
- **Close once.** A second `close` throws and emits nothing; so does a status
  outside 100 to 599. A sink that throws throws out of `close`, after the
  operation is sealed. An operation never closed writes no record, so a
  connector closes on every ending: finished, thrown and aborted.
- **Sealed at the close.** A wait still in flight at the close is counted in no
  kind's sum or count, now or when it settles, and a wait begun after it counts
  in nothing. The time it was in flight before the close is in `inFlightMs`,
  since the operation was waiting then.
- **`measure` reads the operation when it is called**, so a wait belongs to the
  operation that issued it, whoever settles it. Plain: `wait` is called once,
  synchronously; the answer is a new promise that settles as `wait`'s does, with
  its value or its rejection, and a synchronous throw is thrown on. A thenable
  `wait` answers has its `then` called once. Effect: the wait ends when the
  effect exits, by success, failure, defect or interruption, and a fiber forked
  under an operation inherits it.
- **A callback handed on.** A driver that queues a callback and calls it from
  another request's stack (a pool handing a connection to its next waiter) runs
  that callback in the other request's `AsyncLocalStorage` context. Call
  `measure` at the call the app made, which covers the time queued, or bind the
  callback with `AsyncResource.bind`.
- **Cost.** No I/O and no awaited step is added to an operation, and each wait
  costs a fixed amount of work: two clock readings and a few additions. The
  plain `measure`'s answer settles one microtask after `wait`'s promise does.

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
an `at` not in `toISOString`'s form stops the reader with status 1, and the
refused operation is not quoted. So a crafted line cannot put a terminal escape
or a fake row into what the reader prints, in either mode.

`--json` prints the same summary as one JSON object, `Summary` in
`request-timing-summary.ts`, for an agent to parse.

| Status | Meaning                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| 0      | the summary was printed                                                            |
| 1      | a record it cannot read, a schema version it does not know (named), or an argument |
| 2      | the input held no record, so an empty window is never read as a fast one           |

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
  }));
```

`drive` sends one request for an operation that makes `dbWaits` database waits,
at least one, and resolves once the response has been read to the end. `next`
resolves with the next line the server's sink wrote. The kit drives the
operation twice and requires each request to be answered by one record of that
method, name and database count, so a second record for one request, a missed
wait and a URL used as the name each fail it. A server that writes no record
leaves `next` waiting, and the test fails at its timeout.

## Ships built

The plain and the Effect carrier and every connector ship built, like
[the route log](route-log.md): app code that Next.js and Vite bundle imports
them, and neither strips types under `node_modules`. `tsdown.config.ts` carries why. The conformance kit and the
command ship their source, since only Bun runs them.
