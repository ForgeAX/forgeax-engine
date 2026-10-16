import { createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import {
  captureAssetPublication,
  createAssetRegistry,
  createCatalogSource,
} from '@forgeax/engine/assets-runtime';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { createFixedRuntimePackSnapshot } from '@forgeax/engine/import';
import { loadPackProgram, preparePackProgram } from '@forgeax/engine/pack/runtime';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine/plugin';
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { state, Tag } from './assets/shared.js';
import backend from './backend.json';
import { main, pack, rows, sibling } from './publication.js';
import { restoreStaticPlugins } from './restore.js';

// Native matching is separate from new-module publication; the sentinel host
// observes only routing. New JS execution is covered by pack-program-browser.
export async function probeNativeRouting(artifact, missingArchive = false, helperExports = []) {
  const fallbackCalls = [];
  const fallback = {
    publish: async (program) => {
      fallbackCalls.push(program.entry);
      return 'https://fallback.invalid/new.js';
    },
  };
  const provider = createPrograms('routing', 'engine', 1, fallback);
  const host = provider.programHost;
  const unrelated = preparePackProgram({
    entry: 'new.js',
    export: 'value',
    modules: { 'new.js': 'export const value = 1;' },
  }).unwrap();
  const routedNew = await host.publish(unrelated, provider.imports);
  let nativeError;
  let nativeUrl;
  try {
    nativeUrl = await host.publish(artifact, provider.imports);
  } catch (cause) {
    nativeError = String(cause);
  }
  if (missingArchive) return { routedNew, nativeError, fallbackCalls };
  const { digest: _digest, ...source } = artifact;
  const bytes = preparePackProgram({
    ...source,
    modules: {
      ...artifact.modules,
      [artifact.entry]: `${artifact.modules[artifact.entry]}\n// changed`,
    },
  }).unwrap();
  const membership = preparePackProgram({
    ...source,
    modules: {
      ...artifact.modules,
      'unused.js': 'export const value = 1;',
    },
  }).unwrap();
  const missingEntry = preparePackProgram({
    ...source,
    modules: { [artifact.entry]: 'export default 1;' },
    imports: {},
  }).unwrap();
  const specifier = Object.keys(artifact.imports)[0];
  const changedBindings = {
    ...provider.imports,
    [specifier]: {
      ...provider.imports[specifier],
      url: `${provider.imports[specifier].url}?different-binding`,
    },
  };
  const modified = await Promise.all([
    host.publish(bytes, provider.imports),
    host.publish(membership, provider.imports),
    host.publish(missingEntry, provider.imports),
    host.publish(artifact, changedBindings),
  ]);
  const helper = Object.keys(artifact.modules).find((key) =>
    artifact.modules[key].includes('StaticTag'),
  );
  const values = await Promise.all(
    helperExports.map(async (name) =>
      (
        await loadPackProgram(
          preparePackProgram({ ...source, entry: helper, export: name }).unwrap(),
          provider.imports,
          host,
        )
      ).unwrap(),
    ),
  );
  const token = values.find((value) => value === Tag);
  return { routedNew, nativeUrl, nativeError, modified, fallbackCalls, sameHelper: token === Tag };
}

// This import is intentionally outside the plugin graph's entry facade. A
// portable producer must preserve this identity as well as plugin-to-plugin sharing.
export async function runStaticPlugins() {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const tagLease = world.components.register(Tag).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: Tag, data: { value: 7 } },
    )
    .unwrap();
  const assets = createAssetRegistry({
    scopeId: 'static',
    catalog: createCatalogSource({ entries: rows }),
    fetcher: async () => new Response(JSON.stringify(pack)),
  });
  const probe = { tag: Tag, transform: Transform };
  context.provide('probe', probe);
  context.provide('assets', assets);
  context.provide('pluginPrograms', createPrograms('test', 'engine', 1));
  try {
    const exports = await Promise.all(
      [...context.pluginPrograms.programs].flatMap(([key, entry]) =>
        entry.exportSource ? [entry.exportSource().then((program) => [key, program])] : [],
      ),
    );
    globalThis.staticArchive = Object.fromEntries(exports);
    for (const row of rows) (await assets.readPluginDefinition(row.guid)).unwrap();
    const lazyDefinition = globalThis.staticPluginEvaluations === undefined;
    (await startNativePlugin(context, createToolApiPlugin())).unwrap();
    const first = (await startPluginAsset(context, main)).unwrap();
    const lazyExecutor = globalThis.staticExecutorEvaluations === undefined;
    const second = (await startPluginAsset(context, sibling)).unwrap();
    const result = await context.toolApi.run('static.run', {}).terminal;
    await second.dispose();
    const afterSibling = await context.toolApi.run('static.run', {}).terminal;
    await first.dispose();
    const retired = await context.toolApi.run('static.run', {}).terminal;
    let restored;
    if (exports.length) {
      const fixed = (
        await captureAssetPublication(
          rows[0],
          rows,
          createCatalogSource({ entries: rows }),
          async () => new Response(JSON.stringify(pack)),
          {
            executions: [
              context.pluginPrograms,
              {
                target: backend.target,
                tools: new Map(backend.tools),
                definitions: new Map(backend.definitions),
                programs: new Map(
                  backend.programs.map(([key, program]) => [
                    key,
                    { exportSource: async () => program },
                  ]),
                ),
              },
            ],
          },
        )
      ).unwrap();
      const snapshot = await createFixedRuntimePackSnapshot(fixed);
      globalThis.staticSnapshot = snapshot;
      restored = await restoreStaticPlugins(snapshot);
    }
    return {
      lazyDefinition,
      exported: exports.length,
      lazyExecutor,
      sameEngineToken: probe.sameEngineToken,
      sameProjectToken: probe.sameProjectToken,
      sameSiblingToken: probe.sameSiblingToken,
      entityCount: probe.entities,
      result: result.result,
      afterSibling: afterSibling.result,
      retired: retired.outcome,
      active: state.active,
      programCount: context.pluginPrograms.programs.size,
      definitionCount: rows.length,
      backendExecutable: context.pluginPrograms.programs.has('project:assets/backend.js#default'),
      ...(restored ? { restored } : {}),
    };
  } finally {
    world.despawn(entity).unwrap();
    await context.fiber.dispose();
    tagLease.dispose().unwrap();
    assets.dispose();
  }
}
