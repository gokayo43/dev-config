/**
 * A latch a handler waits on midway, so a case can leave while the handler is
 * provably waiting and then let it finish. One handler at a time.
 */
let reached = Promise.withResolvers<void>();
let opened = Promise.withResolvers<void>();
let finished = Promise.withResolvers<void>();

export const held = {
  /** What a handler awaits midway. */
  wait: () => {
    reached.resolve();
    return opened.promise;
  },
  /** Called by the handler once it has done everything after the wait. */
  done: () => finished.resolve(),
  /** Resolves once a handler is waiting. */
  reached: () => reached.promise,
  /** Lets the waiting handler on, and resolves once it has finished. */
  open: async () => {
    const waiting = finished;
    opened.resolve();
    await waiting.promise;
    reached = Promise.withResolvers<void>();
    opened = Promise.withResolvers<void>();
    finished = Promise.withResolvers<void>();
  },
};
