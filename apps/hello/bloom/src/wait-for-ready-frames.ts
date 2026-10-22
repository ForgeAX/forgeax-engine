import type { Renderer } from '@forgeax/engine/render';

export function waitForReadyFrames(
  renderer: Pick<Renderer, 'inspect' | 'subscribe'>,
  count: number,
  timeoutMs = 30_000,
): Promise<number> {
  if (!Number.isInteger(count) || count < 1) {
    return Promise.reject(new RangeError('ready frame count must be a positive integer'));
  }
  const generation = renderer.inspect().frame.deviceGeneration;
  return new Promise((resolve, reject) => {
    let completed = 0;
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve(completed);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Bloom completed ${completed}/${count} ready frames within ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      unsubscribe = renderer.subscribe((event) => {
        if (event.kind !== 'frame-submitted') return;
        if (event.deviceGeneration !== generation) {
          finish(new Error('Bloom device generation changed while waiting for ready frames'));
          return;
        }
        void event.receipt.completed.then(
          (result) => {
            if (settled) return;
            if (!result.ok) {
              finish(
                new Error(`Bloom frame completion failed: ${result.error.code}`, {
                  cause: result.error,
                }),
              );
              return;
            }
            if (renderer.inspect().frame.deviceGeneration !== generation) {
              finish(new Error('Bloom device generation changed before frame completion'));
              return;
            }
            if (event.receipt.presentation === 'ready' && ++completed === count) finish();
          },
          (error) => finish(new Error('Bloom frame completion rejected', { cause: error })),
        );
      });
    } catch (error) {
      finish(new Error('Bloom frame subscription failed', { cause: error }));
    }
  });
}
