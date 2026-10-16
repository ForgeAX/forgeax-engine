import {
  type DisplayFacts,
  type Platform,
  type PlatformError,
  type PlatformEvent,
  type PlatformRelease,
  platformError,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import { ok, type Result } from '@forgeax/engine-types';
import { createWechatClock } from './clock.js';
import type { WechatCanvas, WechatHost } from './native.js';

export {
  createWechatAudioBackend,
  type WechatAudioOptions,
  type WechatAudioSource,
} from './audio.js';
export { createWechatTextReader, type WechatTextSource } from './files.js';
export type { WechatCanvas, WechatHost, WechatWindowInfo } from './native.js';
export {
  createWechatSocketConnector,
  type WechatSocketOptions,
  type WechatSocketSource,
  type WechatSocketTask,
} from './network.js';

export interface WechatPlatform extends Platform {
  readonly canvas: WechatCanvas;
}

/** Call from the generated entry before creating any auxiliary canvas. */
export function createWechatPlatform(
  host: WechatHost,
  canvas?: WechatCanvas,
): Result<WechatPlatform, PlatformError> {
  const wx = host.wx;
  for (const name of [
    'createCanvas',
    'getPerformance',
    'getDeviceInfo',
    'getWindowInfo',
    'onShow',
    'offShow',
    'onHide',
    'offHide',
    'onWindowResize',
    'offWindowResize',
    'onDeviceOrientationChange',
    'offDeviceOrientationChange',
  ] as const) {
    if (typeof wx?.[name] !== 'function') {
      return platformError('platform-unavailable', { operation: `wx.${name}` });
    }
  }
  if (
    typeof host.requestAnimationFrame !== 'function' ||
    typeof host.cancelAnimationFrame !== 'function'
  ) {
    return platformError('platform-unavailable', { operation: 'frame scheduling' });
  }
  let target: WechatCanvas;
  const clockResult = createWechatClock(wx);
  if (!clockResult.ok) return clockResult;
  const clock = clockResult.value;
  try {
    target = canvas ?? wx.createCanvas();
  } catch (cause) {
    return platformError('platform-operation-failed', { operation: 'initialize', cause });
  }
  let disposed = false;
  let visible = true;
  const releases = new Set<PlatformRelease>();
  const listeners = new Set<(event: PlatformEvent) => void>();

  function display(): Result<DisplayFacts, PlatformError> {
    if (disposed) return platformError('platform-disposed', { operation: 'display' });
    try {
      const info = wx.getWindowInfo();
      const { windowWidth: width, windowHeight: height, pixelRatio } = info;
      const safeArea =
        info.safeArea === undefined
          ? { x: 0, y: 0, width, height }
          : {
              x: info.safeArea.left,
              y: info.safeArea.top,
              width: info.safeArea.width,
              height: info.safeArea.height,
            };
      if (
        ![width, height, safeArea.x, safeArea.y, safeArea.width, safeArea.height].every(
          (value) => Number.isFinite(value) && value >= 0,
        ) ||
        safeArea.x + safeArea.width > width ||
        safeArea.y + safeArea.height > height ||
        !Number.isFinite(pixelRatio) ||
        pixelRatio <= 0 ||
        !Number.isSafeInteger(target.width) ||
        target.width < 0 ||
        !Number.isSafeInteger(target.height) ||
        target.height < 0
      ) {
        return platformError('platform-display-invalid', { cause: info });
      }
      return ok({
        width,
        height,
        pixelRatio,
        safeArea,
        drawingWidth: target.width,
        drawingHeight: target.height,
      });
    } catch (cause) {
      return platformError('platform-operation-failed', { operation: 'wx.getWindowInfo', cause });
    }
  }
  const initialDisplay = display();
  if (!initialDisplay.ok) return initialDisplay;

  const emit = (event: PlatformEvent) => {
    if (disposed) return;
    const failures: unknown[] = [];
    for (const listener of [...listeners]) {
      if (!disposed && listeners.has(listener)) {
        try {
          listener(event);
        } catch (cause) {
          failures.push(cause);
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Platform event listener failed');
  };
  const show = () => {
    visible = true;
    emit({ kind: 'visibility', visible });
  };
  const hide = () => {
    visible = false;
    emit({ kind: 'visibility', visible });
  };
  const displayChanged = () => {
    const facts = display();
    if (facts.ok) emit({ kind: 'display', display: facts.value });
    else emit({ kind: 'surface-lost', cause: facts.error });
  };
  const memory = (event: { readonly level: number }) =>
    emit({
      kind: 'memory-pressure',
      level: event.level === 10 ? 'moderate' : event.level === 15 ? 'critical' : 'unknown',
    });
  const nativeReleases: PlatformRelease[] = [];
  try {
    nativeReleases.push(() => wx.offShow(show));
    wx.onShow(show);
    nativeReleases.push(() => wx.offHide(hide));
    wx.onHide(hide);
    nativeReleases.push(() => wx.offWindowResize(displayChanged));
    wx.onWindowResize(displayChanged);
    // Native orientation can update window facts without a window-resize event.
    nativeReleases.push(() => wx.offDeviceOrientationChange(displayChanged));
    wx.onDeviceOrientationChange(displayChanged);
    if (typeof wx.onMemoryWarning === 'function' && typeof wx.offMemoryWarning === 'function') {
      nativeReleases.push(() => wx.offMemoryWarning?.(memory));
      wx.onMemoryWarning(memory);
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
    canvas: target,
    now: () =>
      disposed ? platformError('platform-disposed', { operation: 'clock.now' }) : clock.now(),
    display,
    visible: () => !disposed && visible,
    requestFrame(callback) {
      if (disposed) return platformError('platform-disposed', { operation: 'requestFrame' });
      let live = true;
      let id: unknown;
      let requesting = true;
      let synchronous = false;
      const release = () => {
        if (!live) return;
        live = false;
        releases.delete(release);
        releasePlatformResources([() => host.cancelAnimationFrame(id)]);
      };
      try {
        id = host.requestAnimationFrame(() => {
          if (requesting) {
            synchronous = true;
            return;
          }
          if (!live || disposed) return;
          live = false;
          releases.delete(release);
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
export type {
  WechatCacheFiles,
  WechatDownloadCacheOptions,
  WechatDownloadFiles,
} from './download-cache.js';
export type {
  WechatInputOptions,
  WechatTouch,
  WechatTouchEvent,
  WechatTouchSource,
} from './input.js';
export { createWechatInputBackend } from './input.js';
export type { WechatKeyboardEvent, WechatKeyboardSource } from './keyboard.js';
export { createWechatPackageFetcher, type WechatPackageSource } from './package-fetch.js';
export {
  createWechatRemotePackageFetcher,
  type WechatDownloadSource,
  type WechatRemotePackageOptions,
} from './remote-fetch.js';
export { createWechatWasmHost, createWechatWgpuHost, type WechatWasmSource } from './wasm.js';
