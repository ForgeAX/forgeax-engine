import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AssetRegistry, assetsPlugin } from '@forgeax/engine/assets-runtime';
import { World, createWorldContext, defineComponent } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { createToolApiPlugin } from '@forgeax/engine/plugin';
import { MeshFilter, MeshRenderer, Materials } from '@forgeax/engine/render';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { engineWorkspaceTargetToolsPlugin } from '@forgeax/engine/app';
import queryPlugin, { queryEntityAssetReferences } from '../packages/view-plugin-asset-references/src/runtime/query.ts';
import { assetReferenceCandidates, explicitEntityAssetReferences, primaryEntityAsset, ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE } from '../packages/view-workspace-core/src/asset-references.ts';
import { inspectorEntityFromInspection, inspectorFieldMatches } from '../packages/view-plugin-inspector/src/inspection.ts';

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
async function fixture(t) {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const ctx = await createWorldContext(world, [assetsPlugin(assets), createToolApiPlugin()]);
  const tools = ctx.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'scene' });
  await tools.await();
  const leases = [MeshFilter, MeshRenderer].map(component => world.components.register(component).unwrap());
  const grants = [];
  const entities = [];
  const allocate = (type, payload) => { const handle = world.allocSharedRef(type, payload); grants.push(handle); return handle; };
  const spawn = (...entries) => { const entity = world.spawn(...entries).unwrap(); entities.push(entity); return entity; };
  const scope = { projectId: 'project', targetId: 'scene', targetGeneration: 1, browserGeneration: 1, worldId: world.identity };
  const inspect = entity => ctx.engineWorkspaceTargetTools.inspect({ entityId: `scene:${world.identity}:${entity}` });
  const query = entity => queryEntityAssetReferences(ctx, scope, { ...scope, entityId: `scene:${world.identity}:${entity}` });
  t.after(async () => { for (const entity of entities) world.despawn(entity).unwrap(); for (const handle of grants) world.sharedRefs.release(handle).unwrap(); for (const lease of leases.reverse()) lease.dispose(); await ctx.fiber.dispose(); });
  return { ctx, world, assets, scope, leases, allocate, spawn, inspect, query };
}

it('reads actual held mesh and default material identities without changing entities', async t => {
  const f = await fixture(t);
  const material = f.assets.catalog(materialGuid, Materials.unlit([1, 0, 0, 1])).unwrap();
  const mesh = f.assets.catalog(meshGuid, { ...createBoxGeometry(1, 1, 1).unwrap(), materialSlots: [
    { slotName: 'Surface', defaultMaterial: f.assets.parseGuid(materialGuid) }, { slotName: 'Engine default' },
  ] }).unwrap();
  const handle = f.allocate('MeshAsset', mesh);
  const entity = f.spawn({ component: MeshFilter, data: { assetHandle: handle } }, { component: MeshRenderer, data: { materials: [] } });
  const epoch = f.world.getStructureEpoch();
  const before = await f.inspect(entity);
  const result = await f.query(entity);
  assert.equal(result.references.find(ref => ref.key === 'MeshFilter.assetHandle').guid, meshGuid);
  assert.equal(result.references.find(ref => ref.slotName === 'Surface').guid, materialGuid);
  assert.equal(result.references.find(ref => ref.slotName === 'Engine default').origin, 'engine-default');
  assert.equal(f.world.getStructureEpoch(), epoch);
  assert.deepEqual((await f.inspect(entity)).components, before.components);
  assert.equal(f.assets.guidOf(material), materialGuid);
});

it('preserves old held publication identity and prefers a nonzero instance material', async t => {
  const f = await fixture(t);
  f.assets.catalog(materialGuid, Materials.unlit([1, 0, 0, 1])).unwrap();
  const override = f.assets.catalog(overrideGuid, Materials.unlit([0, 1, 0, 1])).unwrap();
  const old = f.assets.catalog(meshGuid, { ...createBoxGeometry(1, 1, 1).unwrap(), materialSlots: [{ slotName: 'Surface', defaultMaterial: f.assets.parseGuid(materialGuid) }] }).unwrap();
  const handle = f.allocate('MeshAsset', old);
  const materialHandle = f.allocate('MaterialAsset', override);
  const entity = f.spawn({ component: MeshFilter, data: { assetHandle: handle } }, { component: MeshRenderer, data: { materials: [materialHandle] } });
  f.assets.catalog(meshGuid, createBoxGeometry(4, 4, 4).unwrap()).unwrap();
  const result = await f.query(entity);
  assert.equal(result.references.find(ref => ref.key === 'MeshFilter.assetHandle').guid, meshGuid);
  const material = result.references.find(ref => ref.key === 'MeshRenderer.materials[0]');
  assert.equal(material.guid, overrideGuid);
  assert.equal(material.origin, 'component');
  assert.equal(material.slotName, 'Surface');
});

it('reports builtin, unregistered and stale handles without guessing Catalog identity', async t => {
  const f = await fixture(t);
  const handles = [1, f.allocate('MeshAsset', createBoxGeometry(1, 1, 1).unwrap())];
  for (const [index, handle] of handles.entries()) {
    const entity = f.spawn({ component: MeshFilter, data: { assetHandle: handle } });
    assert.equal((await f.query(entity)).references.find(ref => ref.component === 'MeshFilter').status, index ? 'unregistered' : 'builtin');
  }
  await assert.rejects(() => queryEntityAssetReferences(f.ctx, f.scope, { ...f.scope, worldId: 'wrong', entityId: 'scene:wrong:1' }), /stale/);
});

it('recognizes custom shared reference arrays and excludes ordinary strings and entity arrays', async t => {
  const f = await fixture(t);
  const component = defineComponent('ViewReferenceTest', { clips: 'array<shared<MeshAsset>>', text: 'string', joints: 'array<entity>', state: 'shared<DiagnosticState>' });
  const lease = f.world.components.register(component).unwrap();
  f.leases.push(lease);
  const payload = f.assets.catalog(meshGuid, createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const handle = f.allocate('MeshAsset', payload);
  const state = f.allocate('DiagnosticState', { count: 1 });
  const entity = f.spawn({ component, data: { clips: Array(132).fill(handle), text: meshGuid, joints: [], state } });
  const result = await f.query(entity);
  assert.equal(result.references.length, 128);
  assert.equal(result.truncated, true);
  assert(result.references.every(ref => ref.field === 'clips' && ref.guid === meshGuid));
  const projected = inspectorEntityFromInspection(await f.inspect(entity), [{ guid: meshGuid, kind: 'mesh', sourceKey: 'mesh/box' }], {}, result);
  const field = projected.components.find(entry => entry.name === component.name).fields.find(field => field.key === 'clips');
  assert.equal(field.resources.length, 128);
  assert.equal(inspectorFieldMatches(field, 'box'), true);
});

it('native Fiber withdrawal removes its ToolApi provider and restoration re-registers it', async t => {
  const f = await fixture(t);
  const plugin = f.ctx.plugin(queryPlugin, { ...f.scope, providerId: 'references' });
  await plugin.await();
  assert(f.ctx.toolApi.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE).some(record => record.callable));
  await plugin.dispose();
  assert(!f.ctx.toolApi.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE).some(record => record.callable));
  const restored = f.ctx.plugin(queryPlugin, { ...f.scope, providerId: 'restored' });
  await restored.await();
  assert(f.ctx.toolApi.describe(ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE).some(record => record.callable && record.owner.providerId === 'restored'));
});

it('UI projection joins only returned identities and retains raw component fields', () => {
  const asset = { guid: meshGuid, kind: 'mesh', sourceKey: 'mesh/box' };
  const inspection = { entityId: 'scene:world:1', targetId: 'scene', components: [{ name: 'MeshFilter', fields: { assetHandle: { type: 'shared<MeshAsset>' } }, values: { assetHandle: 1025 } }] };
  const bindings = { entityId: inspection.entityId, targetId: inspection.targetId, references: [{ key: 'MeshFilter.assetHandle', component: 'MeshFilter', field: 'assetHandle', guid: meshGuid, status: 'resolved', origin: 'component' }] };
  const source = inspectorEntityFromInspection(inspection, [asset], {}, bindings);
  assert.equal(source.meshReference.guid, meshGuid);
  assert.equal(source.meshReference.handle, 1025);
  assert.equal(source.raw, inspection);
  assert.equal(inspectorEntityFromInspection(inspection, [asset], {}, { ...bindings, entityId: 'wrong' }).meshReference.guid, undefined);
  assert.deepEqual(assetReferenceCandidates(bindings.references, []), []);
  assert.deepEqual(explicitEntityAssetReferences(inspection), []);
});
