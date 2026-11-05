import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCombinedSignal } from '../abort.js';

afterEach(() => vi.restoreAllMocks());

describe('operation-scoped combined cancellation', () => {
  it('preserves results without native AbortSignal.any', async () => {
    const nativeAny = vi.spyOn(AbortSignal, 'any').mockImplementation(() => {
      throw new Error('AbortSignal.any is unavailable');
    });
    expect(await withCombinedSignal([], (signal) => !signal.aborted)).toBe(true);
    expect(nativeAny).not.toHaveBeenCalled();
  });

  it.each([
    0, 1,
  ])('forwards cancellation from input %s without cancelling its siblings', async (index) => {
    const inputs = [new AbortController(), new AbortController()];
    const reason = new Error('owner retired');
    await withCombinedSignal(
      inputs.map((input) => input.signal),
      (signal) => {
        const listener = vi.fn();
        signal.addEventListener('abort', listener);
        inputs[index]?.abort(reason);
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe(reason);
        expect(inputs[1 - index]?.signal.aborted).toBe(false);
        inputs[1 - index]?.abort('later');
        expect(signal.reason).toBe(reason);
        expect(listener).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('chooses the first already-aborted input in list order and installs no listeners', async () => {
    const first = new AbortController();
    const second = new AbortController();
    second.abort('second');
    first.abort('first');
    const add = vi.spyOn(first.signal, 'addEventListener');
    await withCombinedSignal([first.signal, second.signal], (signal) => {
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe('first');
    });
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    'success',
    'throw',
    'reject',
    'abort',
  ] as const)('releases duplicate input listeners on %s', async (outcome) => {
    const input = new AbortController();
    const add = vi.spyOn(input.signal, 'addEventListener');
    const remove = vi.spyOn(input.signal, 'removeEventListener');
    const reason = new Error('operation failed');
    let combined: AbortSignal | undefined;
    const operation = withCombinedSignal([input.signal, input.signal], (signal) => {
      combined = signal;
      if (outcome === 'throw') throw reason;
      if (outcome === 'reject') return Promise.reject(reason);
      if (outcome === 'abort') {
        input.abort(reason);
        expect(remove).toHaveBeenCalledTimes(1);
      }
      return 42;
    });
    if (outcome === 'throw' || outcome === 'reject') await expect(operation).rejects.toBe(reason);
    else await expect(operation).resolves.toBe(42);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]?.[1]);
    input.abort('after completion');
    expect(combined?.aborted).toBe(outcome === 'abort');
  });

  it('keeps subscriptions until the asynchronous operation settles', async () => {
    const input = new AbortController();
    const remove = vi.spyOn(input.signal, 'removeEventListener');
    let finish!: () => void;
    const operation = withCombinedSignal(
      [input.signal],
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(remove).not.toHaveBeenCalled();
    finish();
    await operation;
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
