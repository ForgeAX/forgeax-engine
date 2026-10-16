import {
  createPlatformClock,
  type DisplayFacts,
  type Platform,
  type PlatformError,
  type PlatformEvent,
  type PlatformRelease,
  platformError,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import { ok, type Result } from '@forgeax/engine-types';

export interface BrowserPlatform extends Platform {
  readonly canvas: HTMLCanvasElement;
}

/** Bind the canvas's actual Window, including when it belongs to an iframe. */
export function createBrowserPlatform(
  canvas: HTMLCanvasElement,
): Result<BrowserPlatform, PlatformError> {
  const document = canvas.ownerDocument;
  const view = document?.defaultView;
  if (view === null || view === undefined || !canvas.isConnected) {
    return platformError('platform-unavailable', { operation: 'connected canvas Window' });
  }
  if (
    typeof view.performance?.now !== 'function' ||
    typeof view.requestAnimationFrame !== 'function' ||
    typeof view.cancelAnimationFrame !== 'function'
  ) {
    return platformError('platform-unavailable', { operation: 'clock and frame scheduling' });
  }

  const window = view;
  const clock = createPlatformClock(() => view.performance.now(), 'milliseconds');
  const initialClock = clock.now();
  if (!initialClock.ok) return initialClock;
  const releases = new Set<PlatformRelease>();
  let disposed = false;
  let pageVisible = true;
  const listeners = new Set<(event: PlatformEvent) => void>();

  function display(): Result<DisplayFacts, PlatformError> {
    if (disposed) return platformError('platform-disposed', { operation: 'display' });
    if (!canvas.isConnected) {
      return platformError('platform-unavailable', { operation: 'connected canvas display' });
    }
    try {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const pixelRatio = window.devicePixelRatio;
      if (
        !Number.isFinite(width) ||
        width < 0 ||
        !Number.isFinite(height) ||
        height < 0 ||
        !Number.isFinite(pixelRatio) ||
        pixelRatio <= 0 ||
        !Number.isSafeInteger(canvas.width) ||
        canvas.width < 0 ||
        !Number.isSafeInteger(canvas.height) ||
        canvas.height < 0
      ) {
        return platformError('platform-display-invalid', { cause: { width, height, pixelRatio } });
      }
      return ok({
        width,
        height,
        pixelRatio,
        safeArea: readSafeArea(),
        drawingWidth: canvas.width,
        drawingHeight: canvas.height,
      });
    } catch (cause) {
      return platformError('platform-operation-failed', { operation: 'display', cause });
    }
  }

  function readSafeArea(): DisplayFacts['safeArea'] {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;inset:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.documentElement.append(probe);
    try {
      const style = window.getComputedStyle(probe);
      const rect = canvas.getBoundingClientRect();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const scaleX = rect.width > 0 ? width / rect.width : 0;
      const scaleY = rect.height > 0 ? height / rect.height : 0;
      const bound = (value: number, max: number) => Math.min(max, Math.max(0, value));
      const x = bound((Number.parseFloat(style.paddingLeft) - rect.left) * scaleX, width);
      const y = bound((Number.parseFloat(style.paddingTop) - rect.top) * scaleY, height);
      const right = bound(
        (window.innerWidth - Number.parseFloat(style.paddingRight) - rect.left) * scaleX,
        width,
      );
      const bottom = bound(
        (window.innerHeight - Number.parseFloat(style.paddingBottom) - rect.top) * scaleY,
        height,
      );
      return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    } finally {
      probe.remove();
    }
  }

  const initialDisplay = display();
  if (!initialDisplay.ok) return initialDisplay;

  function emit(event: PlatformEvent): void {
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
  }
  const visibility = () =>
    emit({ kind: 'visibility', visible: pageVisible && document.visibilityState !== 'hidden' });
  const resize = () => {
    const facts = display();
    if (facts.ok) emit({ kind: 'display', display: facts.value });
    else emit({ kind: 'surface-lost', cause: facts.error });
  };
  const pagehide = () => {
    pageVisible = false;
    visibility();
  };
  const pageshow = () => {
    pageVisible = true;
    visibility();
  };
  const nativeReleases: PlatformRelease[] = [];
  try {
    nativeReleases.push(() => document.removeEventListener('visibilitychange', visibility));
    document.addEventListener('visibilitychange', visibility);
    nativeReleases.push(() => view.removeEventListener('resize', resize));
    view.addEventListener('resize', resize);
    nativeReleases.push(() => view.removeEventListener('pagehide', pagehide));
    view.addEventListener('pagehide', pagehide);
    nativeReleases.push(() => view.removeEventListener('pageshow', pageshow));
    view.addEventListener('pageshow', pageshow);
    const ResizeObserverClass = (view as Window & { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    if (ResizeObserverClass !== undefined) {
      const observer = new ResizeObserverClass(resize);
      nativeReleases.push(() => observer.disconnect());
      observer.observe(canvas);
    }
  } catch (cause) {
    disposed = true;
    let cleanupCause: unknown;
    try {
      releasePlatformResources(nativeReleases.reverse());
    } catch (failure) {
      cleanupCause = failure;
    }
    return platformError('platform-operation-failed', {
      operation: 'subscribe',
      cause,
      ...(cleanupCause === undefined ? {} : { cleanupCause }),
    });
  }

  return ok({
    canvas,
    now: () =>
      disposed ? platformError('platform-disposed', { operation: 'clock.now' }) : clock.now(),
    display,
    visible: () => !disposed && pageVisible && document.visibilityState !== 'hidden',
    requestFrame(callback) {
      if (disposed) return platformError('platform-disposed', { operation: 'requestFrame' });
      let live = true;
      let id: number;
      const release = () => {
        if (!live) return;
        live = false;
        releases.delete(release);
        releasePlatformResources([() => view.cancelAnimationFrame(id)]);
      };
      try {
        id = view.requestAnimationFrame(() => {
          if (!live || disposed) return;
          live = false;
          releases.delete(release);
          callback();
        });
      } catch (cause) {
        return platformError('platform-operation-failed', { operation: 'requestFrame', cause });
      }
      releases.add(release);
      return ok(release);
    },
    subscribe(listener) {
      if (disposed) return platformError('platform-disposed', { operation: 'subscribe' });
      const subscription = (event: PlatformEvent) => listener(event);
      listeners.add(subscription);
      return ok(() => {
        listeners.delete(subscription);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      releasePlatformResources([...releases, ...nativeReleases.reverse()]);
    },
  });
}
