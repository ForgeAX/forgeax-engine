import { afterEach, expect, it, vi } from 'vitest';
import { workerError } from '../execution/worker-error';
import { shutdownWorker } from '../execution/worker-shutdown';

class CleanupWorker extends EventTarget {
  terminate = vi.fn();
  postMessage = vi.fn();
  complete(error?: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'disposed', ...(error === undefined ? {} : { error }) },
      }),
    );
  }
}
afterEach(() => vi.useRealTimers());
it('waits for cleanup acknowledgment before terminating', async () => {
  const worker = new CleanupWorker();
  const result = shutdownWorker(worker as unknown as Worker);
  expect(worker.postMessage).toHaveBeenCalledWith({ kind: 'dispose' });
  await Promise.resolve();
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.complete();
  expect((await result).ok).toBe(true);
  worker.complete();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it('reports cleanup timeout separately from successful disposal and forces termination', async () => {
  vi.useFakeTimers();
  const worker = new CleanupWorker();
  const result = shutdownWorker(worker as unknown as Worker, 50);
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({
    ok: false,
    error: { code: 'app-execution-deadline-exceeded', detail: { phase: 'dispose', timeoutMs: 50 } },
  });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it('preserves structured producer guidance through structured clone', () => {
  const cause = Object.assign(new Error('fixture'), {
    code: 'producer-invalid',
    expected: 'valid input',
    hint: 'repair producer',
    detail: { id: 7, cause: new Error('nested') },
  });
  expect(structuredClone(workerError(cause))).toMatchObject({
    code: 'producer-invalid',
    expected: 'valid input',
    hint: 'repair producer',
    detail: { id: 7, cause: { message: 'nested' } },
  });
});
