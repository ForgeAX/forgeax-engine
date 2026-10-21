import type { Worker } from 'node:worker_threads';
import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { formatFailure } from './errors.js';

/** Own one result, deadline and complete retirement for a short-lived format Worker. */
export async function runMeshWorker<T>(
  worker: Worker,
  field: string,
  timeoutMessage: string,
  timeoutMs = 30_000,
): Promise<Result<T, AssetError>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Result<T, AssetError>>((resolve) => {
      timer = setTimeout(() => resolve(formatFailure(field, timeoutMessage)), timeoutMs);
      worker.once('message', (value: T) => resolve(ok(value)));
      worker.once('error', (error) => resolve(formatFailure(field, error.message)));
      worker.once('exit', (code) =>
        resolve(formatFailure(field, `worker exited with ${code} before producing a result`)),
      );
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    worker.removeAllListeners();
  }
}
