import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Context, type PluginPrograms } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  activateExecutionRoot,
  executionBootstrapHostPlugin,
  loadBootstrapEntry,
  prepareBootstrapEntry,
  validateExecutionBootstrapData,
} from '../execution';
import { SourceRenderWorker } from '../execution/source-render-worker';
import { ssrIdentityFixture, workerSelection } from './execution-fixtures';

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

describe('execution bootstrap isolation', () => {
  it('provides source geometry before plugin startup without waiting for child readiness', async () => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const meshHandle = assets.create(mesh).unwrap();
    const source = new SourceRenderWorker(
      world,
      assets,
      {
        kind: 'init',
        canvas: {} as OffscreenCanvas,
        bootstrapUrl: '',
        startupTimeoutMs: null,
        workers: workerSelection({ render: true, kernels: false }),
      },
      () => {},
    );
    const observed = vi.fn();
    const context = await createWorldContext(world, [
      executionBootstrapHostPlugin({
        dynamicGeometry: source.dynamicGeometry,
        drawingBufferSize: () => ({ width: 0, height: 0 }),
        setPointerLockAllowed() {},
      }),
      {
        name: 'source-geometry-bootstrap',
        inject: ['executionBootstrapHost'],
        async apply(ctx) {
          const host = ctx.executionBootstrapHost.dynamicGeometry;
          expect(host).toBe(source.dynamicGeometry);
          observed(await host?.prepareMeshResidency(world, meshHandle));
        },
      },
    ]);
    try {
      expect(observed).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'mesh-residency-gpu-not-ready' }),
        }),
      );
    } finally {
      await context.fiber.dispose();
      await source.dispose();
    }
  });

  it('preserves structured root mount failures through real Cordis startup', async () => {
    const guid = '00000000-0000-4000-8000-000000000001';
    const sourceFailure = {
      code: 'catalog-unavailable',
      detail: { guid, cause: new Error('authored plugin publication unavailable') },
    };
    const context = new Context();
    context.provide('assets', { readPluginDefinition: async () => err(sourceFailure) });
    context.provide('pluginPrograms', {
      sessionId: 'bootstrap-test',
      contextId: 'engine',
      sessionGeneration: 1,
      target: 'engine',
      tools: new Map(),
      definitions: new Map(),
      programs: new Map(),
    } satisfies PluginPrograms);
    try {
      const startupFailure = await activateExecutionRoot(context, { guid }).catch(
        (error: unknown) => error,
      );
      expect(startupFailure).toMatchObject({
        code: 'plugin-startup-failed',
        detail: {
          reason: 'failed',
          cleanup: 'completed',
          cause: expect.any(Error),
        },
      });
      const cause = (startupFailure as { detail?: { cause?: unknown } }).detail?.cause;
      expect(cause).toBeInstanceOf(Error);
      expect(cause).toMatchObject({
        name: 'Error',
        message: 'Root PluginAsset mount failed: plugin-asset-read-failed',
        code: 'plugin-asset-read-failed',
        expected: 'a validated plugin definition and its atomic publication evidence',
        hint: 'inspect and rebuild the owning Pack',
        detail: { guid, cause: sourceFailure },
        cause: {
          code: 'plugin-asset-read-failed',
          detail: { guid, cause: sourceFailure },
        },
      });
      if (cause instanceof Error) {
        expect(cause.stack).toEqual(expect.any(String));
      }
    } finally {
      await context.fiber.dispose();
    }
  });

  it('retains the provided four-field SSR identity without deriving provenance', async () => {
    const url = moduleUrl(`const identity=${JSON.stringify(ssrIdentityFixture)};
      export default () => ({ ssrIdentity: identity }); export { identity };`);
    const prepared = await prepareBootstrapEntry(url, undefined);
    const module = await import(/* @vite-ignore */ url);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.ssrIdentity).toEqual(ssrIdentityFixture);
      expect(prepared.value.ssrIdentity).toBe(module.identity);
    }
  });

  it('does not synthesize an omitted SSR identity', async () => {
    const prepared = await prepareBootstrapEntry(moduleUrl('export default () => ({})'), undefined);
    expect(prepared).toMatchObject({ ok: true, value: {} });
    if (prepared.ok) expect(prepared.value).not.toHaveProperty('ssrIdentity');
  });

  it.each([
    null,
    [],
    'identity',
    {},
    ...Object.keys(ssrIdentityFixture).map((field) => ({ ...ssrIdentityFixture, [field]: 1 })),
  ])('rejects a malformed SSR identity during prepare: %j', async (ssrIdentity) => {
    const result = await prepareBootstrapEntry(
      moduleUrl(`export default () => ({ssrIdentity:${JSON.stringify(ssrIdentity)}})`),
      undefined,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'app-execution-bootstrap-failed', detail: { phase: 'prepare' } },
    });
  });

  it('activates realm-local bootstrap plugins and disposes their effects', async () => {
    const url = moduleUrl(`export default function(data){return {plugins:[{
      name:'test-bootstrap',inject:['world','executionBootstrapHost'],apply(ctx){
        ctx.world.insertResource('bootstrapped',data.value);
        ctx.effect(()=>()=>ctx.world.insertResource('cleaned',true),'test/cleanup');
        ctx.executionBootstrapHost.setPointerLockAllowed(false);
      }
    }]}}`);
    const prepared = await prepareBootstrapEntry(url, { value: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const pointerLock = vi.fn();
    const close = vi.fn();
    const context = await createWorldContext(world, [
      executionBootstrapHostPlugin({
        port: { close } as unknown as MessagePort,
        drawingBufferSize: () => ({ width: 0, height: 0 }),
        setPointerLockAllowed: pointerLock,
      }),
      ...(prepared.value.plugins ?? []),
    ]);
    expect(world.getResource('bootstrapped')).toBe(true);
    expect(pointerLock).toHaveBeenCalledWith(false);
    await context.fiber.dispose();
    expect(world.getResource('cleaned')).toBe(true);
    // A rebuilt World borrows the same session channel; its Fiber must not close it.
    expect(close).not.toHaveBeenCalled();
  });

  it('projects current drawing-buffer size independently of canvas ownership', async () => {
    let canvas = { width: 64, height: 64 } as unknown as OffscreenCanvas;
    let size = { width: 64, height: 64 };
    const stop = vi.fn();
    const renderer = {
      subscribe: vi.fn(() => stop),
    } as unknown as import('@forgeax/engine-render').Renderer;
    const world = new World();
    const context = await createWorldContext(world, [
      executionBootstrapHostPlugin(
        {
          get canvas() {
            return canvas;
          },
          drawingBufferSize: () => size,
          setPointerLockAllowed() {},
        },
        renderer,
      ),
    ]);
    try {
      expect(context.executionBootstrapHost.canvas).toBe(canvas);
      expect(context.executionBootstrapHost.drawingBufferSize()).toEqual(size);
      canvas = { width: 128, height: 48 } as unknown as OffscreenCanvas;
      size = { width: 128, height: 48 };
      expect(context.executionBootstrapHost.canvas).toBe(canvas);
      expect(context.executionBootstrapHost.drawingBufferSize()).toEqual(size);
    } finally {
      await context.fiber.dispose();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps schedule identity in the realm-local World', async () => {
    const url = moduleUrl(`export default function(){return {plugins:[{
      name:'module-system',inject:['world'],apply(ctx){
        const system={name:'module-system',queries:[],fn(){}};
        ctx.world.addSystem(ctx.world.scheduleToken('Update'),system).unwrap();
        ctx.effect(()=>()=>ctx.world.removeSystem(ctx.world.scheduleToken('Update'),system.name),'test/system');
      }
    }]}}`);
    const prepared = await prepareBootstrapEntry(url, undefined);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const world = new World();
    const context = await createWorldContext(world, prepared.value.plugins ?? []);
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(1);
    await context.fiber.dispose();
    expect(world.inspect().scheduleSystemCount(world.scheduleToken('Update'))).toBe(0);
  });

  it('rejects a missing default export structurally', async () => {
    const result = await loadBootstrapEntry('data:text/javascript,export const value=1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'app-execution-bootstrap-failed') {
      expect(result.error.detail.phase).toBe('export');
    }
  });

  it('rejects non-cloneable bootstrap data before canvas transfer', () => {
    const result = validateExecutionBootstrapData(
      { callback: (() => {}) as never },
      'https://example.test/bootstrap.js',
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'app-execution-bootstrap-failed') {
      expect(result.error.detail.phase).toBe('data');
    }
  });
});
