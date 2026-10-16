/** Bound host-controlled work even when an injected callback ignores cancellation. */
export async function beforeDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  timeout: () => unknown,
): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw new RangeError('Host deadline must be positive finite milliseconds');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout()), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
