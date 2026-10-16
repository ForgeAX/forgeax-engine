import { platformError } from './errors.js';

/** Attempt every native release, preserving all failures in one structured error. */
export function releasePlatformResources(releases: Iterable<() => void>): void {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      release();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length !== 0) {
    throw platformError('platform-operation-failed', {
      operation: 'release',
      cause: new AggregateError(failures, 'Native platform cleanup failed'),
    }).error;
  }
}
