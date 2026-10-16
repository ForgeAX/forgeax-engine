import { Update, World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createApp } from '../create-app';
import type { App } from '../types';
import { testPlatform } from './platform-fixture';

describe('createApp presentation surface handoff', () => {
  it('waits for a submitted frame before releasing an already paused Edit surface', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCaf = globalThis.cancelAnimationFrame;
    let pendingFrame: ((timestamp: number) => void) | undefined;
    let completeFrame!: (result: Awaited<FrameReceipt['completed']>) => void;
    const completed = new Promise<Awaited<FrameReceipt['completed']>>((resolve) => {
      completeFrame = resolve;
    });
    let drawCount = 0;
    let releaseCount = 0;

    globalThis.requestAnimationFrame = (callback) => {
      pendingFrame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      pendingFrame = undefined;
    };

    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      ready: Promise.resolve(ok(undefined)),
      attach: () => ok({ dispose() {} }),
      detachWorld() {},
      draw() {
        drawCount += 1;
        return ok({ frameId: 1, deviceGeneration: 0, presentation: 'ready', completed });
      },
      subscribe: () => () => {},
      releaseSurface() {
        releaseCount += 1;
        return ok(undefined);
      },
      restoreSurface: () => ok(undefined),
      dispose() {},
    } as unknown as Renderer;

    try {
      const created = await createApp({
        platform: testPlatform(),
        renderer,
        world: new World(),
        silenceUnhandledErrors: true,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const app = created.value;
      expect(app.start().ok).toBe(true);
      pendingFrame?.(16);
      expect(drawCount).toBe(1);
      expect(app.pause().ok).toBe(true);

      const handoff = app.releaseSurfacePreserveWorld();
      await Promise.resolve();
      expect(releaseCount).toBe(0);

      completeFrame(ok(undefined));
      expect((await handoff).ok).toBe(true);
      expect(releaseCount).toBe(1);
      expect(app.stop().ok).toBe(true);
    } finally {
      completeFrame(ok(undefined));
      if (previousRaf === undefined) Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      else globalThis.requestAnimationFrame = previousRaf;
      if (previousCaf === undefined) Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      else globalThis.cancelAnimationFrame = previousCaf;
    }
  });

  it('keeps the current frame drawable when release starts during Update', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCaf = globalThis.cancelAnimationFrame;
    let pendingFrame: ((timestamp: number) => void) | undefined;
    let surfaceReleased = false;
    let drawSawReleasedSurface = false;
    let drawCount = 0;
    let releaseCount = 0;

    globalThis.requestAnimationFrame = (callback) => {
      pendingFrame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      pendingFrame = undefined;
    };

    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attach: () => ok({ dispose() {} }),
      detachWorld() {},
      draw(): { ok: true; value: undefined } {
        drawCount += 1;
        drawSawReleasedSurface = surfaceReleased;
        return ok(undefined);
      },
      subscribe(): () => void {
        return () => {};
      },
      releaseSurface(): { ok: true; value: undefined } {
        releaseCount += 1;
        surfaceReleased = true;
        return ok(undefined);
      },
      restoreSurface(): { ok: true; value: undefined } {
        surfaceReleased = false;
        return ok(undefined);
      },
      dispose(): void {},
    } as unknown as Renderer;

    try {
      const world = new World();
      let app: App | undefined;
      let handoff: Promise<unknown> | undefined;
      world
        .addSystem(Update, {
          name: 'request-surface-handoff',
          queries: [],
          fn: () => {
            if (app !== undefined) handoff = app.releaseSurfacePreserveWorld();
          },
        })
        .unwrap();

      const result = await createApp({
        platform: testPlatform(),
        renderer,
        world,
        silenceUnhandledErrors: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      app = result.value;

      expect(app.start().ok).toBe(true);
      const frame = pendingFrame;
      expect(frame).toBeDefined();
      frame?.(16);
      await handoff;

      expect(drawCount).toBe(1);
      expect(drawSawReleasedSurface).toBe(false);
      expect(releaseCount).toBe(1);
      expect((await app.restoreSurface()).ok).toBe(true);
      expect(app.stop().ok).toBe(true);
    } finally {
      if (previousRaf === undefined) {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      } else {
        globalThis.requestAnimationFrame = previousRaf;
      }
      if (previousCaf === undefined) {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      } else {
        globalThis.cancelAnimationFrame = previousCaf;
      }
    }
  });
});
