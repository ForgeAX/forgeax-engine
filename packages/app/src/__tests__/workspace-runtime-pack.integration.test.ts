import assert from 'node:assert/strict';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { startPluginAsset } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { createToolApi } from '@forgeax/engine-tool-runtime';
import type { CatalogDelta, MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createApp } from '../create-app';
import {
  captureEngineWorkspaceAssetBinding,
  createEngineWorkspaceProvider,
  createEngineWorkspaceRuntime,
  EngineWorkspaceError,
} from '../workspace';
import { engineWorkspaceBrowserPlugin } from '../workspace-browser';
import { createEngineWorkspaceTools } from '../workspace-tools';
import { testPlatform } from './platform-fixture';

const packageId = '01900000-0000-7000-8000-000000000341';
const instanceId = '01900000-0000-7000-8000-000000000342';
const pluginId = '01900000-0000-7000-8000-000000000343';
const guidFor = (id: string, key: string) =>
  AssetGuid.format(AssetGuid.derive(definePackageId(id), key));
const rendererStub = () =>
  ({
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose() {},
  }) as unknown as Renderer;

// Actual App/producer/Registry/Cordis and browser command consumer. No renderer or pixel claim.
async function fixture() {
  const world = new World();
  world.insertResource('plugin-installations', new Set<number>());
  const assets = new AssetRegistry({} as never);
  const app = (
    await createApp({
      platform: testPlatform(),
      world,
      assets,
      renderer: rendererStub(),
      assetCatalog: createCatalogSource({ entries: [] }),
      pluginPrograms: {
        sessionId: 'session',
        contextId: 'engine',
        sessionGeneration: 1,
        target: 'engine',
        tools: new Map(),
        definitions: new Map(),
        programs: new Map(),
      },
      runtimePacks: {
        scopeId: 'workspace-test',
        imports: {
          geometry: {
            identity: 'test-engine',
            url: import.meta.resolve('@forgeax/engine-geometry'),
          },
        },
      },
    })
  ).unwrap();
  const start = vi.spyOn(app, 'start');
  const project = { id: 'project', root: '/project' };
  const target = {
    targetId: 'target',
    sessionId: 'session',
    worldId: world.identity,
    headed: true,
    width: 320,
    height: 240,
  };
  const listeners = new Set<(value: unknown) => void>();
  const replies = new Map<
    string,
    (result: { ok: boolean; value?: unknown; error?: unknown }) => void
  >();
  let counter = 0;
  let beforeReply: ((value: unknown) => Promise<void>) | undefined;
  const browser = await app.pluginContext.plugin(engineWorkspaceBrowserPlugin, {
    app,
    project,
    target,
    canvas: {
      ownerDocument: { documentElement: { dataset: {}, removeAttribute() {} } },
    } as unknown as HTMLCanvasElement,
    transport: {
      async request(_service, value) {
        await beforeReply?.(value);
        const reply = value as { id: string; ok: boolean; value?: unknown; error?: unknown };
        replies.get(reply.id)?.(reply);
        return {};
      },
      subscribe(_topic, fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
  });
  await browser.await();
  const runtime = createEngineWorkspaceRuntime(
    createEngineWorkspaceProvider({
      openProjectSession: () => ({
        project,
        target,
        app,
        assets,
        async runtimePack(input) {
          const id = String(++counter);
          const result = new Promise<{ ok: boolean; value?: unknown; error?: unknown }>((resolve) =>
            replies.set(id, resolve),
          );
          const emit = (kind: string) => {
            for (const fn of listeners)
              fn({ kind, id, sessionId: target.sessionId, operation: 'runtimePack', input });
          };
          const abort = () => emit('cancel');
          input.signal?.addEventListener('abort', abort, { once: true });
          try {
            emit('command');
            if (input.signal?.aborted) abort();
            const response = await result;
            if (!response.ok) {
              const error = response.error as {
                code: string;
                expected: string;
                hint: string;
                detail: Record<string, unknown>;
              };
              throw new EngineWorkspaceError(error.code, error.expected, error.hint, error.detail);
            }
            return response.value;
          } finally {
            input.signal?.removeEventListener('abort', abort);
            replies.delete(id);
          }
        },
      }),
    }),
  );
  const opened = await runtime.openProject({ root: project.root });
  const api = createToolApi();
  api.registerProvider({
    providerId: 'workspace',
    sourceId: 'engine',
    realm: 'host',
    tools: createEngineWorkspaceTools(runtime),
  });
  const call = async (
    operation: string,
    args: Record<string, unknown> = {},
    connectionId = 'view-a',
    signal = new AbortController().signal,
  ) => {
    const terminal = await api.run(
      `engine.runtime-pack.${operation}`,
      { projectId: project.id, targetId: target.targetId, worldId: world.identity, ...args },
      {
        sourceId: 'engine',
        signal,
        caller: { connectionId, kind: 'frontend' },
      },
    ).terminal;
    if (signal.aborted) signal.throwIfAborted();
    return terminal.outcome === 'failed' ? { ok: false, error: terminal.failure } : terminal.result;
  };
  return {
    app,
    assets,
    world,
    start,
    runtime,
    browser,
    call,
    holdReply(gate: (value: unknown) => Promise<void>) {
      beforeReply = gate;
    },
    async release(connectionId: string) {
      return runtime.runtimePack?.({
        ...opened,
        targetId: target.targetId,
        worldId: world.identity,
        connectionId,
        request: { operation: 'release' },
      });
    },
    async closeWorkspace() {
      const id = String(++counter);
      const result = new Promise<{ ok: boolean; value?: unknown; error?: unknown }>((resolve) =>
        replies.set(id, resolve),
      );
      try {
        for (const fn of listeners)
          fn({ kind: 'command', id, sessionId: target.sessionId, operation: 'closeWorkspace' });
        return await result;
      } finally {
        replies.delete(id);
      }
    },
    async close() {
      await api.dispose();
      await runtime.dispose();
      await browser.dispose();
      await app.dispose();
    },
  };
}

function behavior(source = '') {
  return {
    source: {
      schemaVersion: '3.0.0',
      packageId: pluginId,
      assets: {
        behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } },
      },
    },
    programs: {
      'project:workspace-behavior.js#default': {
        artifact: preparePackProgram({
          entry: 'behavior.js',
          export: 'default',
          modules: {
            'behavior.js': `export default { inject: ['world'], async apply(ctx) {
          const entries = ctx.world.getResource('plugin-installations');
          const id = ctx.fiber.uid;
          ctx.effect(() => { entries.add(id); return () => entries.delete(id); });
          ${source}
        } };`,
          },
        }).unwrap(),
      },
    },
  };
}

it.each([
  'delta',
  'reconcile',
])('generates and binds new JS content with %s delivery and stale World rejection', async (delivery) => {
  const f = await fixture();
  try {
    const content = {
      source: {
        schemaVersion: '2.0.0',
        kind: 'scriptable-pack-source',
        source: 'runtime/generator',
        packageId,
        parameters: [{ name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 }],
        runtime: { dependencies: [] },
        program: 'generator',
      },
      programs: {
        generator: {
          artifact: preparePackProgram({
            entry: 'generator.js',
            export: 'build',
            imports: { geometry: 'test-engine' },
            modules: {
              'generator.js': `import { createBoxGeometry } from 'geometry'; export function build({ values }) { return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap() } }; }`,
            },
          }).unwrap(),
        },
      },
    };
    await expect(f.call('inspect')).resolves.toMatchObject({ packs: [], executions: [] });
    expect(await f.call('admit', { content })).toMatchObject({ status: 'admitted' });
    const instance = {
      schemaVersion: '3.0.0',
      packageId: instanceId,
      parent: packageId,
      values: { width: 3 },
    };
    expect(await f.call('generate', { instance })).toMatchObject({ status: 'admitted' });
    const guid = guidFor(instanceId, 'box');
    const mesh = (await f.assets.loadByGuid<MeshAsset>(f.assets.parseGuid(guid))).unwrap();
    expect(mesh.attributes.position).toBeInstanceOf(Float32Array);
    expect(Array.from(mesh.aabb ?? [])).toEqual([-1.5, -1, -1.5, 1.5, 1, 1.5]);
    expect((await f.assets.enumerateCatalog()).unwrap()).toEqual([
      expect.objectContaining({ guid, kind: 'mesh' }),
    ]);
    expect(await f.call('snapshot')).toMatchObject({ instances: [instance] });
    expect(
      await f.call('withdraw', { packageId: instanceId, worldId: 'stale-world' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'tool-domain-failed', detail: { code: 'engine-workspace-target-stale' } },
    });
    expect((await f.assets.enumerateCatalog()).unwrap()).toHaveLength(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.runtime.previews).toEqual([]);
    const runtimePacks = f.app.pluginContext.runtimePacks;
    assert(runtimePacks);
    const previewAssets = new AssetRegistry({} as never);
    let forward: ((delta: CatalogDelta) => void) | undefined;
    let dropDelta = false;
    const catalog = {
      ...runtimePacks.catalog,
      subscribe(listener: (delta: CatalogDelta) => void) {
        forward = listener;
        return runtimePacks.catalog.subscribe((delta) => {
          if (!dropDelta) listener(delta);
        });
      },
    };
    const preview = (
      await createApp({
        platform: testPlatform(),
        world: new World(),
        assets: previewAssets,
        renderer: rendererStub(),
        assetCatalog: catalog,
      })
    ).unwrap();
    try {
      expect(preview.pluginContext.runtimePacks).toBeUndefined();
      expect(preview.world.identity).not.toBe(f.world.identity);
      const first = (
        await previewAssets.loadByGuid<MeshAsset>(previewAssets.parseGuid(guid))
      ).unwrap();
      expect(Array.from(first.aabb ?? [])).toEqual([-1.5, -1, -1.5, 1.5, 1, 1.5]);
      const oldBinding = captureEngineWorkspaceAssetBinding(previewAssets, guid, first);
      expect(oldBinding.publication?.digest).toMatch(/^sha256:/);
      const originalBinding = structuredClone(oldBinding);
      dropDelta = delivery === 'reconcile';
      expect(
        await f.call('generate', { instance: { ...instance, values: { width: 5 } } }),
      ).toMatchObject({ status: 'admitted' });
      if (dropDelta) {
        forward?.({
          added: [],
          changed: [],
          removed: [],
          authority: 'degraded',
          diagnostics: [
            {
              code: 'catalog-gap',
              severity: 'blocking',
              expected: 'contiguous revisions',
              hint: 'reconcile',
              authority: 'catalog',
            },
          ],
        });
        expect((await previewAssets.reconcileCatalog()).ok).toBe(true);
      }
      const next = (
        await previewAssets.loadByGuid<MeshAsset>(previewAssets.parseGuid(guid))
      ).unwrap();
      expect(Array.from(next.aabb ?? [])).toEqual([-2.5, -1, -1.5, 2.5, 1, 1.5]);
      const nextBinding = captureEngineWorkspaceAssetBinding(previewAssets, guid, next);
      expect(nextBinding.publication?.digest).not.toBe(oldBinding.publication?.digest);
      expect(oldBinding).toEqual(originalBinding);
      expect(oldBinding.meta?.aabb).toEqual([-1.5, -1, -1.5, 1.5, 1, 1.5]);
      expect(nextBinding.meta?.aabb).toEqual([-2.5, -1, -1.5, 2.5, 1, 1.5]);
      expect(() => captureEngineWorkspaceAssetBinding(previewAssets, guid, first)).toThrow(
        'loaded asset to remain current',
      );
    } finally {
      await preview.dispose();
    }
    expect(f.app.pluginContext.runtimePacks).toBe(runtimePacks);
    expect(await f.call('generate', { instance })).toMatchObject({ status: 'admitted' });
    expect(
      Array.from(
        (await f.assets.loadByGuid<MeshAsset>(f.assets.parseGuid(guid))).unwrap().aabb ?? [],
      ),
    ).toEqual([-1.5, -1, -1.5, 1.5, 1, 1.5]);
  } finally {
    await f.close();
  }
});

it('keeps game and two View installations independent using native ownership and trusted connection IDs', async () => {
  const f = await fixture();
  try {
    const guid = guidFor(pluginId, 'behavior');
    expect(await f.call('admit', { content: behavior() })).toMatchObject({ status: 'admitted' });
    const entries = f.world.getResource<Set<number>>('plugin-installations');
    expect(entries?.size).toBe(0);
    const game = (await startPluginAsset(f.app.pluginContext, guid)).unwrap();
    const a = (await f.call('plugin-install', { guid })) as { uid: number };
    const b = (await f.call('plugin-install', { guid }, 'view-b')) as { uid: number };
    expect(a).toMatchObject({ state: 'active' });
    expect(b).toMatchObject({ state: 'active' });
    expect(new Set([game.uid, a.uid, b.uid]).size).toBe(3);
    expect(entries?.size).toBe(3);
    await expect(
      f.call('plugin-dispose', { uid: a.uid, connectionId: 'view-a' }, 'view-b'),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'tool-domain-failed',
        detail: { code: 'engine-workspace-plugin-owner-mismatch' },
      },
    });
    await f.release('view-a');
    expect(entries?.size).toBe(2);
    expect(await f.call('plugin-inspect')).toEqual({ plugins: [] });
    expect(await f.call('plugin-inspect', {}, 'view-b')).toMatchObject({
      plugins: [{ uid: b.uid, state: 'active' }],
    });
    await f.browser.dispose();
    expect(entries?.size).toBe(1);
    assert(game.uid !== null);
    expect(entries?.has(game.uid)).toBe(true);
    expect(f.app.pluginContext.runtimePacks?.producer.inspect().packs).toHaveLength(1);
    await game.dispose();
    expect(entries?.size).toBe(0);
  } finally {
    await f.close();
  }
});

it.each([
  ['plugin-dispose', 'throw'],
  ['plugin-dispose', 'reject'],
  ['release', 'throw'],
  ['release', 'reject'],
] as const)('reports ACTIVE plugin cleanup failure during %s (%s)', async (operation, mode) => {
  const f = await fixture();
  try {
    const cleanup =
      mode === 'throw'
        ? 'throw new Error("active cleanup failed");'
        : 'return Promise.reject(new Error("active cleanup failed"));';
    await f.call('admit', { content: behavior(`ctx.effect(() => () => { ${cleanup} });`) });
    const installed = (await f.call('plugin-install', { guid: guidFor(pluginId, 'behavior') })) as {
      uid: number;
    };
    expect(installed).toMatchObject({ state: 'active' });
    const code =
      operation === 'release'
        ? 'engine-workspace-plugin-release-incomplete'
        : 'engine-workspace-plugin-cleanup-failed';
    if (operation === 'release') {
      await expect(f.release('view-a')).rejects.toMatchObject({
        code: 'engine-workspace-plugin-release-incomplete',
        detail: { cleanup: 'failed' },
      });
    } else {
      await expect(f.call(operation, { uid: installed.uid })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'tool-domain-failed',
          detail: { code: 'engine-workspace-plugin-cleanup-failed' },
        },
      });
    }
    // Cordis removed the failed Fiber; an empty scope must not erase the
    // Workspace's existing incomplete-cleanup state or make retry safe.
    await expect(f.release('view-a')).rejects.toMatchObject({
      code,
      detail: { cleanup: 'failed' },
    });
    await expect(
      f.call('plugin-install', { guid: guidFor(pluginId, 'behavior') }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'tool-domain-failed', detail: { code } },
    });
    await expect(f.closeWorkspace()).resolves.toMatchObject({
      ok: false,
      error: { code, detail: { cleanup: 'failed' } },
    });
  } finally {
    await f.close();
  }
});

it('drains a cancelled native installation and reports no surviving connection installation', async () => {
  const f = await fixture();
  try {
    await f.call('admit', {
      content: behavior('await new Promise(resolve => setTimeout(resolve, 80));'),
    });
    const controller = new AbortController();
    const pending = f.call(
      'plugin-install',
      { guid: guidFor(pluginId, 'behavior') },
      'view-a',
      controller.signal,
    );
    const entries = f.world.getResource<Set<number>>('plugin-installations');
    await vi.waitFor(() => expect(entries?.size).toBe(1));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await expect(f.call('plugin-inspect')).resolves.toEqual({ plugins: [] });
    expect(entries?.size).toBe(0);
  } finally {
    await f.close();
  }
});

it('disposes only the new Fiber when cancellation arrives while its success reply is being transported', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await f.call('admit', { content: behavior() });
    const guid = guidFor(pluginId, 'behavior');
    const game = (await startPluginAsset(f.app.pluginContext, guid)).unwrap();
    f.holdReply(async (value) => {
      const response = value as { value?: { state?: string } };
      if (response.value?.state === 'active') {
        entered();
        await gate;
      }
    });
    const controller = new AbortController();
    const pending = f.call('plugin-install', { guid }, 'view-a', controller.signal);
    await sending;
    const entries = f.world.getResource<Set<number>>('plugin-installations');
    expect(entries?.size).toBe(2);
    controller.abort();
    release();
    await expect(pending).rejects.toBeDefined();
    await expect(f.call('plugin-inspect')).resolves.toEqual({ plugins: [] });
    expect(entries?.size).toBe(1);
    assert(game.uid !== null);
    expect(entries?.has(game.uid)).toBe(true);
    await game.dispose();
  } finally {
    release();
    await f.close();
  }
});
