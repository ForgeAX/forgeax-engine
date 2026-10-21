import assert from 'node:assert/strict';
import { it } from 'node:test';
import { WorkspaceFixture, transactionPreview } from './support/workspace-owner.mjs';

function fixture() {
  let count = 0;
  let browser = 1;
  let unblock;
  let fail = false;
  const assets = ['a', 'b'].map(guid => ({ guid, kind: 'mesh', previewable: true }));
  const broker = new WorkspaceFixture({ engine: {
    openProject: async () => ({ get browserGeneration() { return browser; }, project: { id: 'project', root: '/project', name: 'Test' }, target: { targetId: 'editor', sessionId: 'session', worldId: 'world', width: 100, height: 100, headed: true } }),
    closeProject: async () => {}, listAssets: async () => assets,
    openPreview: async ({ asset }) => {
      const id = ++count;
      if (unblock) await new Promise(resolve => { unblock.resolve = resolve; });
      if (fail) throw new Error('preview preparation failed');
      return { ...await transactionPreview({ asset, camera: { position: [0,0,5], target: [0,0,0], up: [0,1,0] }, target: { targetId: `preview-${id}`, sessionId: 'session', worldId: `world-${id}`, width: 100, height: 100, headed: true } }), assetBinding: { kind: 'mesh', guid: asset.guid, meta: { marker: id } }, close: async () => {} };
    },
  } });
  const args = guid => ({ projectId: 'project', guid });
  return { broker, args, reload() { browser++; broker.snapshot(); }, get count() { return count; }, block() { unblock = {}; return () => { unblock.resolve(); unblock = undefined; }; }, fail() { fail = true; } };
}

it('reuses one live preview and its binding for repeated and concurrent opens', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  const release = f.block();
  const first = f.broker.openAsset(f.args('a'));
  const second = f.broker.openAsset(f.args('a'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.snapshot().openRequest.phase, 'opening');
  release();
  await Promise.all([first, second]);
  const target = f.broker.snapshot().resourceOpens.mesh.preview.target;
  await f.broker.openAsset(f.args('a'));
  assert.equal(f.count, 1);
  assert.deepEqual(f.broker.snapshot().resourceOpens.mesh.preview.target, target);
  assert.equal(f.broker.engine.previews[0].assetBinding.meta.marker, 1);
  assert.equal(f.broker.snapshot().resourceOpens.mesh.preview.assetBinding.meta.marker, 1);
  await f.broker.dispose();
});

it('accepts the exact Scene generation when its target ID also identifies the project', async () => {
  const broker = new WorkspaceFixture({ engine: {
    openProject: async () => ({ project: { id: 'project', root: '/project' }, target: { targetId: 'editor', sessionId: 'session', worldId: 'world', width: 100, height: 100, headed: true } }),
    closeProject: async () => {},
    listAssets: async () => [{guid:'scene',kind:'scene'},{guid:'mesh',kind:'mesh'}],
    openPreview: async ({asset}) => transactionPreview({asset, target:{targetId:asset.kind === 'scene' ? 'editor' : 'resource',sessionId:'session',worldId:'world',width:100,height:100,headed:true}}),
  }});
  try {
    await broker.openProject({root:'/project'});
    await broker.listAssets({projectId:'project'});
    await broker.openAsset({projectId:'project',guid:'scene'});
    const scene = broker.snapshot().scenePreview.target;
    assert.notEqual(scene.generation,broker.snapshot().projectTarget.generation);
    await broker.openAsset({projectId:'project',guid:'mesh',targetId:scene.targetId,targetGeneration:scene.generation});
    assert.equal(broker.snapshot().resourceOpens.mesh.preview.target.targetId,'resource');
    await assert.rejects(broker.openAsset({projectId:'project',guid:'mesh',targetId:scene.targetId,targetGeneration:999}), /generation/);
  } finally { await broker.dispose(); }
});

it('preserves the previous resource binding when replacement fails', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  await f.broker.openAsset(f.args('a'));
  const previous = f.broker.snapshot().resourceOpens.mesh;
  f.fail();
  await assert.rejects(f.broker.openAsset(f.args('b')), /preview preparation failed/);
  const { pending, ...retained } = f.broker.snapshot().resourceOpens.mesh;
  assert.deepEqual(retained, previous);
  assert.equal(pending.phase, 'failed');
  assert.equal(f.broker.snapshot().openRequest.phase, 'failed');
  await f.broker.dispose();
});

it('checks current Engine publication before reusing a live preview without a catalog epoch event', async () => {
  let generation=1, count=0, inspections=0;
  const asset={guid:'published',kind:'mesh',previewable:true};
  const publication=()=>({schemaVersion:'asset-publication/1',sourcePath:'fixture.pack',sourceRevision:`source-${generation}`,
    generation,digest:`digest-${generation}`,outputSetDigest:`outputs-${generation}`});
  const runtimePublication=publication();
  const broker=new WorkspaceFixture({engine:{
    openProject:async()=>({project:{id:'project',root:'/project'},target:{targetId:'editor',sessionId:'session',worldId:'world',width:100,height:100,headed:true}}),
    closeProject:async()=>{},listAssets:async()=>[asset],
    inspectAsset:async()=>{inspections++;return{guid:asset.guid,asset,
      publication:runtimePublication,source:{publication:publication()}};},
    openPreview:async()=>({
      ...await transactionPreview({asset,target:{targetId:`preview-${++count}`,sessionId:'session',worldId:`world-${count}`,width:100,height:100,headed:true}}),
      assetBinding:{publication:publication()},
    }),
  }});
  try {
    await broker.openProject({root:'/project'});
    await broker.listAssets({projectId:'project'});
    await broker.openAsset({projectId:'project',guid:asset.guid});
    const first=broker.snapshot().resourceOpens.mesh.preview;
    await broker.openAsset({projectId:'project',guid:asset.guid});
    assert.equal(count,1);
    assert.equal(inspections,1);
    assert.equal(broker.snapshot().inspection.publication.digest,'digest-1');
    const epoch=broker.catalogEpoch;
    generation=2;
    await broker.openAsset({projectId:'project',guid:asset.guid});
    const next=broker.snapshot().resourceOpens.mesh.preview;
    assert.equal(broker.catalogEpoch,epoch);
    assert.equal(count,2);
    assert.equal(broker.snapshot().inspection.publication.digest,'digest-1');
    assert.equal(broker.snapshot().inspection.source.publication.digest,'digest-2');
    assert.notEqual(next.target.targetId,first.target.targetId);
    assert.equal(next.assetBinding.publication.digest,'digest-2');
    assert.equal(first.assetBinding.publication.digest,'digest-1');
  } finally { await broker.dispose(); }
});

import { createResourcePageController } from '../packages/view-workspace-core/src/resource-page-controller.ts';

function pageFixture() {
  let state;
  const listeners = new Set();
  const events = [];
  const live = new Map();
  const closedTargets = [];
  let failure;
  const notify = () => { for (const listener of listeners) listener(state); };
  const nativeClose = (id, generation = 1) => {
    live.delete(`${id}:${generation}`);
    state = {...state,revision:state.revision+1,previews:[...live.values()]};
    notify();
  };
  const client = {
    subscribe(listener) { listeners.add(listener); if (state) listener(state); return () => listeners.delete(listener); },
    async getState() { return state; },
    async closePreview(target) {
      events.push(['close', target.targetId]);
      closedTargets.push(target);
      if (failure) throw failure;
      nativeClose(target.targetId,target.targetGeneration);
    },
  };
  const controller = createResourcePageController(client, ['mesh'], async target => { events.push(['detach', target.targetId]); });
  const publish = (id, phase, generation = 1) => {
    const preview = id ? { asset: { guid: id, kind: 'mesh' }, target: { targetId: id, generation } } : undefined;
    if (preview) live.set(`${id}:${generation}`,preview);
    state = { revision: (state?.revision ?? 0) + 1, project: { id: 'project' }, projectTarget: { targetId: 'editor' }, browserGeneration: 1,
      ...(preview ? { resourceOpens: { mesh: { asset: preview.asset, preview } } } : {}),
      previews:[...live.values()],
      ...(phase ? { openRequest: { requestId: 'request', sequence: 1, asset: { guid: 'next', kind: 'mesh' }, phase } } : {}),
    };
    notify();
  };
  return { controller, events, publish, nativeClose, closedTargets, fail(error) { failure = error; } };
}

it('detaches a replaced resource before closing only its previous exact target', async () => {
  const f = pageFixture();
  f.publish('first');
  f.publish('second');
  await f.controller.beforeClose(new AbortController().signal);
  assert.deepEqual(f.events, [['detach', 'first'], ['close', 'first'], ['detach', 'second'], ['close', 'second']]);
  f.controller.dispose();
});

it('coalesces page close and permits retry after a native cleanup failure', async () => {
  const f = pageFixture();
  f.publish('first');
  f.fail(new Error('native cleanup failed'));
  const close = f.controller.beforeClose(new AbortController().signal);
  assert.equal(f.controller.beforeClose(new AbortController().signal), close);
  await assert.rejects(close, /native cleanup failed/);
  assert.equal(f.controller.getStatus().phase, 'failed');
  assert.deepEqual(f.events, [['detach', 'first'], ['close', 'first']]);
  f.fail(undefined);
  await f.controller.beforeClose(new AbortController().signal);
  assert.equal(f.controller.getStatus(), undefined);
  assert.deepEqual(f.events, [['detach', 'first'], ['close', 'first'], ['detach', 'first'], ['close', 'first']]);
  f.controller.dispose();
});

it('reopens after an external native close without closing the retired target again', async () => {
  const f=pageFixture();
  f.publish('first');
  f.nativeClose('first');
  f.publish('second');
  await f.controller.beforeClose(new AbortController().signal);
  assert.deepEqual(f.events,[['detach','first'],['detach','second'],['close','second']]);
  assert.equal(f.controller.getStatus(),undefined);
  f.controller.dispose();
});

it('adopts a replacement generation on the same target ID and only closes that generation', async () => {
  const f=pageFixture();
  f.publish('same');
  f.nativeClose('same');
  f.publish('same',undefined,2);
  await f.controller.beforeClose(new AbortController().signal);
  assert.deepEqual(f.closedTargets,[{targetId:'same',targetGeneration:2}]);
  f.controller.dispose();
});

it('does not release a previous project target when its scope changes', async () => {
  const f = pageFixture();
  f.publish('first');
  f.controller.dispose();
  assert.deepEqual(f.events, []);
});

it('keeps a coalesced open alive when only one caller cancels', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  const release = f.block();
  const caller = new AbortController();
  const first = f.broker.openAsset(f.args('a'), { signal: caller.signal });
  const second = f.broker.openAsset(f.args('a'));
  await new Promise(resolve => setImmediate(resolve));
  caller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  await second;
  assert.equal(f.count, 1);
  assert.equal(f.broker.engine.previews.length, 1);
  await f.broker.dispose();
});

it('never reuses retained targets after a browser generation or catalog epoch change', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  await f.broker.openAsset(f.args('a'));
  f.reload();
  await f.broker.openAsset(f.args('a'));
  assert.equal(f.count, 2);
  f.broker.catalogEpoch++;
  await f.broker.openAsset(f.args('a'));
  assert.equal(f.count, 3);
  await f.broker.dispose();
});

it('clears a closed resource binding and allocates a new target when reopened', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  await f.broker.openAsset(f.args('a'));
  const target = f.broker.snapshot().resourceOpens.mesh.preview.target;
  await f.broker.closePreview({ targetId: target.targetId, targetGeneration: target.generation });
  assert.equal(f.broker.snapshot().resourceOpens.mesh, undefined);
  await f.broker.openAsset(f.args('a'));
  assert.equal(f.count, 2);
  await f.broker.dispose();
});

it('cancels an unadopted preview when every coalesced caller cancels', async () => {
  const f = fixture();
  await f.broker.openProject({ root: '/project' });
  await f.broker.listAssets(f.args('a'));
  const release = f.block();
  const caller = new AbortController();
  const pending = f.broker.openAsset(f.args('a'), { signal: caller.signal });
  await new Promise(resolve => setImmediate(resolve));
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.engine.previews.length, 0);
  assert.equal(f.broker.snapshot().resourceOpens.mesh, undefined);
  await f.broker.dispose();
});

import { observeWorkspaceOpenRequests, selectWorkspaceResourceSubject } from '../packages/view-workspace-core/src/resource-open.ts';

it('pending subjects never inspect a new target and late completion does not refocus its page', () => {
  let publish;
  const opened = [];
  const stop = observeWorkspaceOpenRequests({ subscribe(listener) { publish = listener; listener({}); return () => {}; } }, request => opened.push(request.requestId));
  const asset = { guid: 'mesh', kind: 'mesh' };
  const pending = { requestId: 'mesh-open', sequence: 1, asset, phase: 'opening' };
  const state = { revision: 1, openRequest: pending, resourceOpens: { mesh: { asset, pending } } };
  publish(state);
  assert.equal(selectWorkspaceResourceSubject(state, ['mesh']), undefined);
  publish({ revision: 2, openRequest: { requestId: 'material-open', sequence: 2, asset: { guid: 'material', kind: 'material' }, phase: 'opening' } });
  publish({ revision: 3, openRequest: { ...pending, sequence: 3, phase: 'ready' } });
  assert.deepEqual(opened, ['mesh-open', 'material-open']);
  stop();
});

it('the generic details page never claims or closes a dedicated type preview', async () => {
  const events = [];
  const preview = { asset: { guid: 'mesh', kind: 'mesh' }, target: { targetId: 'target', generation: 1 } };
  const state = { previews: [preview], openRequest: { requestId: 'request', sequence: 1, asset: preview.asset, preview } };
  const generic = createResourcePageController({ subscribe(listener) { listener(state); return () => {}; }, getState: async () => state, closePreview: async () => events.push('close') }, [], async () => events.push('detach'));
  await generic.beforeClose?.(new AbortController().signal);
  generic.dispose();
  assert.deepEqual(events, []);
});
