import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '../../../dist/index.mjs';

const [archive, target] = process.argv.slice(2);
const saved = JSON.parse(await readFile(archive, 'utf8'));
const context = await createWorldContext(new World(), []);
const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
const assembly = createAssetRuntimeAssembly(assets, {
  catalogSource: createCatalogSource({ entries: [] }),
  fetcher: async () => {
    throw new Error('producer transport is absent');
  },
}).unwrap();
context.provide('assets', assets);
context.provide('probe', {});
context.provide('pluginPrograms', {
  target,
  sessionId: 'restored',
  contextId: target,
  sessionGeneration: 1,
  programs: new Map(),
  definitions: new Map(),
  tools: new Map(),
});
const runtime = assembleRuntimePacks(context, assembly, {
  scopeId: 'restored',
  imports: {
    plugin: { identity: 'native-plugin', url: import.meta.resolve('@forgeax/engine-plugin') },
    ...(target === 'host' ? { 'node:path': { identity: 'native-node', url: 'node:path' } } : {}),
  },
});
try {
  (await runtime.producer.restore(saved)).unwrap();
  const rows = runtime.producer.rows();
  const eligible = [...context.pluginPrograms.tools.keys()];
  const foreign = rows.find((row) => !context.pluginPrograms.tools.has(row.guid)).guid;
  for (const row of rows) (await assets.readPluginDefinition(row.guid)).unwrap();
  assert.equal(globalThis.mixedEvaluations, undefined);
  const blocked = await startPluginAsset(context, foreign);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'plugin-program-unavailable');
  assert.equal(globalThis.mixedEvaluations, undefined);
  (await startNativePlugin(context, createToolApiPlugin())).unwrap();
  const first = (await startPluginAsset(context, eligible[0])).unwrap();
  const second = (await startPluginAsset(context, eligible[1])).unwrap();
  assert.equal(context.probe.target, target);
  assert.equal(globalThis.mixedEvaluations, 1);
  const result = await context.toolApi.run('mixed.run', {}).terminal;
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(result.result, {
    target,
    active: 2,
    count: 1,
    dependency: target === 'host' ? 'asset' : 'browser',
  });
  const roundTrip = runtime.producer.snapshot();
  const fixed = Object.values(roundTrip.closure.recipes).find((recipe) => recipe.fixed).fixed;
  assert.equal(Object.keys(fixed.executions).length, 2);
  await second.dispose();
  runtime.producer.dispose();
  assert.equal(context.pluginPrograms.programs.size, 0);
  assert.equal(context.pluginPrograms.tools.size, 0);
  assert.equal(context.pluginPrograms.definitions.size, 0);
  const pinned = await context.toolApi.run('mixed.run', {}).terminal;
  assert.equal(pinned.result.active, 1);
  await first.dispose();
  const retired = await context.toolApi.run('mixed.run', {}).terminal;
  assert.equal(retired.outcome, 'failed');
  process.stdout.write(
    `${JSON.stringify({
      target,
      definitions: rows.length,
      executable: eligible.length,
      blocked: !blocked.ok,
      active: pinned.result.active,
      retired: retired.outcome,
      retainedGroups: Object.keys(fixed.executions).length,
    })}\n`,
  );
} finally {
  await context.fiber.dispose();
  assembly.dispose();
}
