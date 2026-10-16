import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  auditAuthorityDefinition,
  buildAuthorityManifest,
  loadAuthorityDefinition,
} from '../check-asset-authority-audit.mjs';

const root = new URL('../../..', import.meta.url);

test('authority audit covers the named asset categories exactly once', async () => {
  const definition = await loadAuthorityDefinition(root.pathname);
  const result = auditAuthorityDefinition(definition, root.pathname);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(
    result.value.categories.map((category) => category.id),
    [
      'material',
      'shader-render-pipeline',
      'scene',
      'ui',
      'game-config',
      'glb',
      'fbx',
      'image',
      'font',
      'navigation-mesh',
      'audio',
      'plugin',
      'mesh-interchange',
    ],
  );
  for (const category of result.value.categories) {
    assert.ok(category.subject, `${category.id} must declare subject`);
    assert.ok(category.execution, `${category.id} must declare execution`);
    assert.ok(category.authority.sources.length > 0, `${category.id} must declare authority`);
    assert.ok(category.runtimeSource.length > 0, `${category.id} must declare runtime source`);
    assert.ok(category.lifecycle, `${category.id} must declare lifecycle conclusion`);
    assert.ok(category.owner, `${category.id} must declare owner`);
  }
});

test('authority audit rejects unknown producers, duplicate authority, and missing runtime source', async () => {
  const definition = await loadAuthorityDefinition(root.pathname);
  const base = definition.audit;

  const unknownProducer = structuredClone(base);
  unknownProducer.categories[0].producerIds.push('unregistered-producer');
  const unknownResult = auditAuthorityDefinition(
    { ...definition, audit: unknownProducer },
    root.pathname,
  );
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.match(unknownResult.error.code, /unknown-producer/);

  const duplicateAuthority = structuredClone(base);
  duplicateAuthority.categories[1].authority.id = duplicateAuthority.categories[0].authority.id;
  const duplicateResult = auditAuthorityDefinition(
    { ...definition, audit: duplicateAuthority },
    root.pathname,
  );
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.match(duplicateResult.error.code, /duplicate-authority/);

  const missingRuntime = structuredClone(base);
  missingRuntime.categories[2].runtimeSource = [];
  const runtimeResult = auditAuthorityDefinition(
    { ...definition, audit: missingRuntime },
    root.pathname,
  );
  assert.equal(runtimeResult.ok, false);
  if (!runtimeResult.ok) assert.match(runtimeResult.error.code, /runtime-source/);
});

test('authority manifest preserves sourceKey policy and excludes forge.json from Catalog', async () => {
  const definition = await loadAuthorityDefinition(root.pathname);
  const manifest = buildAuthorityManifest(definition, root.pathname);
  const gameConfig = manifest.categories.find((category) => category.id === 'game-config');

  assert.ok(gameConfig);
  assert.equal(gameConfig.catalog, 'excluded');
  assert.equal(gameConfig.sourceKeyPolicy, 'not-applicable');
  assert.equal(gameConfig.authority.kind, 'engine-project-manifest');
  assert.ok(
    manifest.producers.some((producer) => producer.id === 'engine-project-manifest'),
    'forge.json must be represented by its project-manifest producer',
  );
  assert.ok(
    manifest.producers
      .filter((producer) => producer.sourceKeyPolicy === 'required')
      .every((producer) => producer.outputs.every((output) => output.sourceKey !== undefined)),
    'all imported producer outputs must expose a stable sourceKey contract',
  );
});

test('authority schema is itself machine-readable JSON', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../../../schemas/asset-authority.schema.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(schema.$id, 'https://forgeax.dev/schema/asset-authority.schema.json');
  assert.equal(schema['x-forgeax-audit'].categories.length, 13);
  assert.equal(schema['x-forgeax-audit'].producers.length >= 10, true);
});

test('producer descriptors enumerate registered owners, outputs, and three input channels', async () => {
  const definition = await loadAuthorityDefinition(root.pathname);
  const manifest = buildAuthorityManifest(definition, root.pathname);
  const producerIds = new Set(manifest.producers.map((producer) => producer.id));

  for (const id of [
    'pack-native-cooker',
    'import-runner',
    'importer-registry',
    'gltf-importer',
    'fbx-importer',
    'image-importer',
    'font-importer',
    'audio-webaudio-importer',
    'vfx-compiler',
    'engine-project-manifest',
  ]) {
    assert.equal(producerIds.has(id), true, `missing registered producer ${id}`);
  }
  for (const producer of manifest.producers) {
    assert.ok(producer.sourceFiles.length > 0, `${producer.id} must list source files`);
    assert.ok(producer.outputs.length > 0, `${producer.id} must list outputs`);
    for (const output of producer.outputs) {
      assert.ok(output.category, `${producer.id} output must be categorized`);
      if (producer.sourceKeyPolicy === 'required') {
        assert.ok(output.sourceKey, `${producer.id}/${output.name} must expose sourceKey`);
      }
    }
  }
  assert.ok(manifest.inputs.ts.length > 0, 'TS producer inputs must be enumerated');
  assert.ok(manifest.inputs.scripts.length > 0, 'script producer inputs must be enumerated');
  assert.ok(manifest.inputs.json.length > 0, 'JSON producer inputs must be enumerated');
});

test('producer audit rejects sourceIndex-only, duplicate sourceKey, and undeclared outputs', async () => {
  const definition = await loadAuthorityDefinition(root.pathname);
  const base = definition.audit;

  const sourceIndexOnly = structuredClone(base);
  const sourceIndexProducer = sourceIndexOnly.producers.find(
    (producer) => producer.sourceKeyPolicy === 'required',
  );
  assert.ok(sourceIndexProducer);
  if (sourceIndexProducer) sourceIndexProducer.outputs[0].sourceKey = undefined;
  const sourceIndexResult = auditAuthorityDefinition(
    { ...definition, audit: sourceIndexOnly },
    root.pathname,
  );
  assert.equal(sourceIndexResult.ok, false);
  if (!sourceIndexResult.ok) assert.match(sourceIndexResult.error.code, /source-key/);

  const duplicateKey = structuredClone(base);
  const duplicateProducer = duplicateKey.producers.find(
    (producer) => producer.sourceKeyPolicy === 'required' && producer.outputs.length > 1,
  );
  assert.ok(duplicateProducer);
  if (duplicateProducer) {
    duplicateProducer.outputs[1].sourceKey = duplicateProducer.outputs[0].sourceKey;
  }
  const duplicateResult = auditAuthorityDefinition(
    { ...definition, audit: duplicateKey },
    root.pathname,
  );
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.match(duplicateResult.error.code, /source-key/);

  const undeclaredOutput = structuredClone(base);
  undeclaredOutput.producers[0].outputs[0].category = 'unclassified';
  const undeclaredResult = auditAuthorityDefinition(
    { ...definition, audit: undeclaredOutput },
    root.pathname,
  );
  assert.equal(undeclaredResult.ok, false);
  if (!undeclaredResult.ok) assert.match(undeclaredResult.error.code, /category|producer/);
});
