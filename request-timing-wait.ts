/**
 * What every wait connector is built from: a client the app already made,
 * answered as itself with some of its members standing in for theirs, and the
 * one way a call of it is measured. No export names this file; the connectors'
 * builds share it as a chunk.
 */
import { must } from "./narrowing.ts";
import { measure, type WaitKind } from "./request-timing.ts";

const handled = (): undefined => undefined;

/**
 * Calls `send` as a wait of `kind` for the current operation, and answers the
 * very promise `send` answered, so the app awaits the driver's own promise with
 * no turn added. `measure` is handed that same promise and ends the wait on it
 * before the app can resume on it, so a wait is ended before the code after it
 * runs. `measure`'s own copy carries nothing the answer does not, and its
 * rejection is the answer's, which reaches the app there.
 */
export function waitOn<T extends PromiseLike<unknown>>(kind: WaitKind, send: () => T): T {
  let answer: T | undefined;
  measure(kind, () => {
    answer = send();
    return answer;
  }).then(undefined, handled);
  // `measure` calls its wait once and synchronously, so `answer` is set here.
  return must(answer);
}

/**
 * `client`, with each member `standIns` names read from there instead, and
 * every other member the client's own. The answer is a Proxy, so the app and
 * its ORM see the same type, prototype, `instanceof`, events and fields. The
 * client's own fields and accessors are read and written on the client itself,
 * since a native client's accessors refuse any other `this`; a method the app
 * calls on the answer runs with the answer as `this`, so a method of the
 * client that calls another member reaches its stand-in.
 */
export function standingIn<T extends object>(
  client: T,
  standIns: ReadonlyMap<PropertyKey, unknown>,
): T {
  return new Proxy(client, {
    get: (target, key) =>
      standIns.has(key)
        ? standIns.get(key)
        : // oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy's own member is whatever key the app reads, which no typed access can name; the stand-ins are the typed half
          Reflect.get(target, key),
    set: (target, key, value) => Reflect.set(target, key, value),
  });
}
