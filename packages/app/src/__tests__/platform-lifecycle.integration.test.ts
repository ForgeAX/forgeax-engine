import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, Update, World } from '@forgeax/engine-ecs';
import { type InputBackend, inputBackendPlugin } from '@forgeax/engine-input';
import {
  createPlatformClock,
  type Platform,
  type PlatformEvent,
  platformError,
} from '@forgeax/engine-platform';
import type { Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../create-app';

function fixture() {
  let time = 1000;
  let visible = true;
  let failure = false;
  let pending: (() => void) | undefined;
  const listeners = new Set<(event: PlatformEvent) => void>();
  const clock = createPlatformClock(() => time, 'milliseconds');
  const platform: Platform = {
    now: () => clock.now(),
    visible: () => visible,
    display: () =>
      ok({
        width: 100,
        height: 100,
        pixelRatio: 1,
        drawingWidth: 100,
        drawingHeight: 100,
        safeArea: { x: 0, y: 0, width: 100, height: 100 },
      }),
    requestFrame: (callback) => {
      if (failure) return platformError('platform-unavailable', { operation: 'requestFrame' });
      pending = callback;
      let live = true;
      return ok(() => {
        if (live) {
          live = false;
          pending = undefined;
        }
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return ok(() => {
        listeners.delete(listener);
      });
    },
    dispose: vi.fn(),
  };
  const world = new World();
  let updates = 0;
  world
    .addSystem(Update, {
      name: 'observe-native-delta',
      queries: [],
      fn: () => {
        updates += 1;
      },
    })
    .unwrap();
  const renderer = {
    ready: Promise.resolve(ok(undefined)),
    state: () => 'alive',
    backend: 'null',
    attach: () => ok({ dispose() {} }),
    draw: () => ok(undefined),
    subscribe: () => () => {},
    releaseSurface: () => ok(undefined),
    restoreSurface: () => ok(undefined),
    dispose: vi.fn(),
  } as unknown as Renderer;
  const input: InputBackend = {
    sample: () => ({
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: visible,
      pointerLocked: false,
    }),
    clear: vi.fn(),
    detach: vi.fn(),
  };
  return {
    platform,
    world,
    renderer,
    input,
    listeners,
    plugins: [inputBackendPlugin(input)],
    get updates() {
      return updates;
    },
    get pending() {
      return pending;
    },
    setFailure(value: boolean) {
      failure = value;
    },
    time(value: number) {
      time = value;
    },
    tick(value: number) {
      time = value;
      const next = pending;
      pending = undefined;
      next?.();
    },
    visibility(value: boolean) {
      visible = value;
      for (const listener of listeners) listener({ kind: 'visibility', visible });
    },
  };
}

describe('App borrowed platform lifecycle', () => {
  it('trims the owning asset read cache while hidden and leaves stopped owners untouched', async () => {
    const f = fixture();
    const assets = new AssetRegistry({ shaderRegistry: {} as never });
    const trim = vi.spyOn(assets, 'trimReadCache');
    const app = (await createApp({ ...f, assets })).unwrap();
    app.start().unwrap();
    f.visibility(false);
    const stale = [...f.listeners];
    for (const listener of f.listeners) listener({ kind: 'memory-pressure', level: 'critical' });
    expect(trim).toHaveBeenCalledTimes(1);
    expect(f.updates).toBe(0);
    expect(f.pending).toBeUndefined();
    await app.dispose();
    for (const listener of stale) listener({ kind: 'memory-pressure', level: 'moderate' });
    expect(trim).toHaveBeenCalledTimes(1);
  });

  it('advances the actual World once per host frame and discards background time', async () => {
    const f = fixture();
    const app = (await createApp(f)).unwrap();
    app.start().unwrap();
    f.tick(1016);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.016);
    expect(f.updates).toBe(1);
    f.visibility(false);
    expect(f.pending).toBeUndefined();
    expect(f.input.clear).toHaveBeenCalled();
    f.time(50_000);
    f.visibility(true);
    f.tick(50_020);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.02);
    expect(f.updates).toBe(2);
    await app.dispose();
    expect(f.listeners.size).toBe(0);
    expect(f.platform.dispose).not.toHaveBeenCalled();
    expect(f.renderer.dispose).not.toHaveBeenCalled();
    expect(f.input.detach).not.toHaveBeenCalled();
  });

  it('keeps hidden startup paused and does not resume after an explicit pause or stop', async () => {
    const f = fixture();
    f.visibility(false);
    const app = (await createApp(f)).unwrap();
    app.start().unwrap();
    expect(f.pending).toBeUndefined();
    app.pause().unwrap();
    f.visibility(true);
    expect(f.pending).toBeUndefined();
    app.resume().unwrap();
    expect(f.pending).toBeTypeOf('function');
    f.visibility(false);
    app.stop().unwrap();
    f.visibility(true);
    expect(f.pending).toBeUndefined();
    await app.dispose();
  });

  it('retains scheduling and invalid-clock causes without advancing World', async () => {
    const f = fixture();
    const app = (await createApp(f)).unwrap();
    f.setFailure(true);
    expect(app.start()).toMatchObject({
      ok: false,
      error: { detail: { cause: { code: 'platform-unavailable' } } },
    });
    f.setFailure(false);
    const errors: unknown[] = [];
    app.onError((error) => errors.push(error));
    app.start().unwrap();
    f.tick(999);
    expect(f.updates).toBe(0);
    expect(f.pending).toBeUndefined();
    expect(errors).toEqual([
      expect.objectContaining({
        detail: { cause: expect.objectContaining({ code: 'platform-clock-invalid' }) },
      }),
    ]);
    expect(app.execution.report().engine.health).toBe('idle');
    expect(app.execution.report().fault).toBeNull();
    f.time(2000);
    app.resume().unwrap();
    f.tick(2016);
    expect(f.updates).toBe(1);
    expect(app.execution.report().fault).toBeNull();
    await app.dispose();
  });

  it('does not resume a released surface on show, and defers restored frames while hidden', async () => {
    const f = fixture();
    const app = (await createApp(f)).unwrap();
    app.start().unwrap();
    f.visibility(false);
    (await app.releaseSurfacePreserveWorld()).unwrap();
    f.visibility(true);
    expect(f.pending).toBeUndefined();
    f.visibility(false);
    (await app.restoreSurface()).unwrap();
    expect(f.pending).toBeUndefined();
    f.time(4000);
    f.visibility(true);
    f.tick(4020);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.02);
    await app.dispose();
  });

  it('keeps an explicit pause across surface restore and visibility changes', async () => {
    const f = fixture();
    const app = (await createApp(f)).unwrap();
    app.start().unwrap();
    (await app.releaseSurfacePreserveWorld()).unwrap();
    app.pause().unwrap();
    (await app.restoreSurface()).unwrap();
    f.visibility(false);
    f.visibility(true);
    expect(f.pending).toBeUndefined();
    await app.dispose();
  });

  it('keeps explicit resume pending while the presentation surface is released', async () => {
    const f = fixture();
    const app = (await createApp(f)).unwrap();
    app.start().unwrap();
    (await app.releaseSurfacePreserveWorld()).unwrap();
    app.resume().unwrap();
    expect(f.pending).toBeUndefined();
    (await app.restoreSurface()).unwrap();
    expect(f.pending).toBeTypeOf('function');
    await app.dispose();
  });

  it('reports lifecycle acquisition failure and releases the App context', async () => {
    const f = fixture();
    const release = vi.fn();
    f.platform.subscribe = () => platformError('platform-unavailable', { operation: 'subscribe' });
    const result = await createApp({
      ...f,
      plugins: [
        {
          name: 'owned-effect',
          apply(ctx) {
            ctx.effect(() => release);
          },
        },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { cause: { code: 'platform-unavailable' } } },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(f.platform.dispose).not.toHaveBeenCalled();
  });
});
