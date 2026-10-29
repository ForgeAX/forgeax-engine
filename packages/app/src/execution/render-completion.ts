/** Optional observations join the receipt; ordinary frames borrow its existing promise. */
export function joinRenderCompletion<T>(
  completion: Promise<undefined>,
  timing: Promise<T> | undefined,
  snapshotBoundary: Promise<unknown> | undefined,
): Promise<T | undefined> {
  if (timing === undefined && snapshotBoundary === undefined) return completion;
  return Promise.all([completion, timing, snapshotBoundary]).then((values) => values[1]);
}

const discardSettlement = (): undefined => undefined;

/** A proven completed prefix needs no second all-settled array or per-result records. */
export function drainRenderCompletion(
  completed: Promise<unknown>,
  previous: Promise<void>,
  previousSettled: boolean,
): Promise<unknown> {
  if (previousSettled) return completed.then(discardSettlement, discardSettlement);
  return Promise.allSettled([previous, completed]);
}
