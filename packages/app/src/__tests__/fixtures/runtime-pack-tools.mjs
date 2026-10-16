import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { prepareRuntimePackContent } from '@forgeax/engine-import';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '../../../dist/index.mjs';

const [language, snapshotPath, mode] = process.argv.slice(2);
const restoring = mode === 'restore';
const packageId = '01900000-0000-7000-8000-000000000991';
const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
const typed = language === 'ts';
const pluginEntry = `plugin.${language}`;
const executorEntry = `executor.${language}`;
const sharedEntry = `shared.${language}`;
const world = new World();
const context = await createWorldContext(world, []);
const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
const assembly = createAssetRuntimeAssembly(assets, {
  catalogSource: createCatalogSource({ entries: [] }),
}).unwrap();
context.provide('assets', assets);
context.provide('pluginPrograms', {
  sessionId: 'test',
  contextId: 'engine',
  sessionGeneration: 1,
  target: 'engine',
  definitions: new Map(),
  programs: new Map(),
  tools: new Map(),
});
const runtime = assembleRuntimePacks(context, assembly, {
  scopeId: 'test',
  imports: {
    plugin: { identity: 'installed-engine', url: import.meta.resolve('@forgeax/engine-plugin') },
  },
});
const contract = {
  schemaVersion: '1.0.0',
  commands: [
    {
      id: 'runtime.run',
      title: 'Run',
      summary: '',
      realm: 'engine',
      executor: `./${executorEntry}`,
      exportName: 'run',
    },
    {
      id: 'runtime.alias',
      title: 'Alias',
      summary: '',
      realm: 'engine',
      executor: `./${executorEntry}`,
      exportName: 'run',
    },
    { id: 'runtime.unavailable', title: 'Unavailable', summary: '', realm: 'engine' },
    {
      id: 'host.only',
      title: 'Host only',
      summary: '',
      realm: 'host',
      executor: `./${executorEntry}`,
      exportName: 'run',
    },
  ],
};
let conversions = 0;
if (restoring) {
  (await runtime.producer.restore(JSON.parse(await readFile(snapshotPath, 'utf8')))).unwrap();
} else {
  const modules = {
    [pluginEntry]: `import { registerAssetTools } from 'plugin';
      import { state } from './${sharedEntry}';
      globalThis.runtimePluginEvaluated = true;
      export default { inject: ['toolApi'], apply(${typed ? 'ctx: any, config: { amount: number }' : 'ctx, config'}) {
        ctx.effect(() => { state.active += config.amount; return () => { state.active -= config.amount; }; });
        ctx.effect(() => registerAssetTools(ctx));
      } };`,
    [executorEntry]: `import { state } from './${sharedEntry}';
      globalThis.runtimeExecutorEvaluated = true;
      export function run(${typed ? 'args: { value: number }' : 'args'}) { return { calls: ++state.calls, active: state.active, value: args.value }; }`,
    [sharedEntry]: `export const state${typed ? ': { active: number; calls: number }' : ''} = { active: 0, calls: 0 };`,
  };
  const prepare = async (entry, name) => {
    const source = { entry, export: name, modules, imports: { plugin: 'installed-engine' } };
    if (!typed) return { artifact: preparePackProgram(source).unwrap() };
    conversions++;
    return (await import('../../../../devkit/dist/plugin-build.mjs'))
      .prepareRuntimePackProgram(source)
      .unwrap();
  };
  const content = (
    await prepareRuntimePackContent(
      packageId,
      {
        behavior: {
          kind: 'plugin',
          module: { specifier: `./${pluginEntry}` },
          config: { amount: 2 },
          toolContract: contract,
        },
      },
      {
        programs: {
          behavior: await prepare(pluginEntry, 'default'),
          executor: await prepare(executorEntry, 'run'),
        },
      },
    )
  ).unwrap();
  (await runtime.producer.admit(content)).unwrap();
  assert.equal(conversions, typed ? 2 : 0);
}
assert.equal(globalThis.runtimePluginEvaluated, undefined);
assert.equal(globalThis.runtimeExecutorEvaluated, undefined);
(await assets.readPluginDefinition(guid)).unwrap();
assert.equal(globalThis.runtimePluginEvaluated, undefined);
assert.equal(globalThis.runtimeExecutorEvaluated, undefined);
const declared = context.pluginPrograms.tools.get(guid);
assert.deepEqual(
  declared.commands.map((command) => command.id),
  ['runtime.run', 'runtime.alias', 'runtime.unavailable'],
);
assert.equal(declared.commands[0].executor, 'executor');
assert.equal(declared.commands[0].exportName, undefined);
const snapshot = runtime.producer.snapshot();
assert.deepEqual(snapshot.packs[0].source.assets.behavior.payload.toolContract, contract);
assert.equal(Object.hasOwn(snapshot.packs[0], 'tools'), false);
if (!restoring) await writeFile(snapshotPath, JSON.stringify(snapshot));
const other = context.isolate('toolApi');
(await startNativePlugin(context, createToolApiPlugin())).unwrap();
(await startNativePlugin(other, createToolApiPlugin())).unwrap();
const first = (await startPluginAsset(context, guid)).unwrap();
const second = (await startPluginAsset(other, guid)).unwrap();
assert.equal(globalThis.runtimePluginEvaluated, true);
assert.equal(globalThis.runtimeExecutorEvaluated, undefined);
assert.notEqual(context.toolApi, other.toolApi);
const run = (api, command, value) => api.run(command, { value }).terminal;
assert.deepEqual((await run(context.toolApi, 'runtime.run', 7)).result, {
  calls: 1,
  active: 4,
  value: 7,
});
assert.equal(globalThis.runtimeExecutorEvaluated, true);
assert.deepEqual((await run(other.toolApi, 'runtime.alias', 8)).result, {
  calls: 2,
  active: 4,
  value: 8,
});
assert.equal(
  (await run(context.toolApi, 'runtime.unavailable', 0)).failure.code,
  'tool-capability-unavailable',
);
assert.equal((await run(context.toolApi, 'host.only', 0)).outcome, 'failed');
runtime.producer.withdraw(packageId);
assert.equal(context.pluginPrograms.programs.size, 0);
assert.equal(context.pluginPrograms.tools.size, 0);
await first.dispose();
assert.equal((await run(context.toolApi, 'runtime.run', 0)).outcome, 'failed');
assert.deepEqual((await run(other.toolApi, 'runtime.run', 9)).result, {
  calls: 3,
  active: 2,
  value: 9,
});
await second.dispose();
assert.equal((await run(other.toolApi, 'runtime.run', 0)).outcome, 'failed');
await context.fiber.dispose();
assembly.dispose();
process.stdout.write(
  `${JSON.stringify({ language, restoring, conversions, calls: 3, independentFibers: true })}\n`,
);
