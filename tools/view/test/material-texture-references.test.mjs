import assert from 'node:assert/strict';
import { it } from 'node:test';
import { materialTextureReferences, materialReferenceScope, materialThumbnailScope } from '../packages/view-plugin-material/src/texture-references.ts';
import { createWorkspaceObservation } from '../packages/view-workspace-core/src/workspace-state.ts';
import { observeAssetThumbnails } from '../packages/view-workspace-core/src/asset-thumbnails.ts';

const asset = { guid: 'material', kind: 'material', name: 'Ground' };
const output = (guid, refs, kind = 'material') => ({ guid, kind, refs });
const publication = { generation: 1, digest: 'bound', outputs: [output('sibling', ['sibling-texture']), output('material', ['base', 'sampler', 'normal', 'BASE', 'missing', 'env'])] };
const textures = [{ guid: 'base', kind: 'texture', publicationId: 'base-v1' }, { guid: 'normal', kind: 'texture' }, { guid: 'env', kind: 'equirect' },
  { guid: 'sampler', kind: 'sampler' }, { guid: 'sibling-texture', kind: 'texture' }];
const preview = { asset, target: { targetId: 'material-preview', generation: 4, worldId: 'world' }, assetBinding: { publication, meta: { kind: 'material' } } };
const state = { project: { id: 'project', root: '/project' }, projectTarget: { targetId: 'project-target', generation: 1 },
  browserGeneration: 1, catalogEpoch: 1, thumbnailEpoch: 1, previews: [preview], resourceOpens: { material: { asset, preview } }, assets: [asset, ...textures] };
const withPreview = p => ({ ...state, previews: [p], resourceOpens: { material: { asset: p.asset, preview: p } } });

it('selects only the bound material output, deduplicates GUIDs in source order and filters explicit kinds', () => {
  const result = materialTextureReferences(state);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.textures.map(asset => asset.guid), ['base', 'normal', 'env']);
  assert.deepEqual(result.unresolved, ['missing']);
});

it('retains the bound publication instead of newer inspection facts', () => {
  const inspected = { guid: 'material', publication: { outputs: [output('material', ['sibling-texture'])] } };
  assert.equal(materialTextureReferences(state, inspected).textures[0].guid, 'base');
  assert.equal(materialTextureReferences(withPreview({ ...preview, assetBinding: { meta: { kind: 'material' } } }), inspected).status, 'unavailable');
  const unbound = withPreview({ ...preview, assetBinding: undefined });
  assert.deepEqual(materialTextureReferences(unbound, inspected).textures.map(asset => asset.guid), ['sibling-texture']);
  assert.equal(materialTextureReferences(unbound, { ...inspected, guid: 'another' }).status, 'unavailable');
  assert.equal(materialTextureReferences(unbound, { guid: 'material', source: { publication: inspected.publication } }).textures.length, 1);
});

it('distinguishes empty refs, unavailable publication and ambiguous or missing material outputs', () => {
  for (const outputs of [[], [output('other', ['base'])], [output('material', ['base']), output('material', ['normal'])], [output('material', [], 'mesh')]]) {
    assert.equal(materialTextureReferences(withPreview({ ...preview, assetBinding: { publication: { outputs } } })).status, 'unavailable');
  }
  const empty = materialTextureReferences(withPreview({ ...preview, assetBinding: { publication: { outputs: [output('material', ['sampler'])] } } }));
  assert.deepEqual(empty, { status: 'ready', textures: [], unresolved: [] });
  assert.equal(materialTextureReferences(null).status, 'unavailable');
  assert.equal(materialTextureReferences(withPreview({ ...preview, assetBinding: { publication: { generation: 1, digest: 'legacy' } } })).status, 'unavailable');
});

it('fences project, browser, target, catalog and same-GUID publication replacements', () => {
  const scope = materialReferenceScope(state);
  for (const next of [{ ...state, project: { ...state.project, root: '/other' } }, { ...state, browserGeneration: 2 },
    { ...state, catalogEpoch: 2 }, { ...state, projectTarget: { ...state.projectTarget, generation: 2 } },
    withPreview({ ...preview, target: { ...preview.target, generation: 5 } }),
    withPreview({ ...preview, assetBinding: { ...preview.assetBinding, publication: { ...publication, digest: 'new' } } }),
    withPreview({ ...preview, asset: { ...asset, guid: 'another' } }),
  ]) assert.notEqual(materialReferenceScope(next), scope);
  assert.equal(materialReferenceScope({ ...state, workspaceTargetLost: true }), null);
  assert.notEqual(materialThumbnailScope(state, ['base']), materialThumbnailScope({ ...state, assets: textures.map(asset => ({ ...asset, publicationId: 'v2' })) }, ['base']));
});

function observable(initial = state) {
  let current = initial;
  const listeners = new Set();
  return { getSnapshot: () => current, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(next) { current = next; for (const fn of listeners) fn(); }, get listeners() { return listeners.size; } };
}

it('synchronously revokes an obsolete fallback inspection lease', () => {
  const reader = observable();
  const scope = materialReferenceScope(state);
  const observation = createWorkspaceObservation(reader, next => materialReferenceScope(next) === scope);
  reader.update({ ...state, browserGeneration: 2 });
  assert.equal(observation.signal.aborted, true);
  assert.equal(reader.listeners, 0);
});

it('delegates deduplicated batches of at most 32 and refreshes unfinished thumbnails on epochs', async () => {
  const assets = Array.from({ length: 65 }, (_, index) => ({ guid: `texture-${index}`, kind: 'texture' }));
  const reader = observable({ ...state, assets });
  const guids = [...assets.map(asset => asset.guid), 'texture-0'];
  const calls = [], published = [];
  let ready = false;
  const observation = observeAssetThumbnails({ reader, guids, scope: materialThumbnailScope(reader.getSnapshot(), guids), getScope: materialThumbnailScope,
    client: { async call(operation, args) { calls.push(args.guids); return { thumbnails: args.guids.map(guid => ({ guid, state: ready ? 'ready' : 'queued' })) }; } },
    publish: rows => published.push(rows) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(batch => batch.length), [32, 32, 1]);
  ready = true;
  reader.update({ ...reader.getSnapshot(), thumbnailEpoch: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.at(-1).size, 65);
  assert([...published.at(-1).values()].every(row => row.state === 'ready'));
  const count = calls.length;
  reader.update({ ...reader.getSnapshot(), thumbnailEpoch: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, count);
  observation.dispose();
  assert.equal(reader.listeners, 0);
});

it('rejects late thumbnail responses after invalidation or hidden-panel disposal', async () => {
  for (const hide of [false, true]) {
    const reader = observable(), rows = [];
    let finish, signal;
    const observation = observeAssetThumbnails({ reader, guids: ['base'], scope: materialThumbnailScope(state, ['base']), getScope: materialThumbnailScope,
      client: { call(_operation, _args, options) { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } }, publish: next => rows.push(next) });
    if (hide) observation.dispose(); else reader.update({ ...state, browserGeneration: 2 });
    assert(signal.aborted);
    finish({ thumbnails: [{ guid: 'base', state: 'ready', publicationId: 'base-v1', dataUrl: 'late' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert(rows.every(row => row.size === 0));
    assert.equal(reader.listeners, 0);
  }
});
