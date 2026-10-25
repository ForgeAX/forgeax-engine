/**
 * Shared implementation of the optional `RhiQueue.holdCompletions` contract.
 *
 * `deliver` wraps a backend completion promise: while any hold is open, a
 * completion that arrives stays pending until the last hold is released.
 * Promises that complete during one hold settle in their arrival order, so
 * the queue's FIFO completion order is preserved.
 */
export interface QueueCompletionHold {
  deliver<T>(completion: Promise<T>): Promise<T>;
  hold(): () => void;
}

export function createQueueCompletionHold(): QueueCompletionHold {
  let holds = 0;
  let released: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  return {
    deliver: (completion) =>
      completion.then((value) => {
        if (holds === 0) return value;
        if (released === undefined) {
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => {
            resolve = settle;
          });
          released = { promise, resolve };
        }
        return released.promise.then(() => value);
      }),
    hold: () => {
      holds++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        holds--;
        if (holds > 0 || released === undefined) return;
        const settle = released.resolve;
        released = undefined;
        settle();
      };
    },
  };
}
