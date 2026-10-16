import { createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine/app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine/plugin';
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { Tag } from './assets/shared.js';
import { main, sibling } from './publication.js';
import { createRuntimePackOptions } from './runtime-packs';

// The new World starts with an empty asset/program table. Its host keeps the
// application's delivered module identity; persisted definitions populate it.
export async function restoreStaticPlugins(snapshot) {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const tagLease = world.components.register(Tag).unwrap();
  const entity = world
    .spawn({ component: Transform }, { component: Tag, data: { value: 7 } })
    .unwrap();
  const probe = { tag: Tag, transform: Transform };
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  // This deliberately rejects any fallback to SW: original graph restoration
  // must reuse application URLs in both main and DedicatedWorker realms.
  const options = await createRuntimePackOptions('restored', {
    error: 'unexpected new-module delivery',
  });
  const delivered = createPrograms('restored', 'engine', 1, options.programHost);
  context.provide('probe', probe);
  context.provide('assets', assets);
  context.provide('pluginPrograms', {
    ...delivered,
    programs: new Map(),
    tools: new Map(),
    definitions: new Map(),
  });
  const runtime = assembleRuntimePacks(context, assembly, {
    ...options,
    programHost: delivered.programHost,
  });
  try {
    (await runtime.producer.restore(JSON.parse(JSON.stringify(snapshot)))).unwrap();
    const rows = (await assets.enumerateCatalog()).unwrap();
    const lazyRestore = globalThis.backendProgramEvaluated !== true;
    const beforeMount = {
      plugin: globalThis.staticPluginEvaluations ?? 0,
      executor: globalThis.staticExecutorEvaluations ?? 0,
    };
    (await startNativePlugin(context, createToolApiPlugin())).unwrap();
    const first = (await startPluginAsset(context, main)).unwrap();
    const second = (await startPluginAsset(context, sibling)).unwrap();
    const terminal = await context.toolApi.run('static.run', {}).terminal;
    const result = {
      sameProjectToken: probe.sameProjectToken,
      sameEngineToken: probe.sameEngineToken,
      sameSiblingToken: probe.sameSiblingToken,
      entityCount: probe.entities,
      result: terminal.result,
      catalogCount: rows.length,
      backendExecutable: context.pluginPrograms.programs.has('project:assets/backend.js#default'),
      lazyRestore,
      beforeMount,
      savedTargets: Object.keys(
        Object.values(runtime.producer.snapshot().closure.recipes)[0].fixed.executions,
      ).sort(),
    };
    await second.dispose();
    await first.dispose();
    return result;
  } finally {
    world.despawn(entity).unwrap();
    await context.fiber.dispose();
    tagLease.dispose().unwrap();
    assembly.dispose();
  }
}
