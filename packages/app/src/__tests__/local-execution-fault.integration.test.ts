import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app-assembly';
import { createApp as createBrowserApp } from '../browser';
import { createApp } from '../create-app';
import { type ExecutionReport, isExecutionReport } from '../execution';
import { testPlatform } from './platform-fixture';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));

async function localApp(entry: 'assemble' | 'builder' | 'browser') {
  // GPU acquisition is outside this failure path. World, App, Cordis, the
  // frame loop and dispatch/report observation all use their real owners.
  const renderer = {
    state: () => 'alive',
    backend: 'null',
    ready: Promise.resolve(ok(undefined)),
    attach: () => ok({ dispose() {} }),
    draw: () => ok(undefined),
    subscribe: () => () => {},
    dispose() {},
  } as unknown as Renderer;
  const platform = testPlatform();
  if (entry === 'browser') {
    constructRuntimeRendererHost.mockResolvedValue(
      ok({ renderer, assets: undefined, initialization: Promise.resolve(ok(undefined)) }),
    );
    return (
      await createBrowserApp({ tagName: 'canvas', isConnected: true } as HTMLCanvasElement, {
        platform,
        silenceUnhandledErrors: true,
      })
    ).unwrap();
  }
  const world = new World();
  if (entry === 'assemble') {
    return (await createApp({ platform, renderer, world, silenceUnhandledErrors: true })).unwrap();
  }
  const pluginContext = await createWorldContext(world, []);
  return (
    await buildApp({
      platform,
      renderer,
      world,
      pluginContext,
      installAppPlugin: async (plugin) => pluginContext.plugin(plugin),
      silenceUnhandledErrors: true,
    })
  ).unwrap();
}

describe('local App execution fault projection', () => {
  it.each([
    'assemble',
    'builder',
    'browser',
  ] as const)('%s reports the sealed World cause inside onError and after stop/dispose', async (entry) => {
    const app = await localApp(entry);
    let fail = false;
    const cause = Object.assign(new Error('local Update first failure'), {
      code: 'fixture-update-failed',
      detail: { callback: () => undefined },
    });
    app.world
      .addSystem(Update, {
        name: 'local-faulting-update',
        queries: [],
        fn() {
          if (fail) throw cause;
        },
      })
      .unwrap();
    const observed: ExecutionReport[] = [];
    app.onError(() => observed.push(app.execution.report()));
    try {
      app.start().unwrap();
      app.pause().unwrap();
      app.stepFrame(1 / 60).unwrap();
      expect(app.execution.report().fault).toBeNull();

      fail = true;
      expect(app.stepFrame(1 / 60)).toMatchObject({
        ok: false,
        error: { code: 'app-system-update-failed' },
      });
      expect(app.world.execution.health).toBe('poisoned');
      expect(observed).toHaveLength(1);
      const first = observed[0];
      if (first === undefined) throw new Error('App did not dispatch the Update failure');
      expect(first.fault).toMatchObject({
        source: 'world',
        code: app.world.execution.fault?.code,
        partialWrite: true,
        retryable: false,
        detail: {
          kernelName: 'system:local-faulting-update',
          cause: expect.objectContaining({
            message: cause.message,
            code: cause.code,
            detail: { callback: expect.any(String) },
          }),
        },
      });
      expect(first.engine.health).toBe('faulted');
      expect(first.world).toEqual({
        identity: app.world.identity,
        health: 'poisoned',
        partialWrite: true,
        retryable: false,
      });
      expect(isExecutionReport(first)).toBe(true);

      // A later world-poisoned error must not replace the original cause.
      expect(app.stepFrame(1 / 60).ok).toBe(false);
      expect(app.execution.report().fault).toEqual(first.fault);
      app.stop().unwrap();
      expect(app.execution.report().fault).toEqual(first.fault);
      (await app.dispose()).unwrap();
      expect(app.execution.report().fault).toEqual(first.fault);
    } finally {
      await app.dispose();
    }

    const replacement = await localApp(entry);
    expect(replacement.execution.report().fault).toBeNull();
    expect(replacement.execution.report().world.health).toBe('healthy');
    await replacement.dispose();
  });
});
