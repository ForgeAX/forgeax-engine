import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';

/** Normalize a bootstrap module before any realm probing or worker startup. */
export function normalizeExecutionBootstrapUrl(
  bootstrap: string | URL,
): Result<string, AppErrorType> {
  const moduleUrl = typeof bootstrap === 'string' ? bootstrap : bootstrap.href;
  try {
    return ok(new URL(bootstrap, globalThis.location?.href).href);
  } catch (cause) {
    return err(
      new AppError({
        code: 'app-execution-bootstrap-failed',
        expected: APP_EXPECTED['app-execution-bootstrap-failed'],
        hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
        detail: {
          phase: 'prepare',
          moduleUrl,
          cause: cause instanceof TypeError ? cause : new TypeError(String(cause)),
        },
      }),
    );
  }
}
