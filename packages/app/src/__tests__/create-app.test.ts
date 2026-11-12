import { World } from '@forgeax/engine-ecs';
import { Camera, orthographic, perspective } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';

import { syncCanvasDrawingBuffer } from '../browser';
import { syncCameraAspect } from '../canvas-policy';

describe('create-app.test.ts', () => {
  describe('zero-injection when flag unset (c) (w15 / F-3)', () => {
    it('globalThis.__forgeax is undefined before any flagged createApp runs', () => {
      // The canvas form publishes capture only when the explicit host adapter
      // supplies a recorder capability. A DevTools caller invoking it
      // would hit a TypeError -- the explicit-failure contract (charter P3).
      const g = globalThis as { __forgeax?: { captureFrame?: unknown } };
      expect(g.__forgeax).toBeUndefined();
      expect(() => {
        // Reading .captureFrame off an undefined __forgeax throws synchronously.
        (g.__forgeax as { captureFrame: (n: number) => unknown }).captureFrame(1);
      }).toThrow(TypeError);
    });
  });

  describe('syncCanvasDrawingBuffer host boundary', () => {
    it('defaults the physical drawing buffer to CSS size at device DPR 2', () => {
      const canvas = {
        clientWidth: 800,
        clientHeight: 400,
        width: 300,
        height: 150,
        style: { width: '800px', height: '400px' },
      };
      const before = globalThis.devicePixelRatio;
      Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 });
      try {
        syncCanvasDrawingBuffer(canvas);
        expect(canvas.width).toBe(800);
        expect(canvas.height).toBe(400);
      } finally {
        Object.defineProperty(globalThis, 'devicePixelRatio', {
          configurable: true,
          value: before,
        });
      }
    });

    it('keeps a CSS-sized phone canvas within the conservative startup texture limit', () => {
      const canvas = {
        clientWidth: 363,
        clientHeight: 752,
        width: 300,
        height: 150,
        style: { width: '100vw', height: '100vh' },
      };
      const before = globalThis.devicePixelRatio;
      Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 3.5 });
      try {
        syncCanvasDrawingBuffer(canvas);
        expect(canvas.width).toBe(363);
        expect(canvas.height).toBe(752);
      } finally {
        Object.defineProperty(globalThis, 'devicePixelRatio', {
          configurable: true,
          value: before,
        });
      }
    });

    it('leaves a zero-sized host untouched', () => {
      const canvas = { clientWidth: 0, clientHeight: 400, width: 300, height: 150 };
      syncCanvasDrawingBuffer(canvas);
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(150);
    });

    it('leaves a headless canvas without CSS dimensions untouched', () => {
      const canvas = { width: 320, height: 180 } as HTMLCanvasElement;
      syncCanvasDrawingBuffer(canvas);
      expect(canvas.width).toBe(320);
      expect(canvas.height).toBe(180);
    });

    it('preserves an intrinsic canvas drawing buffer without CSS dimensions', () => {
      let width = 256;
      let height = 256;
      const canvas = {
        get clientWidth() {
          return width;
        },
        get clientHeight() {
          return height;
        },
        get width() {
          return width;
        },
        set width(value: number) {
          width = value;
        },
        get height() {
          return height;
        },
        set height(value: number) {
          height = value;
        },
      };
      const before = globalThis.devicePixelRatio;
      Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 });
      try {
        syncCanvasDrawingBuffer(canvas, undefined, 2);
        syncCanvasDrawingBuffer(canvas, undefined, 2);
        expect(width).toBe(256);
        expect(height).toBe(256);
      } finally {
        Object.defineProperty(globalThis, 'devicePixelRatio', {
          configurable: true,
          value: before,
        });
      }
    });

    it('does not repeatedly scale a CSS-sized canvas when layout follows width writes', () => {
      let width = 256;
      let height = 256;
      const canvas = {
        clientWidth: 256,
        clientHeight: 256,
        style: { width: '256px', height: '256px' },
        get width() {
          return width;
        },
        set width(value: number) {
          width = value;
          canvas.clientWidth = value;
        },
        get height() {
          return height;
        },
        set height(value: number) {
          height = value;
          canvas.clientHeight = value;
        },
      };
      const before = globalThis.devicePixelRatio;
      Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 });
      try {
        syncCanvasDrawingBuffer(canvas);
        syncCanvasDrawingBuffer(canvas);
        expect(width).toBe(256);
        expect(height).toBe(256);
      } finally {
        Object.defineProperty(globalThis, 'devicePixelRatio', {
          configurable: true,
          value: before,
        });
      }
    });
  });

  // feat-20260617 M3 / w10: aspect-sync sidecar (createApp path only).
  // syncCameraAspect is the canvas-form per-frame Update system body
  // closure calls with the live canvas width/height. It walks Camera entities via
  // world.get (NOT the query bundle: a bool column read off the bundle returns a
  // raw 0/1 number, so `!== 0` is always true -- the
  // bool-field-compared-with-not-equal-zero-always-true trap; D-5/Finding 2). It
  // writes canvas.width/height into Camera.aspect for perspective + autoAspect=true
  // cameras only.
  describe('syncCameraAspect sidecar (w10 / AC-07)', () => {
    it('reads only aspect policy fields instead of a complete Camera snapshot', () => {
      const world = new World();
      world.spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) }).unwrap();
      const get = vi.spyOn(world, 'get');
      syncCameraAspect(world, 800, 400);
      expect(get).not.toHaveBeenCalled();
    });

    it('canvas resize -> perspective autoAspect=true camera aspect becomes w/h', () => {
      const world = new World();
      const cam = world
        .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
        .unwrap();

      syncCameraAspect(world, 800, 400);

      const r = world.get(cam, Camera);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.aspect).toBeCloseTo(2, 5);
    });

    it('does not journal a same-f32 aspect on every frame', () => {
      const world = new World();
      world.spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) }).unwrap();
      const set = vi.spyOn(world, 'set');

      syncCameraAspect(world, 1280, 720);
      syncCameraAspect(world, 1280, 720);

      expect(set).toHaveBeenCalledTimes(1);
      set.mockRestore();
    });

    it('autoAspect=false camera is left untouched', () => {
      const world = new World();
      const cam = world
        .spawn({
          component: Camera,
          data: perspective({ fov: 1, aspect: 1.234, autoAspect: false }),
        })
        .unwrap();

      syncCameraAspect(world, 800, 400);

      const r = world.get(cam, Camera);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.aspect).toBeCloseTo(1.234, 5);
    });

    it('canvas size 0 is skipped (no NaN / 0 written into aspect)', () => {
      const world = new World();
      const cam = world
        .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1.5 }) })
        .unwrap();

      syncCameraAspect(world, 0, 0);

      const r = world.get(cam, Camera);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.aspect).toBeCloseTo(1.5, 5);
      expect(Number.isNaN(r.value.aspect)).toBe(false);
    });

    it('orthographic camera is left untouched', () => {
      const world = new World();
      const cam = world
        .spawn({
          component: Camera,
          data: orthographic({ left: -1, right: 1, bottom: -1, top: 1 }),
        })
        .unwrap();
      const before = world.get(cam, Camera);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const aspectBefore = before.value.aspect;

      syncCameraAspect(world, 800, 400);

      const r = world.get(cam, Camera);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.aspect).toBeCloseTo(aspectBefore, 5);
    });
  });
});
