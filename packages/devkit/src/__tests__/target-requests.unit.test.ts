import { expect, it, vi } from 'vitest';
import { TargetRequests } from '../target-requests.js';

it('retires a request once and ignores completion on a displaced request handle', async () => {
  const requests = new TargetRequests<number, { target: string }>();
  const first = requests.open(1, { target: 'page-a' }, undefined);
  const previous = requests.get(1);
  previous?.reject(new Error('page replaced'));
  await expect(first).rejects.toThrow('page replaced');

  const second = requests.open(1, { target: 'page-b' }, undefined);
  previous?.resolve('late result');
  expect(requests.size).toBe(1);
  requests.get(1)?.resolve('accepted result');
  await expect(second).resolves.toBe('accepted result');
  expect(requests.size).toBe(0);
});

it('releases the timeout and sends one cancellation when the caller aborts', async () => {
  vi.useFakeTimers();
  try {
    const requests = new TargetRequests<number, object>();
    const controller = new AbortController();
    const cancel = vi.fn();
    const promise = requests.open(
      1,
      {},
      { ms: 20, error: () => new Error('timeout') },
      controller.signal,
      cancel,
    );

    controller.abort(new Error('cancelled'));
    await expect(promise).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(20);
    expect(requests.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
