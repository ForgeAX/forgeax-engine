// Canvas assembly tests replace native platform acquisition while testing other owners.
// Real platform behavior is exercised by platform-browser's browser suite.
import type { Platform } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';

export function createBrowserPlatform() {
  const platform: Platform = {
    now: () => ok(performance.now()),
    requestFrame(callback) {
      const id = globalThis.requestAnimationFrame?.(() => callback());
      return ok(() => {
        if (id !== undefined) globalThis.cancelAnimationFrame?.(id);
      });
    },
    display: () =>
      ok({
        width: 64,
        height: 64,
        pixelRatio: 1,
        drawingWidth: 64,
        drawingHeight: 64,
        safeArea: { x: 0, y: 0, width: 64, height: 64 },
      }),
    visible: () => true,
    subscribe: () => ok(() => {}),
    dispose() {},
  };
  return ok(platform);
}

/** Adapt a deterministic test scheduler; production App has no timing fallback. */
export function testPlatform(
  options: {
    now?: () => number;
    raf?: (callback: (timestamp: number) => void) => number;
    caf?: (id: number) => void;
  } = {},
): Platform {
  return {
    ...createBrowserPlatform().unwrap(),
    now: () => ok(options.now?.() ?? performance.now()),
    requestFrame(callback) {
      const id = options.raf?.(callback) ?? globalThis.requestAnimationFrame?.(callback);
      return ok(() => {
        if (id !== undefined) (options.caf ?? globalThis.cancelAnimationFrame)?.(id);
      });
    },
  };
}
