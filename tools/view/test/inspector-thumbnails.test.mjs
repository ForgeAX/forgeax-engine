import assert from 'node:assert/strict';
import { it } from 'node:test';
import { inspectorEntityFromInspection } from '../packages/view-plugin-inspector/src/inspection.ts';
import { inspectorThumbnailGuids, inspectorThumbnailScope, observeInspectorThumbnails } from '../packages/view-plugin-inspector/src/thumbnails.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(count = 1, initialResponse = args => ({ thumbnails: args.guids.map(guid => ({ guid, state: 'ready', dataUrl: 'data:image/png;base64,png' })) })) {
  let state = { project: { id: 'project', root: '/project' }, projectTarget: { targetId: 'project-target', generation: 1 },
    preview: { target: { targetId: 'scene', generation: 2 } }, browserGeneration: 1, catalogEpoch: 1, thumbnailEpoch: 0,
    sceneSelection: { primary: { entityId: 'entity' } },
    assets: Array.from({ length: count }, (_, index) => ({ guid: `asset-${index}`, kind: 'mesh', lifecycle: 'current' })) };
  const listeners = new Set();
  const reader = { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const guids = state.assets.map(asset => asset.guid);
  const calls = [], publications = [];
  let respond = initialResponse;
  const observation = observeInspectorThumbnails({ guids, reader, scope: inspectorThumbnailScope(state, guids),
    client: { async call(operation, args, options) { calls.push({ operation, args, signal: options.signal }); return respond(args); } },
    publish: rows => publications.push(rows) });
  return { observation, calls, publications, reader, guids,
    respond(next) { respond = next; },
    update(next) { state = { ...state, ...next }; for (const listener of listeners) listener(); },
    get state() { return state; }, get listeners() { return listeners.size; } };
}

it('collects and deduplicates every resolved reference, excluding opaque handles and missing assets', () => {
  const assets = ['mesh', 'material', 'texture', 'audio'].map(kind => ({ guid: kind, kind }));
  const source = inspectorEntityFromInspection({ entityId: 'entity', components: [
    { name: 'MeshFilter', fields: { assetHandle: { type: 'asset<mesh>' } }, values: { assetHandle: 'mesh' } },
    { name: 'MeshRenderer', fields: { materials: { type: 'array<asset<material>>' } }, values: { materials: ['material', 'material', 0] } },
    { name: 'Custom', fields: { maps: { type: 'array<asset<texture>>' }, clip: { type: 'asset<audio>' }, missing: { type: 'AssetRef' } },
      values: { maps: ['texture', 1028], clip: 'audio', missing: { guid: 'removed' } } },
  ] }, assets);
  assert.deepEqual(inspectorThumbnailGuids(source), ['audio', 'material', 'mesh', 'texture']);
});

it('batches 32 unique GUIDs and addresses the exact project target rather than the Scene preview', async () => {
  const f = fixture(65);
  await settle();
  assert.deepEqual(f.calls.map(call => call.args.guids.length), [32, 32, 1]);
  assert(f.calls.every(call => call.operation === 'assets.thumbnails' && call.args.targetId === 'project-target'));
  assert.equal(f.publications.at(-1).size, 65);
  f.observation.dispose();
  assert.equal(f.listeners, 0);
});

it('refreshes pending rows on thumbnailEpoch without rereading ready results', async () => {
  let epoch = 0;
  const f = fixture(2, args => ({ thumbnails: args.guids.map(guid => ({ guid,
    state: epoch === 0 && guid === 'asset-0' ? 'cooking' : 'ready' })) }));
  await settle(); f.update({ thumbnailEpoch: ++epoch }); await settle();
  assert.deepEqual(f.calls.map(call => call.args.guids), [['asset-0', 'asset-1'], ['asset-0']]);
  assert.equal(f.publications.at(-1).get('asset-0').state, 'ready');
  f.update({ thumbnailEpoch: ++epoch }); await settle();
  assert.equal(f.calls.length, 2);
  f.observation.dispose();
});

for (const [name, change] of [
  ['entity', state => ({ sceneSelection: { primary: { entityId: 'other' } } })],
  ['project', state => ({ project: { ...state.project, id: 'other' } })],
  ['target', state => ({ preview: { target: { targetId: 'scene', generation: 3 } } })],
  ['browser', state => ({ browserGeneration: 2 })],
  ['catalog', state => ({ catalogEpoch: 2 })],
  ['publication', state => ({ assets: [{ ...state.assets[0], publicationId: 'new' }] })],
]) it(`synchronously revokes the old ${name} read and ignores its late response`, async () => {
  const f = fixture(33);
  let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  await settle();
  assert.equal(f.calls.length, 2);
  const previous = f.calls[1];
  f.update(change(f.state));
  assert.equal(previous.signal.aborted, true);
  assert.equal(f.listeners, 0);
  assert.equal(f.publications.at(-1).size, 0);
  finish({ thumbnails: [{ guid: 'asset-32', state: 'ready', dataUrl: 'old' }] });
  await settle();
  assert.equal(f.publications.at(-1).size, 0);
});

it('disposal releases a pending read without publishing a late image', async () => {
  const f = fixture(33);
  let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  await settle();
  const count = f.publications.length;
  f.observation.dispose();
  assert(f.calls.every(call => call.signal.aborted));
  finish({ thumbnails: [{ guid: 'asset-32', state: 'ready' }] }); await settle();
  assert.equal(f.publications.length, count);
});

it('reports query failures without retry loops or disabling asset navigation', async () => {
  const f = fixture(33);
  f.respond(() => { throw new Error('preview unavailable'); });
  await settle();
  assert.equal(f.publications.at(-1).get('asset-32').state, 'failed');
  f.update({ thumbnailEpoch: 3 }); await settle();
  assert.equal(f.calls.length, 2);
  f.observation.dispose();
});
