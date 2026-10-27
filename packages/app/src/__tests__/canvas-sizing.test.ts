import type { Renderer } from '@forgeax/engine-render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  measureCanvasDrawingBuffer,
  observeCanvasDeviceLimit,
  refreshCanvasDeviceLimit,
  setCanvasDeviceLimit,
  syncCanvasDrawingBuffer,
} from '../canvas-sizing';

function surface(width: number, height: number) {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 300,
    height: 150,
    style: { width: '100%', height: '100%' },
  };
}

function budgetedSurface(width: number, height: number, renderWidth: number, renderHeight: number) {
  const canvas = surface(width, height) as ReturnType<typeof surface> & {
    getAttribute?: (name: string) => string | null;
  };
  const limits = new Map([
    ['data-forgeax-render-width-limit', String(renderWidth)],
    ['data-forgeax-render-height-limit', String(renderHeight)],
  ]);
  canvas.getAttribute = (name) => limits.get(name) ?? null;
  return canvas;
}

afterEach(() => vi.unstubAllGlobals());

describe('device-safe browser drawing buffer', () => {
  it.each([
    [2442, 1905, 1],
    [1805, 1083, 1.5],
    [3840, 2160, 2],
    [1905, 2442, 1],
    [1080, 1920, 3],
  ])('fits %sx%s at DPR %s before the renderer is ready', (width, height, dpr) => {
    vi.stubGlobal('devicePixelRatio', dpr);
    const canvas = surface(width, height);
    const measured = measureCanvasDrawingBuffer(canvas);
    syncCanvasDrawingBuffer(canvas);
    expect({ width: canvas.width, height: canvas.height }).toEqual(measured);
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(2048);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
    // At most one pixel of rounding, without stretching either axis.
    expect(Math.abs(canvas.width - (canvas.height * width) / height)).toBeLessThanOrEqual(2);
    expect(canvas.clientWidth).toBe(width);
    expect(canvas.clientHeight).toBe(height);
  });

  it('preserves native resolution below the limit and honors an explicit ratio cap', () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    const canvas = surface(1200, 700);
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([1800, 1050]);
    expect(measureCanvasDrawingBuffer(canvas, 1)).toEqual({ width: 1200, height: 700 });
  });

  it('honors per-canvas render budgets in landscape and portrait layouts', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const landscape = budgetedSurface(3840, 2160, 1920, 1080);
    expect(measureCanvasDrawingBuffer(landscape)).toEqual({ width: 1920, height: 1080 });
    syncCanvasDrawingBuffer(landscape);
    expect([landscape.width, landscape.height]).toEqual([1920, 1080]);
    expect([landscape.clientWidth, landscape.clientHeight]).toEqual([3840, 2160]);

    const portrait = budgetedSurface(1080, 1920, 1920, 1080);
    expect(measureCanvasDrawingBuffer(portrait)).toEqual({ width: 1080, height: 1920 });
    syncCanvasDrawingBuffer(portrait);
    expect([portrait.width, portrait.height]).toEqual([1080, 1920]);
    expect([portrait.clientWidth, portrait.clientHeight]).toEqual([1080, 1920]);
  });

  it('does not reallocate an unchanged drawing buffer or accumulate DPR scaling', () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    const canvas = surface(2442, 1905);
    syncCanvasDrawingBuffer(canvas);
    const width = vi.fn(),
      height = vi.fn();
    const currentWidth = canvas.width,
      currentHeight = canvas.height;
    Object.defineProperty(canvas, 'width', { get: () => currentWidth, set: width });
    Object.defineProperty(canvas, 'height', { get: () => currentHeight, set: height });
    for (let frame = 0; frame < 60; frame++) syncCanvasDrawingBuffer(canvas);
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
  });

  it('takes one current layout snapshot per measurement, including hidden and resized surfaces', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    let width = 800;
    let height = 600;
    const readWidth = vi.fn(() => width);
    const readHeight = vi.fn(() => height);
    const canvas = {
      get clientWidth() {
        return readWidth();
      },
      get clientHeight() {
        return readHeight();
      },
      width: 300,
      height: 150,
      style: { width: '', height: '' },
    };
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(readWidth).toHaveBeenCalledTimes(1);
    expect(readHeight).toHaveBeenCalledTimes(1);
    for (const [nextWidth, nextHeight, expectedWidth, expectedHeight] of [
      [800, 600, 1600, 1200],
      [0, 0, 1600, 1200],
      [600, 400, 1200, 800],
    ] as const) {
      width = nextWidth;
      height = nextHeight;
      readWidth.mockClear();
      readHeight.mockClear();
      expect(measureCanvasDrawingBuffer(canvas)).toEqual({
        width: expectedWidth,
        height: expectedHeight,
      });
      expect(readWidth).toHaveBeenCalledTimes(1);
      expect(readHeight).toHaveBeenCalledTimes(1);
    }
  });

  it('uses delivered logical dimensions without forcing layout while observing DPR, budgets and hidden buffers', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = budgetedSurface(1920, 1080, 1920, 1080);
    const width = vi.fn(() => 1920),
      height = vi.fn(() => 1080);
    Object.defineProperties(canvas, { clientWidth: { get: width }, clientHeight: { get: height } });
    const display = { width: 800, height: 600 };
    for (let frame = 0; frame < 120; frame++)
      expect(measureCanvasDrawingBuffer(canvas, undefined, display)).toEqual({
        width: 800,
        height: 600,
      });
    vi.stubGlobal('devicePixelRatio', 2);
    expect(measureCanvasDrawingBuffer(canvas, undefined, display)).toEqual({
      width: 1440,
      height: 1080,
    });
    expect(measureCanvasDrawingBuffer(canvas, 1, display)).toEqual({ width: 800, height: 600 });
    expect(measureCanvasDrawingBuffer(canvas, undefined, { width: 600, height: 800 })).toEqual({
      width: 1080,
      height: 1440,
    });
    expect(measureCanvasDrawingBuffer(canvas, undefined, { width: 0, height: 0 })).toEqual({
      width: 300,
      height: 150,
    });
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 1920, height: 1080 });
    expect(width).toHaveBeenCalledOnce();
    expect(height).toHaveBeenCalledOnce();
  });

  it('recomputes on window and DPI changes, including returning to a small window', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = surface(1200, 700);
    syncCanvasDrawingBuffer(canvas);
    canvas.clientWidth = 3840;
    canvas.clientHeight = 2160;
    vi.stubGlobal('devicePixelRatio', 2);
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
    canvas.clientWidth = 800;
    canvas.clientHeight = 600;
    vi.stubGlobal('devicePixelRatio', 1);
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
  });

  it('retains stylesheet sizing across DPR 1 to 2 and back', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      width: 300,
      height: 150,
      style: { width: '', height: '' },
    };
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    vi.stubGlobal('devicePixelRatio', 2);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 1600, height: 1200 });
    for (let frame = 0; frame < 30; frame++) syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    vi.stubGlobal('devicePixelRatio', 1);
    for (let frame = 0; frame < 30; frame++) syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
  });

  it('recognizes stylesheet resizing after layout initially matches the intrinsic size', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = {
      clientWidth: 300,
      clientHeight: 150,
      width: 300,
      height: 150,
      style: { width: '', height: '' },
    };
    syncCanvasDrawingBuffer(canvas);
    canvas.clientWidth = 400;
    canvas.clientHeight = 200;
    vi.stubGlobal('devicePixelRatio', 2);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 800, height: 400 });
    for (let frame = 0; frame < 60; frame++) syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([800, 400]);
  });

  it('retains the last buffer when a tab or container is hidden', () => {
    const canvas = surface(1280, 720);
    vi.stubGlobal('devicePixelRatio', 1);
    syncCanvasDrawingBuffer(canvas);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    syncCanvasDrawingBuffer(canvas);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 1280, height: 720 });
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
  });

  it('also bounds intrinsic-size canvases that have no explicit CSS size', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = { clientWidth: 2442, clientHeight: 1905, width: 2442, height: 1905 };
    syncCanvasDrawingBuffer(canvas);
    expect(Math.max(canvas.width, canvas.height)).toBe(2048);
  });

  it('applies explicit physical sizes while hidden and retains them for automatic sizing', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = surface(637, 606);
    syncCanvasDrawingBuffer(canvas);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    syncCanvasDrawingBuffer(canvas, { width: 400, height: 300 });
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
    syncCanvasDrawingBuffer(canvas);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 400, height: 300 });
  });

  it('bounds explicit hidden sizes with the same host and device limits', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = budgetedSurface(0, 0, 160, 90);
    syncCanvasDrawingBuffer(canvas, { width: 1204, height: 658 });
    expect([canvas.width, canvas.height]).toEqual([160, 87]);
    syncCanvasDrawingBuffer(canvas, { width: 658, height: 1204 });
    expect([canvas.width, canvas.height]).toEqual([87, 160]);
    const unbudgeted = surface(0, 0);
    syncCanvasDrawingBuffer(unbudgeted, { width: 4096, height: 2048 });
    expect([unbudgeted.width, unbudgeted.height]).toEqual([2048, 1024]);
  });

  it.each([
    [NaN, 300],
    [400, Infinity],
    [0, 300],
    [400, -1],
  ])('retains the buffer for invalid explicit extent %sx%s', (width, height) => {
    const canvas = surface(637, 606);
    syncCanvasDrawingBuffer(canvas, { width: 400, height: 300 });
    syncCanvasDrawingBuffer(canvas, { width, height });
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
  });
});

function device() {
  let dimension = 4096;
  let listener: Parameters<Renderer['subscribe']>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const renderer: Pick<Renderer, 'inspect' | 'subscribe'> = {
    inspect: vi.fn(
      () =>
        ({ limits: { maxTextureDimension2D: dimension } }) as unknown as ReturnType<
          Renderer['inspect']
        >,
    ),
    subscribe: (callback) => {
      listener = callback;
      return unsubscribe;
    },
  };
  return {
    renderer,
    unsubscribe,
    setLimit: (value: number) => {
      dimension = value;
    },
    state: (current: 'alive' | 'device-lost' | 'recovering') => {
      listener?.({ kind: 'state-changed', previous: 'alive', current });
    },
  };
}

describe('canvas device generations', () => {
  it('uses the actual device limit, retreats on loss, and refreshes on recovery', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = surface(3840, 2160);
    const d = device();
    refreshCanvasDeviceLimit(canvas, d.renderer);
    const release = observeCanvasDeviceLimit(canvas, d.renderer);
    expect([canvas.width, canvas.height]).toEqual([4096, 2304]);
    for (let frame = 0; frame < 60; frame++) syncCanvasDrawingBuffer(canvas);
    expect(d.renderer.inspect).toHaveBeenCalledTimes(1);
    d.state('device-lost');
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
    d.setLimit(1024);
    d.state('alive');
    expect([canvas.width, canvas.height]).toEqual([1024, 576]);
    release();
    expect(d.unsubscribe).toHaveBeenCalledTimes(1);
    d.setLimit(8192);
    d.state('alive');
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
  });

  it('shrinks a hidden oversized buffer after device loss without allocating a zero-size buffer', () => {
    const d = device();
    const canvas = surface(4096, 2048);
    refreshCanvasDeviceLimit(canvas, d.renderer);
    const release = observeCanvasDeviceLimit(canvas, d.renderer);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    d.state('recovering');
    expect([canvas.width, canvas.height]).toEqual([2048, 1024]);
    canvas.width = 0;
    canvas.height = 0;
    d.state('device-lost');
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    release();
  });

  it('falls back conservatively when optional device inspection fails or is invalid', () => {
    const canvas = surface(3840, 2160);
    const d = device();
    d.setLimit(NaN);
    refreshCanvasDeviceLimit(canvas, d.renderer);
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
    vi.mocked(d.renderer.inspect).mockImplementation(() => {
      throw Error('inspection failed');
    });
    expect(() => refreshCanvasDeviceLimit(canvas, d.renderer)).not.toThrow();
    expect([canvas.width, canvas.height]).toEqual([2048, 1152]);
  });

  it('measures with a device limit reported from another realm', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = surface(3840, 2160);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 2048, height: 1152 });
    setCanvasDeviceLimit(canvas, 8192);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 3840, height: 2160 });
    setCanvasDeviceLimit(canvas, Number.NaN);
    expect(measureCanvasDrawingBuffer(canvas)).toEqual({ width: 2048, height: 1152 });
  });

  it('ignores incomplete or invalid host budgets and non-finite DPR', () => {
    vi.stubGlobal('devicePixelRatio', Infinity);
    const canvas = budgetedSurface(1200, 700, -1, 720);
    syncCanvasDrawingBuffer(canvas);
    expect([canvas.width, canvas.height]).toEqual([1200, 700]);
    expect(measureCanvasDrawingBuffer(canvas, 0.5)).toEqual({ width: 600, height: 350 });
  });
});
