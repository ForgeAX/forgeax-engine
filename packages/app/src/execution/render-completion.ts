const discardSettlement = (): undefined => undefined;

/**
 * Credit joins GPU completion and any snapshot boundary only; timing readback
 * travels separately so it never delays the next admission.
 */
export function joinRenderCompletion(
  completion: Promise<undefined>,
  snapshotBoundary: Promise<unknown> | undefined,
): Promise<undefined> {
  if (snapshotBoundary === undefined) return completion;
  return Promise.all([completion, snapshotBoundary]).then(discardSettlement);
}

/**
 * Retirement drains this receipt and its predecessor's retirement, whatever
 * their outcome, and yields this receipt's settled value when it has one.
 */
export async function drainRenderCompletion<T>(
  completed: Promise<T>,
  previous: Promise<void>,
): Promise<T | undefined> {
  const [, own] = await Promise.allSettled([previous, completed]);
  return own.status === 'fulfilled' ? own.value : undefined;
}
