import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createAssetReferenceSession } from '../packages/view-plugin-asset-references/src/session.ts';

function fixture(t, { missing = false, deferred = false } = {}) {
  let snapshot = { project: { id: 'project' }, projectTarget: { targetId: 'scene', worldId: 'world', generation: 1 }, browserGeneration: 1 };
  let update, finish;
  const calls = [];
  const client = {
    subscribe(listener) { update = listener; listener(snapshot); return () => { update = undefined; }; },
    async call(operation, args, options) {
      calls.push({ operation, args, signal: options.signal });
      assert.equal(operation, 'entity.inspect');
      if (deferred) await new Promise(resolve => { finish = resolve; });
      return { entityId: args.entityId, targetId: args.targetId, worldId: args.worldId,
        ...(missing ? {} : { assetReferences: { references: [{ key: 'MeshFilter.assetHandle', component: 'MeshFilter', field: 'assetHandle', origin: 'component', status: 'resolved', guid: 'mesh' }], truncated: false } }) };
    },
  };
  const session = createAssetReferenceSession({ client });
  t.after(() => session.dispose());
  return { session, calls,
    publish(next) { snapshot = { ...snapshot, ...next }; update(snapshot); },
    complete() { deferred = false; finish?.(); },
    available(value) { missing = !value; },
  };
}

it('reads native entity inspection without installing, preparing or disposing runtime content', async t => {
  const f = fixture(t);
  assert.equal(f.session.getState().phase, 'ready');
  assert.equal(f.calls.length, 0);
  const result = await f.session.query('scene:world:1');
  assert.equal(result.primaryKey, 'MeshFilter.assetHandle');
  assert.equal(result.references[0].primary, true);
  assert.equal(f.calls[0].args.targetGeneration, 1);
  f.publish({ openRequest: { asset: { guid: 'mesh', kind: 'mesh' } } });
  await f.session.query('scene:world:2');
  f.session.dispose();
  assert(f.calls.every(call => call.operation === 'entity.inspect'));
  await assert.rejects(f.session.query('scene:world:1'), /scene-unavailable/);
});

it('revokes the old request signal synchronously and discards a late result after replacement', async t => {
  const f = fixture(t, { deferred: true });
  const pending = f.session.query('scene:world:1');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls[0].signal.aborted, false);
  f.publish({ projectTarget: { targetId: 'scene', worldId: 'replacement', generation: 2 } });
  assert.equal(f.calls[0].signal.aborted, true);
  f.complete();
  await rejected;
  assert.equal(f.session.getState().scope.worldId, 'replacement');
});

it('reports missing native facts explicitly and recovers when the Engine capability is restored', async t => {
  const f = fixture(t, { missing: true });
  await assert.rejects(f.session.query('scene:world:1'), /capability-unavailable/);
  assert.equal(f.session.getState().phase, 'unavailable');
  f.available(true);
  await f.session.query('scene:world:1');
  assert.equal(f.session.getState().phase, 'ready');
  f.available(false);
  await assert.rejects(f.session.query('scene:world:1'), /capability-unavailable/);
  assert.equal(f.session.getState().phase, 'unavailable');
});

it('uses the Scene generation instead of an unrelated selected resource preview', async t => {
  const f = fixture(t);
  f.publish({ scenePreview: { target: { targetId: 'scene', worldId: 'world', generation: 4 } }, preview: { target: { targetId: 'mesh', generation: 8 } } });
  await f.session.query('scene:world:1');
  assert.equal(f.calls[0].args.targetId, 'scene');
  assert.equal(f.calls[0].args.targetGeneration, 4);
});

it('does not report a caller cancellation as a failed capability', async t => {
  const f = fixture(t, { deferred: true });
  const caller = new AbortController();
  const pending = f.session.query('scene:world:1', { signal: caller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  caller.abort();
  assert.equal(f.calls[0].signal.aborted, true);
  f.complete();
  await rejected;
  assert.equal(f.session.getState().phase, 'ready');
});
