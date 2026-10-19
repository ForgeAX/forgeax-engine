import { ok, type Result } from '@forgeax/engine-types';
import { type PlatformError, platformError } from './errors.js';
import type { PlatformEvent, PlatformRelease } from './index.js';
import { releasePlatformResources } from './release.js';

/** Own the lifetime shared by native Platform bindings. */
export function createPlatformLifecycle() {
  let disposed = false;
  const frames = new Set<PlatformRelease>();
  const nativeReleases: PlatformRelease[] = [];
  const listeners = new Set<(event: PlatformEvent) => void>();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    releasePlatformResources([...frames, ...nativeReleases.splice(0).reverse()]);
  };

  return {
    /** Record each release before acquisition so partial native failure can roll back. */
    bind(subscribe: (releases: PlatformRelease[]) => void): Result<void, PlatformError> {
      if (disposed) return platformError('platform-disposed', { operation: 'subscribe' });
      try {
        subscribe(nativeReleases);
        return ok(undefined);
      } catch (cause) {
        let cleanupCause: unknown;
        try {
          dispose();
        } catch (failure) {
          cleanupCause = failure;
        }
        return platformError('platform-operation-failed', {
          operation: 'subscribe',
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
        });
      }
    },
    get disposed(): boolean {
      return disposed;
    },
    emit(event: PlatformEvent): void {
      if (disposed) return;
      const failures: unknown[] = [];
      for (const listener of [...listeners]) {
        if (disposed || !listeners.has(listener)) continue;
        try {
          listener(event);
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Platform event listener failed');
    },
    subscribe(listener: (event: PlatformEvent) => void): Result<PlatformRelease, PlatformError> {
      if (disposed) return platformError('platform-disposed', { operation: 'subscribe' });
      const subscription = (event: PlatformEvent) => listener(event);
      listeners.add(subscription);
      return ok(() => {
        listeners.delete(subscription);
      });
    },
    requestFrame(
      schedule: (callback: () => void) => PlatformRelease,
      callback: () => void,
    ): Result<PlatformRelease, PlatformError> {
      if (disposed) return platformError('platform-disposed', { operation: 'requestFrame' });
      let live = true;
      let cancel: PlatformRelease;
      let requesting = true;
      let synchronous = false;
      const release = () => {
        if (!live) return;
        live = false;
        frames.delete(release);
        releasePlatformResources([cancel]);
      };
      try {
        cancel = schedule(() => {
          if (requesting) {
            synchronous = true;
            return;
          }
          if (!live || disposed) return;
          live = false;
          frames.delete(release);
          callback();
        });
        requesting = false;
        if (synchronous) {
          release();
          throw new Error('Native requestAnimationFrame must invoke asynchronously');
        }
      } catch (cause) {
        live = false;
        return platformError('platform-operation-failed', { operation: 'requestFrame', cause });
      }
      frames.add(release);
      return ok(release);
    },
    dispose,
  };
}
