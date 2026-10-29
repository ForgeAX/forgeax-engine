// M3 / w15: FORGEAX_ENGINE_RHI_DEBUG guard three-segment dual-source evaluation.
//
// The canvas-form guard in create-app.ts reads the flag from two sources with a
// precise precedence + short-circuit shape (plan-strategy D-4):
//
//   (typeof import.meta !== 'undefined' && import.meta.env?.FORGEAX_ENGINE_RHI_DEBUG)
//     ?? globalThis.process?.env?.FORGEAX_ENGINE_RHI_DEBUG
//
// That expression is extracted into the pure `resolveRhiDebugFlag` helper so the
// three deployment scenarios can be exercised without a real bundler / runtime:
//   (a) browser: import.meta.env replaced by the vite define -> '1' wins
//   (b) dawn-node: import.meta absent (modelled as undefined env) -> falls
//       through to globalThis.process.env
//   (c) unset: neither source carries '1' -> undefined -> guard does not fire
//
// C5 (plan-strategy): the `typeof import.meta !== 'undefined'` prefix must
// short-circuit before any `.env` access, because under dawn-node `import.meta`
// itself can be undefined; passing `undefined` for the import.meta.env arg is
// the unit-level model of that prefix evaluating to false.
//
// OOS-1/2: only the DevTools-trigger path is in scope; this test does not
// exercise external HTTP triggers or in-page buttons.

import { World } from '@forgeax/engine-ecs';
import { Camera, orthographic, perspective } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';

import { syncCanvasDrawingBuffer } from '../browser';
import { syncCameraAspect } from '../canvas-policy';
import { resolveRhiDebugFlag } from '../internal/rhi-debug-flag';

describe('create-app.test.ts', () => {
  describe('resolveRhiDebugFlag three-segment dual-source (w15 / D-4)', () => {
    it('(a) browser: import.meta.env.FORGEAX_ENGINE_RHI_DEBUG === "1" wins', () => {
      const flag = resolveRhiDebugFlag(
        { FORGEAX_ENGINE_RHI_DEBUG: '1' },
        { FORGEAX_ENGINE_RHI_DEBUG: undefined },
      );
      expect(flag).toBe('1');
    });

    it('(b) dawn-node: import.meta absent -> falls through to process.env', () => {
      // `undefined` models `typeof import.meta === 'undefined'` short-circuiting
      // the first operand to a falsy value, so the `??` chain consults process.env.
      const flag = resolveRhiDebugFlag(undefined, { FORGEAX_ENGINE_RHI_DEBUG: '1' });
      expect(flag).toBe('1');
    });

    it('(b2) import.meta.env present but flag unset -> still falls through to process.env', () => {
      // `import.meta.env` exists (vite always injects it) but the key is absent;
      // the first operand is `undefined`, so `??` consults process.env.
      const flag = resolveRhiDebugFlag({}, { FORGEAX_ENGINE_RHI_DEBUG: '1' });
      expect(flag).toBe('1');
    });

    it('(c) unset: neither source carries the flag -> undefined (guard does not fire)', () => {
      expect(resolveRhiDebugFlag(undefined, undefined)).toBeUndefined();
      expect(resolveRhiDebugFlag({}, {})).toBeUndefined();
      expect(
        resolveRhiDebugFlag(
          { FORGEAX_ENGINE_RHI_DEBUG: undefined },
          { FORGEAX_ENGINE_RHI_DEBUG: undefined },
        ),
      ).toBeUndefined();
    });

    it('import.meta.env wins over process.env when both set (precedence)', () => {
      // Browser path takes precedence: the `??` only consults process.env when
      // the first operand is null/undefined, and '1' is neither.
      const flag = resolveRhiDebugFlag(
        { FORGEAX_ENGINE_RHI_DEBUG: '1' },
        { FORGEAX_ENGINE_RHI_DEBUG: '0' },
      );
      expect(flag).toBe('1');
    });

    it('a non-"1" value is returned verbatim (guard compares === "1" at call site)', () => {
      // resolveRhiDebugFlag returns the raw flag; the create-app guard does the
      // `=== '1'` comparison. A '0' value must therefore not be coerced to fire.
      expect(resolveRhiDebugFlag({ FORGEAX_ENGINE_RHI_DEBUG: '0' }, undefined)).toBe('0');
    });
  });

  describe('zero-injection when flag unset (c) (w15 / F-3)', () => {
    it('globalThis.__forgeax is undefined before any flagged createApp runs', () => {
      // With the flag unset (the default unit-test environment: no vite define,
      // no process.env override), the canvas form never touches globalThis, so
      // the capture entry point does not exist. A DevTools caller invoking it
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
    it('matches the physical drawing buffer to CSS size at the device pixel ratio', () => {
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
        expect(canvas.width).toBe(1600);
        expect(canvas.height).toBe(800);
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
        expect(canvas.width).toBe(988);
        expect(canvas.height).toBe(2048);
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
        expect(width).toBe(512);
        expect(height).toBe(512);
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
