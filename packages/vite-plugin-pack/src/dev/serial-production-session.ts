import { createPluginPackFailure } from '../errors.js';
import type { ProductionRunResult, ProductionSession } from '../production/session.js';

/** Dev file events and explicit imports share one producer. They must not
 * supersede each other's generation while publishing the same source graph. */
export function serialProductionSession<T>(source: ProductionSession<T>): ProductionSession<T> {
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<ProductionRunResult>): Promise<ProductionRunResult> => {
    const result = pending.then(() => {
      if (source.signal.aborted) {
        throw createPluginPackFailure({
          code: 'cleanup-failed',
          expected: 'the dev production session to accept work before close',
          hint: 'retry against the active dev session',
          detail: { stage: 'cleanup', subject: 'production-session' },
        });
      }
      return work();
    });
    pending = result.catch(() => undefined);
    return result;
  };
  return {
    get runtimeGeneration() {
      return source.runtimeGeneration;
    },
    get signal() {
      return source.signal;
    },
    acceptedState: () => source.acceptedState(),
    start: () => enqueue(() => source.start()),
    rebuild: (changes) => enqueue(() => source.rebuild(changes)),
    materialize: (guid) => enqueue(() => source.materialize(guid)),
    async close() {
      // Cancel active production immediately; queued work observes the closed
      // producer rather than starting another filesystem/network operation.
      await source.close();
      await pending;
    },
  };
}
