import assert from 'node:assert/strict';
import { it } from 'node:test';
import { meshMaterialScope, meshThumbnailScope, readMeshMaterialReferences } from '../packages/view-plugin-mesh/src/material-slots.ts';
import { createWorkspaceObservation } from '../packages/view-workspace-core/src/workspace-state.ts';

const asset = { guid: 'mesh', kind: 'mesh', name: 'Mesh' };
const target = { targetId: 'mesh-preview', generation: 4, worldId: 'world' };
const materialSlots = [{ slotName: 'Body', defaultMaterial: 53 }, { slotName: 'Trim', defaultMaterial: 54 }, { slotName: 'Default' }];
const preview = { target, asset, assetBinding: { publication: { generation: 1, digest: 'old' }, meta: { kind: 'mesh', materialSlots } } };
const state = { project: { id: 'project', root: '/project' }, projectTarget: { targetId: 'project-target', generation: 1 },
  previews: [preview], resourceOpens: { mesh: { asset, preview } }, browserGeneration: 1, catalogEpoch: 1,
  assets: [{ guid: 'material', kind: 'material', publicationId: 'one' }] };
const meshReference = { component: 'MeshFilter', field: 'assetHandle', kind: 'mesh', status: 'resolved', guid: 'mesh' };
const material = (index, handle, guid = 'material') => ({ component: 'MeshRenderer', field: 'materials', kind: 'material', status: 'resolved', guid, index, handle });
const node = entityId => ({ entityId, componentNames: ['MeshFilter', 'MeshRenderer'] });
const inspection = (entityId, references) => ({ targetId: target.targetId, worldId: 'world', entityId, assetReferences: { references, truncated: false } });
function client({ pages, inspections }) {
  const calls = [];
  return { calls, async call(operation, args, options) {
    calls.push({ operation, args, signal: options.signal });
    if (operation === 'scene.tree.get') return { targetId: target.targetId, worldId: 'world', revision: 9, nextOffset: null, ...pages[args.offset] };
    return inspections[args.entityId];
  } };
}

it('uses the exact preview and native GUID, preserving repeated materials and builtin slots', async () => {
  const c = client({ pages: { 0: { nodes: [node('helper'), node('mesh-entity')] } }, inspections: {
    helper: inspection('helper', [{ ...meshReference, guid: 'wireframe-helper' }, material(0, 90, 'helper-material')]),
    'mesh-entity': inspection('mesh-entity', [meshReference, material(0, 53), material(1, 54),
      { ...material(2, 0), guid: undefined, status: 'builtin', origin: 'engine-default' }]),
  } });
  const result = await readMeshMaterialReferences(c, state, new AbortController().signal);
  assert.deepEqual(result.references.map(row => [row.index, row.guid, row.status]), [[0, 'material', 'resolved'], [1, 'material', 'resolved'], [2, undefined, 'builtin']]);
  assert(c.calls.every(call => call.args.targetId === target.targetId && call.args.targetGeneration === 4));
  assert.equal(c.calls.some(call => call.operation === 'asset.open' || call.operation === 'scene.select'), false);
});

it('paginates with the returned revision and excludes mismatched bound material handles', async () => {
  const c = client({ pages: { 0: { nodes: [], nextOffset: 50 }, 50: { nodes: [node('entity')] } },
    inspections: { entity: inspection('entity', [meshReference, material(0, 999), material(1, 54), material(200, 54)]) } });
  const result = await readMeshMaterialReferences(c, state, new AbortController().signal);
  assert.equal(c.calls[1].args.revision, 9);
  assert.deepEqual(result.references.map(row => row.index), [1]);
});

it('does not map a wireframe entity to the opened mesh or choose an ambiguous matching entity', async () => {
  const c = client({ pages: { 0: { nodes: [node('entity')] } }, inspections: {
    entity: inspection('entity', [{ ...meshReference, guid: 'wireframe' }, material(0, 53)]),
  } });
  await assert.rejects(readMeshMaterialReferences(c, state, new AbortController().signal), /references-unavailable/);
  const ambiguous = client({ pages: { 0: { nodes: [node('a'), node('b')] } }, inspections: {
    a: inspection('a', [meshReference]), b: inspection('b', [meshReference]),
  } });
  await assert.rejects(readMeshMaterialReferences(ambiguous, state, new AbortController().signal), /ambiguous/);
});

it('preserves truncation, stale and unregistered reference facts without inventing GUIDs', async () => {
  const value = inspection('entity', [meshReference, { ...material(0, 53), status: 'stale', guid: undefined },
    { ...material(1, 54), status: 'unregistered', guid: undefined }]);
  value.assetReferences.truncated = true;
  const c = client({ pages: { 0: { nodes: [node('entity')] } }, inspections: { entity: value } });
  const result = await readMeshMaterialReferences(c, state, new AbortController().signal);
  assert.equal(result.truncated, true);
  assert(result.references.every(row => !row.guid));
});

it('rejects mismatched worlds and non-advancing tree pages', async () => {
  for (const page of [{ worldId: 'wrong', nodes: [] }, { nodes: [], nextOffset: 0 }]) {
    await assert.rejects(readMeshMaterialReferences(client({ pages: { 0: page }, inspections: {} }), state, new AbortController().signal));
  }
});

it('fences bound generation/content, project, browser and catalog changes', () => {
  const scope = meshMaterialScope(state);
  for (const update of [{ browserGeneration: 2 }, { catalogEpoch: 2 }, { project: { ...state.project, id: 'other' } },
    { previews: [{ ...preview, target: { ...target, generation: 5 } }], resourceOpens: { mesh: { asset, preview: { ...preview, target: { ...target, generation: 5 } } } } },
    { previews: [{ ...preview, assetBinding: { ...preview.assetBinding, publication: { generation: 2, digest: 'new' } } }] },
  ]) assert.notEqual(meshMaterialScope({ ...state, ...update }), scope);
  assert.notEqual(meshThumbnailScope(state, ['material']), meshThumbnailScope({ ...state, assets: [{ ...state.assets[0], publicationId: 'two' }] }, ['material']));
  assert.equal(meshMaterialScope({ ...state, previews: [] }), null);
});

it('synchronously cancels an obsolete preview query and rejects its late result', async () => {
  let current = state, finish;
  const listeners = new Set();
  const reader = { getSnapshot: () => current, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const scope = meshMaterialScope(state);
  const observation = createWorkspaceObservation(reader, value => meshMaterialScope(value) === scope);
  const promise = readMeshMaterialReferences({ call: () => new Promise(resolve => { finish = resolve; }) }, state, observation.signal);
  current = { ...state, browserGeneration: 2 };
  for (const listener of listeners) listener();
  assert(observation.signal.aborted);
  finish({ targetId: target.targetId, worldId: 'world', revision: 9, nodes: [], nextOffset: null });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(listeners.size, 0);
});
