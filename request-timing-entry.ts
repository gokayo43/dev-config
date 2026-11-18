/**
 * What every entry connector is built from: the one place an operation closes,
 * on the first of its endings to arrive, the client's abort among them; the
 * one way a request is served as an operation; the one way a router's
 * patterns become names; and a response body passed through to the client
 * unchanged, watched for the moment it has finished. No export names this
 * file; the connectors' builds share it as a chunk.
 */
import type { Operation } from "./request-timing-operation.ts";
import {
  inOperation,
  type Method,
  methodOf,
  OperationName,
  type Timing,
  within,
} from "./request-timing.ts";

/** How a response ended, short of its name and method. */
export interface Ended {
  readonly status: number;
  readonly aborted: boolean;
  readonly streamed: boolean;
}

/**
 * A router's patterns as names, each registered once, when it is first asked
 * for, and remembered.
 */
export function registeredNames(): (pattern: string) => OperationName {
  const names = new Map<string, OperationName>();
  return (pattern) => {
    const known = names.get(pattern);
    if (known !== undefined) return known;
    const name = OperationName.registered(pattern);
    names.set(pattern, name);
    return name;
  };
}

/**
 * The endings of `operation`: the answer is called on every ending a
 * connector sees, and the first closes the operation through `timing.finish`,
 * which builds the name with `named` inside its guard. So a name or a status
 * the core refuses, and a sink that throws, reach the app's `fault`, write no
 * record, and never fail the response. The client's abort, read from `signal`,
 * is an ending, `aborting`'s; a signal already aborted when the listener would
 * be attached, as by a client gone while the framework was still reading the
 * request, never fires again, so it ends the operation at once.
 */
export function endings(
  timing: Timing,
  operation: Operation,
  method: Method,
  named: () => OperationName,
  signal: AbortSignal | undefined,
  aborting: () => Ended,
): (ended: Ended) => void {
  let open = true;
  const end = (ended: Ended): void => {
    if (!open) return;
    open = false;
    timing.finish(operation, () => ({ method, name: named(), ...ended }));
  };
  if (signal?.aborted === true) end(aborting());
  else signal?.addEventListener("abort", () => end(aborting()), { once: true });
  return end;
}

/** How a watched body finished: cancelled by its reader, read to its end, or neither, as a source that failed. */
export interface BodyEnded {
  readonly aborted: boolean;
  readonly finished: boolean;
  /** How many chunks the reader had taken. */
  readonly chunks: number;
}

/**
 * `body`, passed through chunk for chunk, calling `ended` once the last chunk
 * has been taken, the source has failed, or the reader has cancelled, with how
 * many chunks were taken; `chunks` reads that count while the body is read. A
 * high-water mark of nothing reads no chunk ahead of the reader, so the source
 * is pulled exactly as it was before the connector stood in front of it, and
 * still in the context it was made in, the handler's. A source that fails
 * fails the copy with its own error, so the client sees the failure it saw
 * before.
 */
export function watched<Chunk>(body: ReadableStream<Chunk>, ended: (how: BodyEnded) => void) {
  const reader = body.getReader();
  let chunks = 0;
  const stream = new ReadableStream<Chunk>(
    {
      pull: (controller) =>
        reader.read().then(
          (chunk) => {
            if (chunk.done) {
              controller.close();
              return ended({ aborted: false, finished: true, chunks });
            }
            chunks += 1;
            return controller.enqueue(chunk.value);
          },
          (error: unknown) => {
            ended({ aborted: false, finished: false, chunks });
            throw error;
          },
        ),
      cancel: (reason) => {
        ended({ aborted: true, finished: false, chunks });
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, chunks: () => chunks };
}

/**
 * What a connector makes of the response its handler answered: closed as it
 * is handed over, with the ending given, or passed on with `body` watched, its
 * status the response's and `streamed` saying, from how the body ended or how
 * far it had been read, whether it was sent over time.
 */
export type Answered =
  | { readonly close: Ended }
  | {
      readonly watch: ReadableStream<Uint8Array>;
      readonly streamed: (how: Pick<BodyEnded, "finished" | "chunks">) => boolean;
    };

/**
 * Serves `request` with `handle` as one operation of `timing`, and answers
 * what `handle` answered, its body watched where `answer` says so. Opens none
 * where an operation is current: a request served in-process is part of it.
 *
 * `naming` is handed the operation once it is open and answers how it is
 * named at the close. The operation closes once, on the first of: the
 * response handed over or its body finished, as `answer` decides; the client's
 * abort, with the status of a response being sent, or 499 where there was
 * none; a handler that throws, with 500, which is Bun's answer to a fetch that
 * throws, the error thrown on. `answer` is handed the response's headers
 * copied before its body is read, since Bun drops a content type it derived
 * from a buffered body, a typed Blob's or form data's, once that body is read
 * as a stream; a watched body goes out with that copy.
 */
export function timedEntry(
  timing: Timing,
  request: Request,
  handle: () => Response | Promise<Response>,
  naming: (operation: Operation) => () => OperationName,
  answer: (response: Response, headers: Headers) => Answered,
): Promise<Response> {
  if (inOperation()) return Promise.resolve(handle());
  const operation = timing.open();
  let sending: { readonly status: number; readonly streamed: () => boolean } | undefined;
  const end = endings(
    timing,
    operation,
    methodOf(request.method),
    naming(operation),
    request.signal,
    () => ({
      status: sending?.status ?? 499,
      aborted: true,
      streamed: sending?.streamed() ?? false,
    }),
  );
  const answered = new Promise<Response>((resolve) => resolve(within(operation, handle)));
  return answered.then(
    (response) => {
      const headers = new Headers(response.headers);
      const how = answer(response, headers);
      if ("close" in how) {
        end(how.close);
        return response;
      }
      const { status, statusText } = response;
      const body = watched(how.watch, ({ aborted, finished, chunks }) =>
        end({ status, aborted, streamed: how.streamed({ finished, chunks }) }),
      );
      sending = {
        status,
        streamed: () => how.streamed({ finished: false, chunks: body.chunks() }),
      };
      return new Response(body.stream, { status, statusText, headers });
    },
    (error: unknown) => {
      end({ status: 500, aborted: false, streamed: false });
      throw error;
    },
  );
}
