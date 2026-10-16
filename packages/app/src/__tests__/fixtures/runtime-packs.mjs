import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  AssetRegistry,
  createAssetRegistry,
  createCatalogSource,
} from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { prepareRuntimePackContent } from '@forgeax/engine-import';
import {
  createRuntimePackPublication,
  preparePackProgram,
  projectPackageCatalog,
} from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { startPluginAsset } from '@forgeax/engine-plugin';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '../../../dist/index.mjs';

const trace = (stage) => {
  if (process.env.FORGEAX_RUNTIME_PACK_TRACE === '1')
    process.stderr.write(`${JSON.stringify({ stage, elapsedMs: process.uptime() * 1000 })}\n`);
};
trace('native-imports-ready');
const packageId = '01900000-0000-7000-8000-000000000201';
const language = process.argv[2] ?? 'js';
const snapshotPath = process.argv[3];
const restoring = process.argv[4] === 'restore';
const entry = `behavior.${language}`;
const programId = `project:runtime/${entry}#default`;
const world = new World();
trace('create-world-context-begin');
const context = await createWorldContext(world, [scenePlugin()]);
trace('create-world-context-complete');
const entity = world.spawn({ component: Transform, data: { pos: [7, 0, 0] } }).unwrap();
const baseGuid = '01900000-0000-7000-8000-000000000299';
let baseUrl = 'https://private.invalid/base/pack.json';
let basePack = createRuntimePackPublication({
  pack: {
    assets: [
      {
        guid: baseGuid,
        kind: 'plugin',
        payload: { kind: 'plugin', program: 'base' },
        refs: [],
        artifacts: {},
      },
    ],
  },
  scopeId: 'test',
  sourcePath: 'base',
  sourceRevision: 'base',
  packageUrl: baseUrl,
});
let privateReads = 0;
const baseFetcher = async (input) => {
  assert.equal(String(input), baseUrl);
  privateReads++;
  return new Response(JSON.stringify(basePack.pack));
};
const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
function baseRow() {
  return {
    ...projectPackageCatalog(
      basePack.pack.assets.map((asset) => ({
        ...asset,
        sourcePath: 'base',
        packageId: '01900000-0000-7000-8000-000000000298',
        sourceKey: 'base',
      })),
      baseUrl,
    )[0],
    publication: basePack.publication,
  };
}
const baseRows = [baseRow()];
const baseListeners = new Set();
const baseCatalog = createCatalogSource({
  entries: baseRows,
  expectedScope: { scopeId: 'test', generation: 1 },
  subscribe(listener) {
    baseListeners.add(listener);
    return () => baseListeners.delete(listener);
  },
});
const assembly = createAssetRuntimeAssembly(assets, {
  catalogSource: baseCatalog,
  fetcher: baseFetcher,
}).unwrap();
context.provide('assets', assets);
const baseEntry = { load: async () => ({ apply() {} }) };
context.provide('pluginPrograms', {
  sessionId: 'test',
  contextId: 'engine',
  sessionGeneration: 1,
  target: 'engine',
  tools: new Map(),
  definitions: new Map(),
  programs: new Map([['base', baseEntry]]),
});
const calls = { active: 0, entities: 0, expectedTransform: Transform, sameToken: false };
context.provide('runtimePackTestCalls', calls);
const runtimePacks = assembleRuntimePacks(context, assembly, {
  scopeId: 'test',
  imports: {
    scene: { identity: 'engine-test', url: import.meta.resolve('@forgeax/engine-scene') },
  },
});
const producer = runtimePacks.producer;
const frontendReader = createAssetRegistry({
  catalog: runtimePacks.catalog,
  fetcher: runtimePacks.fetcher,
  scopeId: 'test',
});
const frontendContext = context.isolate('assets');
frontendContext.provide('assets', frontendReader);
context.effect(() => () => frontendReader.dispose(), 'test/frontend-reader');
const source = `import { Transform } from 'scene';
  export default { inject: ['world', 'runtimePackTestCalls'], apply(${language === 'ts' ? 'ctx: any, config: { amount: number }' : 'ctx, config'}) {
    const calls = ctx.get('runtimePackTestCalls');
    calls.sameToken = Transform === calls.expectedTransform;
    calls.entities = [...ctx.world.query({ read: [Transform] }).unwrap()].length;
    ctx.effect(() => { calls.active += config.amount; return () => { calls.active -= config.amount; }; });
  } };`;
if (restoring) {
  (await producer.restore(JSON.parse(await readFile(snapshotPath, 'utf8')))).unwrap();
} else {
  const programSource = {
    entry,
    export: 'default',
    modules: { [entry]: source },
    imports: { scene: 'engine-test' },
  };
  let program;
  if (language === 'ts') {
    trace('native-devkit-plugin-build-import-begin');
    const devkit = await import('../../../../devkit/dist/plugin-build.mjs');
    trace('native-devkit-plugin-build-import-complete');
    program = devkit.prepareRuntimePackProgram(programSource).unwrap();
    trace('typescript-program-prepare-complete');
  } else program = { artifact: preparePackProgram(programSource).unwrap() };
  const content = (
    await prepareRuntimePackContent(
      packageId,
      { behavior: { kind: 'plugin', module: { specifier: `./${entry}` }, config: { amount: 2 } } },
      {
        programs: { [programId]: program },
      },
    )
  ).unwrap();
  (await producer.admit(content)).unwrap();
  trace('publication-admit-complete');
}
(await assets.readPluginDefinition(baseGuid)).unwrap();
assert.equal(privateReads, 1);
const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
(await assets.readPluginDefinition(guid)).unwrap();
baseUrl = 'https://private.invalid/base/v2/pack.json';
basePack = createRuntimePackPublication({
  pack: {
    assets: [
      {
        guid: baseGuid,
        kind: 'plugin',
        payload: { kind: 'plugin', program: 'base', config: { revision: 2 } },
        refs: [],
        artifacts: {},
      },
    ],
  },
  scopeId: 'test',
  sourcePath: 'base',
  sourceRevision: 'base-v2',
  packageUrl: baseUrl,
});
baseRows[0] = baseRow();
for (const listener of baseListeners)
  listener({ scopeId: 'test', generation: 1, added: [], changed: [baseRows[0]], removed: [] });
await assets.refreshCatalog();
assert.equal(
  (await assets.enumerateCatalog()).unwrap().find((row) => row.guid === baseGuid).packageUrl,
  baseUrl,
);
assert.equal((await assets.readPluginDefinition(baseGuid)).unwrap().asset.config.revision, 2);
// A base source cannot withdraw a runtime-owned GUID.
for (const listener of baseListeners)
  listener({ scopeId: 'test', generation: 1, added: [], changed: [], removed: [guid] });
assert.equal((await assets.readPluginDefinition(guid)).ok, true);
(await frontendReader.readPluginDefinition(guid)).unwrap();
assert.equal(
  (await frontendReader.readPluginDefinition(baseGuid)).unwrap().asset.config.revision,
  2,
);
assert.equal(calls.active, 0);
assert.equal(calls.entities, 0);
const first = (await startPluginAsset(context, guid, { timeoutMs: 500 })).unwrap();
const second = (await startPluginAsset(frontendContext, guid, { timeoutMs: 500 })).unwrap();
trace('native-plugin-activation-complete');
assert.equal(calls.sameToken, true);
assert.equal(calls.active, 4);
assert.equal(calls.entities, 1);
const saved = producer.snapshot();
if (snapshotPath && !restoring) await writeFile(snapshotPath, JSON.stringify(saved));
assert.deepEqual(saved.packs[0].source.assets.behavior.payload.module, { specifier: `./${entry}` });
producer.withdraw(packageId);
assert.equal((await frontendReader.readPluginDefinition(guid)).ok, false);
assert.equal(context.pluginPrograms.programs.has(programId), false);
assert.equal(context.pluginPrograms.programs.get('base'), baseEntry);
assert.equal(calls.active, 4);
await first.dispose();
assert.equal(calls.active, 2);
await second.dispose();
assert.equal(calls.active, 0);
assert.equal(world.hasComponent(entity, Transform), true);
const readsBefore = privateReads;
assets.invalidateAll();
(await assets.readPluginDefinition(baseGuid)).unwrap();
assert.equal(privateReads, readsBefore + 1);
await context.fiber.dispose();
assert.equal(assets.hasCatalogSource, false);
assembly.dispose();
trace('dispose-complete');
process.stdout.write(
  `${JSON.stringify({
    sameToken: calls.sameToken,
    entities: calls.entities,
    activeAfterDispose: calls.active,
  })}\n`,
);
