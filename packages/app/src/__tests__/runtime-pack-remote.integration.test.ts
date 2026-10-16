import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { Renderer } from '@forgeax/engine-render';
import { defaultConnect } from '@forgeax/engine-types/inspector-client';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../create-app';
import { testPlatform } from './platform-fixture';

afterEach(() => vi.unstubAllEnvs());

it('uses the actual App Context to admit and execute a new plugin over the existing inspector', async () => {
  vi.stubEnv('FORGEAX_ENGINE_REMOTE_SERVE', '1');
  const world = new World();
  const renderer = {
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose() {},
  } as unknown as Renderer;
  const app = (
    await createApp({
      platform: testPlatform(),
      world,
      renderer,
      assets: new AssetRegistry({} as never),
      assetCatalog: createCatalogSource({ entries: [] }),
      pluginPrograms: {
        sessionId: 'test',
        contextId: 'engine',
        sessionGeneration: 1,
        target: 'engine',
        tools: new Map(),
        definitions: new Map(),
        programs: new Map(),
      },
      runtimePacks: {
        scopeId: 'remote-test',
        imports: {
          '@forgeax/engine/plugin': {
            identity: 'test-engine',
            url: import.meta.resolve('@forgeax/engine-plugin'),
          },
        },
      },
    })
  ).unwrap();
  try {
    if (!app.remote) throw new Error('Missing opted-in inspector');
    const connected = await defaultConnect(`ws://127.0.0.1:${app.remote.port}/inspector`);
    if (!connected.ok) throw connected.error;
    const client = connected.value;
    try {
      const packageId = '01900000-0000-7000-8000-000000000332';
      const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
      const content = {
        source: {
          schemaVersion: '3.0.0',
          packageId,
          assets: {
            behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } },
          },
        },
        programs: {
          'project:remote-behavior.js#default': {
            artifact: preparePackProgram({
              entry: 'behavior.js',
              export: 'default',
              modules: {
                'behavior.js': `export default { inject: ['world'], apply(ctx) {
              ctx.effect(() => { ctx.world.insertResource('remote-behavior', 42); return () => ctx.world.removeResource('remote-behavior'); });
            } };`,
              },
            }).unwrap(),
          },
        },
      };
      const result = await client.eval(`
        const context = simulation.pluginContext;
        const runtime = context.get('runtimePacks');
        const before = runtime.producer.inspect().packs.length;
        (await runtime.producer.admit(${JSON.stringify(content)})).unwrap();
        const beforeInstall = world.hasResource('remote-behavior');
        const { startPluginAsset } = await _import('@forgeax/engine/plugin');
        const started = (await startPluginAsset(context, ${JSON.stringify(guid)})).unwrap();
        const installed = world.getResource('remote-behavior');
        await started.dispose();
        return { before, beforeInstall, installed, removed: !world.hasResource('remote-behavior'), retained: runtime.producer.inspect().packs.length, worldId: world.identity };
      `);
      expect(result).toMatchObject({
        before: 0,
        beforeInstall: false,
        installed: 42,
        removed: true,
        retained: 1,
        worldId: world.identity,
      });
    } finally {
      await client.dispose();
    }
  } finally {
    await app.dispose();
  }
});
