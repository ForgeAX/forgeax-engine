import assert from 'node:assert/strict';
import { it } from 'node:test';
import { assetReferenceCandidates, explicitEntityAssetReferences, primaryEntityAsset } from '../packages/view-workspace-core/src/asset-references.ts';
import { inspectorEntityFromInspection } from '../packages/view-plugin-inspector/src/inspection.ts';
import { nativeCloudAssets, nativeCloudInspection } from './support/inspector-native-cloud.fixture.mjs';

const meshGuid = '11111111-1111-4111-8111-111111111111';
const materialGuid = '22222222-2222-4222-8222-222222222222';
const overrideGuid = '33333333-3333-4333-8333-333333333333';
it('scene shortcuts require one declared primary, including unresolved primary references', () => {
  const assets = [{ guid: meshGuid, kind: 'mesh' }, { guid: materialGuid, kind: 'material' }];
  const mesh = { key: 'MeshFilter.assetHandle', primary: true, status: 'resolved', guid: meshGuid };
  const material = { key: 'MeshRenderer.materials[0]', status: 'resolved', guid: materialGuid };
  assert.equal(primaryEntityAsset([mesh, material], assets), assets[0]);
  assert.equal(primaryEntityAsset([material], assets), undefined);
  assert.equal(primaryEntityAsset([mesh, { ...material, primary: true }], assets), undefined);
  assert.equal(primaryEntityAsset([mesh, { key: 'AudioSource.clip', primary: true, status: 'unregistered' }], assets), undefined);
  assert.equal(primaryEntityAsset([{ ...mesh, status: 'missing' }], assets), undefined);
  assert.equal(primaryEntityAsset([mesh], []), undefined);
  assert.equal(primaryEntityAsset([], assets), undefined);
});
it('UI projection joins only returned identities and retains raw component fields', () => {
  const asset = { guid: meshGuid, kind: 'mesh', sourceKey: 'mesh/box' };
  const inspection = { entityId: 'scene:world:1', targetId: 'scene', components: [{ name: 'MeshFilter', fields: { assetHandle: { type: 'asset<mesh>' } }, values: { assetHandle: 1025 } }] };
  const bindings = { entityId: inspection.entityId, targetId: inspection.targetId, references: [{ key: 'MeshFilter.assetHandle', component: 'MeshFilter', field: 'assetHandle', guid: meshGuid, status: 'resolved', origin: 'component' }] };
  const source = inspectorEntityFromInspection(inspection, [asset], {}, bindings);
  assert.equal(source.meshReference.guid, meshGuid);
  assert.equal(source.meshReference.handle, 1025);
  assert.equal(source.raw, inspection);
  assert.equal(inspectorEntityFromInspection(inspection, [asset], {}, { ...bindings, entityId: 'wrong' }).meshReference.guid, undefined);
  assert.deepEqual(assetReferenceCandidates(bindings.references, []), []);
  assert.deepEqual(explicitEntityAssetReferences(inspection), []);
});

it('reads explicit GUIDs from managed asset schemas without treating shared game state as assets', () => {
  const inspection = { entityId: 'scene:world:1', components: [
    { name: 'MeshFilter', fields: { assetHandle: { type: 'asset<mesh>' } }, values: { assetHandle: meshGuid } },
    { name: 'MeshRenderer', fields: { materials: { type: 'array<asset<material>>' } }, values: { materials: [materialGuid, 1026, { guid: overrideGuid }] } },
    { name: 'Diagnostic', fields: { state: { type: 'shared<DiagnosticState>' }, text: { type: 'string' } }, values: { state: meshGuid, text: materialGuid } },
  ] };
  assert.deepEqual(explicitEntityAssetReferences(inspection).map(({ key, guid }) => ({ key, guid })), [
    { key: 'MeshFilter.assetHandle', guid: meshGuid },
    { key: 'MeshRenderer.materials[0]', guid: materialGuid },
    { key: 'MeshRenderer.materials[2]', guid: overrideGuid },
  ]);
});

it('projects native Play material references from the same inspection without a Scene reference session', () => {
  const source = inspectorEntityFromInspection(nativeCloudInspection, nativeCloudAssets);
  assert.equal(source.raw, nativeCloudInspection);
  const fields = source.components[0].fields;
  for (const [index, key] of ['material', 'materialInstance'].entries()) {
    const field = fields.find(field => field.key === key);
    assert.equal(field.rawValue, nativeCloudInspection.components[0].values[key]);
    assert.equal(field.resource.guid, nativeCloudAssets[index].guid);
    assert.equal(field.resource.asset, nativeCloudAssets[index]);
    assert.equal(field.resource.status, 'resolved');
  }
  assert.equal(source.assetReferencesTruncated, false);
});

it('keeps atomic native facts authoritative over stale external bindings and preserves missing Catalog identities', () => {
  const stale = { entityId: nativeCloudInspection.entityId, targetId: nativeCloudInspection.targetId,
    references: [{ ...nativeCloudInspection.assetReferences.references[0], guid: materialGuid }], truncated: true };
  const source = inspectorEntityFromInspection(nativeCloudInspection, nativeCloudAssets, {}, stale);
  assert.equal(source.components[0].fields[0].resource.guid, nativeCloudAssets[0].guid);
  assert.equal(source.assetReferencesTruncated, false);
  const missing = inspectorEntityFromInspection(nativeCloudInspection, []);
  assert.equal(missing.components[0].fields[0].resource.guid, nativeCloudAssets[0].guid);
  assert.equal(missing.components[0].fields[0].resource.status, 'missing');
  assert.equal(missing.components[0].fields[0].resource.asset, undefined);
});
