/**
 * Request timing: which operation a wait belongs to, carried in
 * `AsyncLocalStorage`, in plain async code and in an Effect program alike.
 * `docs/exports/request-timing.md` is how an app adopts it, and
 * `request-timing-conformance-effect.ts` says why an Effect program needs
 * nothing more.
 */
import { beginWait, current, type Operation, type WaitKind } from "./request-timing-operation.ts";

export {
  methodOf,
  OperationName,
  RECORD_VERSION,
  requestTiming,
  WAIT_KINDS,
} from "./request-timing-operation.ts";
export type {
  Clock,
  Ending,
  Fault,
  Method,
  Operation,
  Sink,
  Timing,
  TimingOptions,
  TimingRecord,
  WaitKind,
  Waited,
} from "./request-timing-operation.ts";

/**
 * Whether an operation is current. An entry connector asks it before opening
 * one and opens nothing when it answers true, so work a page runs in-process
 * during its own request, such as a server function it calls, counts in the
 * page's operation and operations never nest.
 */
export function inOperation(): boolean {
  return current.getStore() !== undefined;
}

/**
 * Runs `handler` with `operation` as the current one, and answers what it
 * answers, unchanged. Every `measure` called from it, or from anything it
 * starts that keeps its async context, counts in `operation`.
 */
export function within<T>(operation: Operation, handler: () => T): T {
  return current.run(operation, handler);
}

/**
 * Runs `wait` and adds its duration to the current operation under `kind`, or
 * to nothing when no operation is current. The operation is read when
 * `measure` is called, so a wait belongs to the operation that issued it
 * whoever settles it. The answer settles as `wait`'s promise does, with its
 * value or its rejection, and a synchronous throw is thrown on. `wait` is
 * called once, and a thenable it answers has its `then` called once.
 */
export function measure<T>(kind: WaitKind, wait: () => PromiseLike<T>): Promise<T> {
  const operation = current.getStore();
  if (operation === undefined) return Promise.resolve(wait());
  const end = beginWait(operation, kind);
  let pending: PromiseLike<T>;
  try {
    pending = wait();
  } catch (error) {
    end();
    throw error;
  }
  return Promise.resolve(pending).then(
    (value) => {
      end();
      return value;
    },
    (error: unknown) => {
      end();
      throw error;
    },
  );
}
