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
    const joined = joinRenderCompletion(receipt.promise, undefined);
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

  it('keeps the snapshot boundary in the completion barrier', async () => {
    const receipt = deferred<undefined>(),
      snapshot = deferred<void>();
    const joined = joinRenderCompletion(receipt.promise, snapshot.promise);
    let completed = false;
    void joined.then(() => {
      completed = true;
    });
    receipt.resolve(undefined);
    await Promise.resolve();
    expect(completed).toBe(false);
    snapshot.resolve(undefined);
    expect(await joined).toBeUndefined();
  });

  it('reports boundary failure immediately while teardown still drains both receipts', async () => {
    const receipt = deferred<undefined>(),
      previous = deferred<void>(),
      snapshot = deferred<void>();
    const joined = joinRenderCompletion(receipt.promise, snapshot.promise);
    const rejection = expect(joined).rejects.toThrow('snapshot failed');
    snapshot.reject(new Error('snapshot failed'));
    await rejection;
    const drained = drainRenderCompletion(receipt.promise, previous.promise);
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

  it('drains failed receipt settlement after its predecessor retires', async () => {
    const receipt = deferred<void>(),
      previous = deferred<void>();
    const drained = drainRenderCompletion(receipt.promise, previous.promise);
    let retired = false;
    void drained.then(() => {
      retired = true;
    });
    receipt.reject(new Error('receipt failed'));
    await Promise.resolve();
    expect(retired).toBe(false);
    previous.resolve(undefined);
    await drained;
    expect(retired).toBe(true);
  });
});
