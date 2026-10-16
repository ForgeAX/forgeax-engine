// Explicit host for Dawn fixtures that own a synthetic frame queue and texture surface.
// This is a test driver, never a browser or Mini Game platform implementation.
import { ok } from '../packages/types/dist/index.mjs';

export function createSmokePlatform(canvas, { manual = false } = {}) {
  const pending = new Set();
  let disposed = false;
  return {
    now: () => ok(performance.now()),
    requestFrame(callback) {
      if (disposed) throw new Error('smoke platform is disposed');
      let active = true;
      // Manual fixtures cancel this lease in start -> pause, then use App.stepFrame.
      const id = manual
        ? undefined
        : requestAnimationFrame(() => {
            pending.delete(release);
            if (!active) return;
            active = false;
            callback();
          });
      function release() {
        if (!active) return;
        active = false;
        pending.delete(release);
        if (id !== undefined) cancelAnimationFrame(id);
      }
      pending.add(release);
      return ok(release);
    },
    display: () =>
      ok({
        width: canvas.width,
        height: canvas.height,
        pixelRatio: 1,
        drawingWidth: canvas.width,
        drawingHeight: canvas.height,
        safeArea: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      }),
    visible: () => true,
    subscribe: () => ok(() => {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of pending) release();
    },
  };
}

// Built browser consumers discover their platform through the canvas's Window.
// Retain the fixture's clock/frame queue and expose a borderless, zero-inset view.
export function bindSmokeCanvasWindow(canvas, view, document) {
  Object.assign(canvas, {
    ownerDocument: document,
    clientWidth: canvas.width,
    clientHeight: canvas.height,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: canvas.width, height: canvas.height };
    },
  });
  Object.assign(view, {
    performance: globalThis.performance,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    devicePixelRatio: 1,
    innerWidth: canvas.width,
    innerHeight: canvas.height,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() {
      return { paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px' };
    },
  });
  Object.assign(document, {
    defaultView: view,
    visibilityState: 'visible',
    documentElement: { dataset: {}, append() {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ relList: { supports: () => true }, style: {}, remove() {} }),
  });
}
