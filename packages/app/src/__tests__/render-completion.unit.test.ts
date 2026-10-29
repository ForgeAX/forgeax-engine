import { describe, expect, it } from 'vitest';
import { drainRenderCompletion, joinRenderCompletion } from '../execution/render-completion';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('Render Worker completion joins', () => {
  it('waits for the ordinary receipt without admitting its completion early', async () => {
    const receipt = deferred<undefined>();
    const joined = joinRenderCompletion(receipt.promise, undefined, undefined);
    let completed = false;
    void joined.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    receipt.resolve(undefined);
    expect(await joined).toBeUndefined();
    expect(completed).toBe(true);
  });

  it('keeps timing and snapshot boundaries in the same completion barrier', async () => {
    const receipt = deferred<undefined>(),
      timing = deferred<{ ticks: number }>(),
      snapshot = deferred<void>();
    const joined = joinRenderCompletion(receipt.promise, timing.promise, snapshot.promise);
    let completed = false;
    void joined.then(() => {
      completed = true;
    });
    receipt.resolve(undefined);
    const observed = { ticks: 7 };
    timing.resolve(observed);
    await Promise.resolve();
    expect(completed).toBe(false);
    snapshot.resolve(undefined);
    expect(await joined).toBe(observed);
  });

  it('reports observation failure immediately while teardown still drains both receipts', async () => {
    const receipt = deferred<undefined>(),
      previous = deferred<void>(),
      timing = deferred<void>();
    const joined = joinRenderCompletion(receipt.promise, timing.promise, undefined);
    const rejection = expect(joined).rejects.toThrow('timing failed');
    timing.reject(new Error('timing failed'));
    await rejection;
    const drained = drainRenderCompletion(receipt.promise, previous.promise, false);
    let retired = false;
    void drained.then(() => {
      retired = true;
    });
    previous.resolve(undefined);
    await Promise.resolve();
    expect(retired).toBe(false);
    receipt.resolve(undefined);
    await drained;
    expect(retired).toBe(true);
  });

  it.each([
    false,
    true,
  ])('drains failed receipt settlement with prefix proven %s', async (previousSettled) => {
    const receipt = deferred<void>(),
      previous = deferred<void>();
    if (previousSettled) previous.resolve(undefined);
    const drained = drainRenderCompletion(receipt.promise, previous.promise, previousSettled);
    let retired = false;
    void drained.then(() => {
      retired = true;
    });
    receipt.reject(new Error('receipt failed'));
    if (!previousSettled) {
      await Promise.resolve();
      expect(retired).toBe(false);
      previous.resolve(undefined);
    }
    await drained;
    expect(retired).toBe(true);
  });
});
