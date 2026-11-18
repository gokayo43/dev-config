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

3. **Make the crossing**, where a plain handler (a tRPC procedure, a server
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

4. **Wrap every wait**: the database client, the store client and the outbound
   `fetch` through their connectors, and any wait no connector covers (an SDK,
   SMTP) with `measure` directly:

   ```ts
   import { measure } from "@gokayo43/dev-config/request-timing";

   const sent = await measure("out", () => mailer.send(message));
   ```

   In an Effect program, from `@gokayo43/dev-config/request-timing/effect`:

   ```ts
   const send = (message: Message) =>
     measure(
       "out",
       Effect.tryPromise(() => mailer.send(message)),
     );
   ```

   Inside an Effect program every wait is measured with the Effect `measure`, at
   the service that wraps the client. A wait measured by the plain carrier
   inside the program reads `AsyncLocalStorage`, which after the crossing may
   hold another request's operation, so it can land in the wrong record.

5. **Run the conformance kit** in the app's own suite against its booted server
   (below).

### Which carrier

Which operation a wait belongs to is carried for it, by what the code is:

- Plain async code: `within`, `measure` and `inOperation` from
  `@gokayo43/dev-config/request-timing`, which carry the operation in
  `AsyncLocalStorage`.
- An Effect program: `within`, `measure`, `inOperation` and `carryOperation`
  from `@gokayo43/dev-config/request-timing/effect`, which carry it in the
  fiber. That file is the only one that imports `effect`, so an app without
  Effect never loads it. A fiber resumed by another (on a semaphore, a
  Deferred, a queue, or Effect's own scheduler) runs on that fiber's stack and
  reads its `AsyncLocalStorage`, so nothing in an Effect program reads that
  storage after the crossing. An edge that is itself an Effect program opens
  the operation and enters it with the Effect `within`; an edge that is plain
  enters it with the plain `within` and crosses with `carryOperation`.

## The interface a connector builds on

| Name                                  | What it is                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestTiming({ sink, now? })`       | switches it on; answers `{ open(): Operation }`. `now` is the clock, epoch milliseconds, for a test's virtual one                                                                                                        |
| `Operation.close(ending)`             | emits the record through the sink, once                                                                                                                                                                                  |
| `within(operation, handler)`          | runs `handler` under `operation` and answers what it answers; one per carrier (a thunk for the plain one, an Effect for the Effect one)                                                                                  |
| `inOperation`                         | whether an operation is current: `inOperation(): boolean` plain, `inOperation: Effect<boolean>` Effect; an entry connector opens nothing while it is true                                                                |
| `carryOperation(program)`             | Effect only: `program` with the plain carrier's current operation, read at the call, carried in its fiber; `program` itself when none is current                                                                         |
| `measure(kind, wait)`                 | runs `wait` unchanged and adds its duration to the current operation, or to nothing; one per carrier (`() => PromiseLike<T>` plain, an Effect for Effect)                                                                |
| `OperationName.registered(pattern)`   | the name a router registered; refuses, without quoting it, a pattern that is empty, longer than 256 UTF-16 code units, holds a space or a character that does not print, or holds a query string, a fragment or a scheme |
| `OperationName.unmatched`             | the fixed name of a request no route matched                                                                                                                                                                             |
| `methodOf(written)`                   | a request's method as a record carries it: `GET` `HEAD` `POST` `PUT` `PATCH` `DELETE` `OPTIONS`, or `OTHER`                                                                                                              |
| `RECORD_VERSION`, `WAIT_KINDS`, types | the schema version, the three kinds, and `TimingRecord`, `Ending`, `Sink`, `Clock`, `Method`, `WaitKind`, `Waited`, `Timing`, `TimingOptions`, `Operation`                                                               |

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

The plain and the Effect carrier ship built, like [the route log](route-log.md):
app code that Next.js and Vite bundle imports them, and neither strips types
under `node_modules`. `tsdown.config.ts` carries why. The conformance kit and the
command ship their source, since only Bun runs them.
