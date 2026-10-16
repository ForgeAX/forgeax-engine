import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine-plugin';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  createNodePackProgramHost,
  createNodePackProgramImports,
} from '../../../../dist/index.mjs';

const [mode, root, inputPath, archivePath] = process.argv.slice(2);
const restoring = mode === 'restore';
const input = restoring ? undefined : JSON.parse(await readFile(inputPath, 'utf8'));
const saved = restoring ? JSON.parse(await readFile(archivePath, 'utf8')) : undefined;
const fixed = saved && Object.values(saved.closure.recipes).find((recipe) => recipe.fixed)?.fixed;
let connected = true;
const fetcher = async (url) => {
  assert.equal(connected, true, 'original transport was disconnected');
  assert.equal(String(url), input.rows[0].packageUrl);
  return new Response(JSON.stringify(input.pack));
};
const world = new World();
const context = await createWorldContext(world, [scenePlugin()]);
const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
const base = createCatalogSource({ entries: input?.rows ?? [] });
const assembly = createAssetRuntimeAssembly(assets, { catalogSource: base, fetcher }).unwrap();
const probe = { expected: Transform };
context.provide('probe', probe);
context.provide('assets', assets);
const existing = restoring
  ? undefined
  : (await import(pathToFileURL(input.entry).href)).createPrograms('test', 'host', 1);
const imports = restoring
  ? await createNodePackProgramImports(root, [
      ...new Set(
        Object.values(fixed.executions.host.programs).flatMap((program) =>
          Object.keys(program.imports ?? {}),
        ),
      ),
    ])
  : existing.imports;
const { scopeId, generation, digest, outputSetDigest } = input?.pack ?? fixed.pack;
const rows = input?.rows ?? fixed.rows;
const definitions = new Map(
  rows.map((row) => [
    row.guid,
    { kind: 'publication', publication: { scopeId, generation, digest, outputSetDigest } },
  ]),
);
context.provide(
  'pluginPrograms',
  existing
    ? { ...existing, definitions }
    : {
        sessionId: 'restored',
        contextId: 'host',
        sessionGeneration: 1,
        target: 'host',
        definitions: new Map(),
        tools: new Map(),
        programs: new Map(),
        imports,
        programHost: createNodePackProgramHost(`${root}/programs`),
      },
);
const runtime = assembleRuntimePacks(context, assembly, {
  scopeId: restoring ? 'restored' : 'original',
});
if (restoring) {
  connected = false;
  (await runtime.producer.restore(saved)).unwrap();
}
assert.equal(globalThis.archiveEvaluations, undefined);
assert.equal(globalThis.siblingEvaluations, undefined);
assert.equal(globalThis.executorEvaluations, undefined);
const main = rows.find((row) => row.sourceKey === 'behavior').guid;
const sibling = rows.find((row) => row.sourceKey === 'sibling').guid;
(await assets.readPluginDefinition(main)).unwrap();
(await assets.readPluginDefinition(sibling)).unwrap();
assert.equal(globalThis.archiveEvaluations, undefined);
(await startNativePlugin(context, createToolApiPlugin())).unwrap();
const first = (await startPluginAsset(context, main)).unwrap();
assert.equal(context.toolApi.list().length, 1);
assert.equal(globalThis.siblingEvaluations, undefined);
assert.equal(globalThis.executorEvaluations, undefined);
if (!restoring) {
  // A normal runtime-authored reference asks App's default source owner to capture
  // the complete delivered Pack and extract portable content from its provider.
  const output = input.rows[0].publication.outputs.find((item) => item.guid === main);
  (
    await runtime.producer.admit({
      source: {
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000962',
        assets: {
          bookmark: {
            kind: 'plugin',
            payload: {
              module: { specifier: './bookmark.js' },
              config: { target: { $asset: main } },
            },
          },
        },
      },
      programs: {
        bookmark: {
          artifact: preparePackProgram({
            entry: 'bookmark.js',
            export: 'default',
            modules: { 'bookmark.js': 'export default { apply() {} };' },
          }).unwrap(),
        },
      },
      dependencies: { [main]: output.digest },
    })
  ).unwrap();
  const snapshot = runtime.producer.snapshot();
  const captured = Object.values(snapshot.closure.recipes).find((recipe) => recipe.fixed).fixed;
  assert.equal(Object.keys(captured.executions.host.tools).length, 2);
  assert.equal(Object.keys(captured.executions.host.programs).length, 3);
  await writeFile(archivePath, JSON.stringify(snapshot));
}
assert.equal(globalThis.siblingEvaluations, undefined);
assert.equal(globalThis.executorEvaluations, undefined);
const second = (await startPluginAsset(context, sibling)).unwrap();
assert.equal(probe.sameEngineToken, true);
assert.equal(probe.sameProjectToken, true);
const result = await context.toolApi.run('archive.run', {}).terminal;
assert.equal(result.outcome, 'succeeded');
assert.deepEqual(result.result, { count: 1, active: 11, component: 'ArchiveTag' });
assert.equal(globalThis.executorEvaluations, 1);
await second.dispose();
if (restoring) {
  runtime.producer.dispose();
  assert.equal(context.pluginPrograms.tools.size, 0);
  assert.equal(context.pluginPrograms.programs.size, 0);
}
// An existing Fiber keeps its captured executor even when the asset is withdrawn.
const next = await context.toolApi.run('archive.run', {}).terminal;
assert.deepEqual(next.result, { count: 2, active: 1, component: 'ArchiveTag' });
await first.dispose();
assert.equal((await context.toolApi.run('archive.run', {}).terminal).outcome, 'failed');
await context.fiber.dispose();
assembly.dispose();
process.stdout.write(
  `${JSON.stringify({
    plugins: 2,
    executions: 2,
    sameEngineToken: probe.sameEngineToken,
    sameProjectToken: probe.sameProjectToken,
  })}\n`,
);
