/**
 * What every entry connector is built from: the one place an operation closes,
 * on the first of its endings to arrive, the client's abort among them, and a
 * response body passed through to the client unchanged, watched for the moment
 * it has finished. No export names this file; the connectors' builds share it
 * as a chunk.
 */
import type { Operation } from "./request-timing-operation.ts";
import { methodOf, type OperationName } from "./request-timing.ts";

/** How a response ended, short of its name and method, which the request carries. */
export interface Ended {
  readonly status: number;
  readonly aborted: boolean;
  readonly streamed: boolean;
}

/**
 * The endings of `operation`, which serves `request`: `end` is called on every
 * ending a connector sees, and the first to arrive closes the operation, named
 * by `named` then. The client's abort is one, with `aborted: true` and the
 * status of the response `produced` was last handed, or 499 where there was
 * none. A sink that throws rejects out of band of the response it measured,
 * which the client has already been answered with.
 */
export function endings(
  operation: Operation,
  request: Request,
  named: () => OperationName,
  isStreamed: (response: Response) => boolean,
) {
  const { promise: ending, resolve: end } = Promise.withResolvers<Ended>();
  void ending.then((ended) => {
    operation.close({ method: methodOf(request.method), name: named(), ...ended });
  });
  let last: Response | undefined;
  request.signal.addEventListener(
    "abort",
    () =>
      end({
        status: last?.status ?? 499,
        aborted: true,
        streamed: last !== undefined && isStreamed(last),
      }),
    { once: true },
  );
  return {
    end,
    /** Hands over the response the handler produced, whose status an abort after it records. */
    produced: (response: Response): void => {
      last = response;
    },
  };
}

/**
 * `body`, passed through chunk for chunk, calling `ended` once the last chunk
 * has been taken or the client has cancelled it, with `true` for a cancel. A
 * high-water mark of nothing reads no chunk ahead of the client, so the source
 * is pulled exactly as it was before the connector stood in front of it. A
 * source that fails midway has finished too, with `false`, and fails the copy
 * with its own error, so the client sees the failure it saw before.
 */
export function watched<Chunk>(
  body: ReadableStream<Chunk>,
  ended: (aborted: boolean) => void,
): ReadableStream<Chunk> {
  const reader = body.getReader();
  return new ReadableStream<Chunk>(
    {
      pull: (controller) =>
        reader.read().then(
          (chunk) => {
            if (!chunk.done) return controller.enqueue(chunk.value);
            controller.close();
            return ended(false);
          },
          (error: unknown) => {
            ended(false);
            throw error;
          },
        ),
      cancel: (reason) => {
        ended(true);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
