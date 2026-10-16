import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';

/** Normal shutdown waits for realm cleanup. Termination is always the final step. */
export function shutdownWorker(worker: Worker, timeoutMs = 5_000): Promise<Result<void, AppError>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Result<void, AppError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.removeEventListener('message', receive);
      worker.terminate();
      resolve(result);
    };
    const failed = (cause: unknown): Result<void, AppError> =>
      err(
        new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: { cause },
        }),
      );
    const receive = (event: MessageEvent<{ kind: string; error?: unknown }>) => {
      if (event.data.kind !== 'disposed') return;
      const error = event.data.error as
        | { code?: string; detail?: { phase?: string; timeoutMs?: number } }
        | undefined;
      if (
        error?.code === 'app-execution-deadline-exceeded' &&
        error.detail?.phase === 'dispose' &&
        typeof error.detail.timeoutMs === 'number'
      ) {
        finish(
          err(
            new AppError({
              code: 'app-execution-deadline-exceeded',
              expected: APP_EXPECTED['app-execution-deadline-exceeded'],
              hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
              detail: { phase: 'dispose', timeoutMs: error.detail.timeoutMs },
            }),
          ),
        );
      } else finish(error === undefined ? ok(undefined) : failed(error));
    };
    const deadline = setTimeout(
      () =>
        finish(
          err(
            new AppError({
              code: 'app-execution-deadline-exceeded',
              expected: APP_EXPECTED['app-execution-deadline-exceeded'],
              hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
              detail: { phase: 'dispose', timeoutMs },
            }),
          ),
        ),
      timeoutMs,
    );
    worker.addEventListener('message', receive);
    try {
      worker.postMessage({ kind: 'dispose' });
    } catch (cause) {
      finish(failed(cause));
    }
  });
}
