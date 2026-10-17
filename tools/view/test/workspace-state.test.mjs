import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createWorkspaceObservation, createWorkspaceStateReader } from '../packages/view-workspace-core/src/workspace-state.ts';
import { workspaceUiFingerprint } from '../packages/view-workspace-core/src/contract.ts';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { createViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import { subscribeWorkspaceCommandErrors } from '../packages/view-workspace-core/src/command-error.ts';

it('releases the last panel subscription and fences old startup responses across remounts', async () => {
  const callbacks = new Set();
  const requests = [];
  const reader = createWorkspaceStateReader({
    subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    getState: () => new Promise(resolve => requests.push(resolve)),
  });
  const first = reader.subscribe(() => {});
  const sibling = reader.subscribe(() => {});
  assert.equal(callbacks.size, 1);
  first();
  assert.equal(callbacks.size, 1);
  sibling();
  assert.equal(callbacks.size, 0);
  const remounted = reader.subscribe(() => {});
  requests[1]({ revision: 2, play: 'current' });
  await Promise.resolve();
  requests[0]({ revision: 10, play: 'old lease' });
  await Promise.resolve();
  assert.equal(reader.getSnapshot().play, 'current');
  for (const callback of callbacks) callback({ revision: 1, play: 'late event' });
  assert.equal(reader.getSnapshot().play, 'current');
  remounted();
  assert.equal(callbacks.size, 0);
  for (let i = 0; i < 10; i++) reader.subscribe(() => {})();
  assert.equal(callbacks.size, 0);
  reader.dispose();
  requests.at(-1)({ revision: 20, play: 'disposed' });
  await Promise.resolve();
  assert.equal(reader.getSnapshot(), null);
});

it('does not notify panels when only revision, frameId, or camera pose change', async () => {
  const callbacks = new Set();
  let notifies = 0;
  const reader = createWorkspaceStateReader({
    subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    getState: async () => ({
      revision: 1,
      project: { id: 'p', root: '/p' },
      preview: { target: { targetId: 't', headed: true, width: 1, height: 1 }, camera: { position: [0, 0, 0] } },
    }),
  });
  reader.subscribe(() => { notifies += 1; });
  await Promise.resolve();
  const first = reader.getSnapshot();
  assert.equal(notifies, 1);
  for (const callback of callbacks) {
    callback({
      revision: 50,
      project: { id: 'p', root: '/p' },
      preview: {
        target: { targetId: 't', headed: true, width: 1, height: 1, frameId: 99 },
        camera: { position: [9, 9, 9] },
        cameraVersion: 8,
      },
    });
  }
  assert.equal(reader.getSnapshot(), first);
  assert.equal(notifies, 1);
  for (const callback of callbacks) {
    callback({
      revision: 51,
      project: { id: 'p', root: '/p' },
      preview: { target: { targetId: 't', headed: true, width: 1, height: 1 }, camera: { control: 'observer' } },
      targetBinding: 'play',
    });
  }
  assert.notEqual(reader.getSnapshot(), first);
  assert.equal(notifies, 2);
  assert.equal(workspaceUiFingerprint(first) !== workspaceUiFingerprint(reader.getSnapshot()), true);
  reader.dispose();
});

it('does not bump broker subscribers when changed() repeats the same UI snapshot', async () => {
  const { ViewWorkspaceBroker } = await import('../packages/view-workspace-core/src/broker.ts');
  const broker = new ViewWorkspaceBroker({ engine: {}, accessToken: 'token' });
  const revisions = [];
  broker.subscribe((state) => revisions.push(state.revision));
  const afterSubscribe = revisions.length;
  broker.changed();
  broker.changed();
  assert.equal(revisions.length, afterSubscribe);
  await broker.dispose();
});

it('revokes observations synchronously on selection/generation changes, with idempotent cleanup', () => {
  let snapshot = { entity: 'a', generation: 1 };
  const listeners = new Set();
  const reader = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
  };
  const observe = () => createWorkspaceObservation(reader, state => state.entity === 'a' && state.generation === 1);
  const first = observe();
  assert.equal(first.signal.aborted, false);
  snapshot = { entity: 'b', generation: 1 };
  for (const listener of listeners) listener();
  assert.equal(first.signal.aborted, true);
  assert.equal(listeners.size, 0);
  const obsolete = observe();
  assert.equal(obsolete.signal.aborted, true);
  assert.equal(listeners.size, 0, 'synchronous initial publication must not leak its subscription');
  snapshot = { entity: 'a', generation: 1 };
  assert.equal(first.signal.aborted, true, 'returning to the same identity never revives the old observation');
  const second = observe();
  assert.equal(second.signal.aborted, false, 'the new projection may create a fresh observation');
  snapshot = { entity: 'a', generation: 2 };
  for (const listener of listeners) listener();
  assert.equal(second.signal.aborted, true);
  first.dispose(); second.dispose(); obsolete.dispose();
  assert.equal(listeners.size, 0);
  snapshot = { entity: 'a', generation: 1 };
  const unmounted = observe();
  unmounted.dispose(); unmounted.dispose();
  assert.equal(unmounted.signal.aborted, true);
  assert.equal(listeners.size, 0);
});

for (const operation of ['scene.tree.get', 'entity.inspect']) {
  it(`${operation}: revokes Game observations before close while retaining its ACK document and active failures`, async () => {
    const scene = { target: { targetId: 'scene', generation: 1 } };
    const play = { target: { targetId: 'play', generation: 2 } };
    const engine = { previews: [scene], play };
    let finishClose;
    const toolApi = {
      describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
      run(id) {
        if (id === 'engine.play.stop') {
          // The Engine retains its presented owner until cleanup is acknowledged.
          return { terminal: new Promise(resolve => { finishClose = () => { engine.play = undefined; resolve({ outcome: 'succeeded' }); }; }) };
        }
        return { terminal: Promise.resolve({ outcome: 'failed', failure: {
          code: 'engine-workspace-target-mismatch', expected: 'engine workspace target identity mismatch',
        } }) };
      },
    };
    const broker = new ViewWorkspaceBroker({ engine, toolApi, accessToken: 'test' });
    const client = createViewWorkspaceClient({ clientId: 'observer', token: 'test', transport: {
      subscribe: (_topic, accept) => broker.subscribe(accept),
      request: (_service, request, options) => broker.call(request, options),
    } });
    const reader = createWorkspaceStateReader(client);
    const releasePanel = reader.subscribe(() => {});
    const observation = createWorkspaceObservation(reader, state =>
      state?.preview?.target?.targetId === play.target.targetId &&
      state?.preview?.target?.generation === play.target.generation);
    const reports = [];
    const releaseErrors = subscribeWorkspaceCommandErrors(error => reports.push(error));
    try {
      const stopping = broker.invoke('play.stop', { targetId: 'play', targetGeneration: 2 });
      assert.equal(reader.getSnapshot().preview.target.targetId, 'scene', 'Game observations retire before Engine close starts');
      assert.equal(reader.getSnapshot().play.target.targetId, 'play', 'the ACK document remains owned until close succeeds');
      assert.equal(observation.signal.aborted, true);
      await assert.rejects(client.call(operation, { targetId: 'play', targetGeneration: 2 }, { signal: observation.signal }),
        { name: 'AbortError' });
      assert.equal(observation.signal.aborted, true, 'state revocation precedes the rejected response and React cleanup');
      assert.equal(reader.getSnapshot().preview.target.targetId, 'scene');
      assert.equal(broker.snapshot().workspaceTargetLost, false);
      assert.equal(reports.length, 0);
      finishClose();
      await stopping;
      const current = createWorkspaceObservation(reader, state => state?.preview?.target?.targetId === 'scene');
      try {
        await assert.rejects(client.call(operation, { targetId: 'scene', targetGeneration: 1 }, { signal: current.signal }),
          { code: 'view-workspace-target-mismatch' });
        assert.equal(current.signal.aborted, false);
        assert.equal(reports.length, 1, 'the same error on a still-current target remains visible');
        assert.equal(broker.snapshot().workspaceTargetLost, true, 'a genuine scene failure retains recovery reporting');
      } finally { current.dispose(); }
    } finally {
      finishClose?.(); observation.dispose(); releasePanel(); reader.dispose(); releaseErrors(); await broker.dispose();
    }
  });
}

for (const args of [{ targetId: 'other', targetGeneration: 2 }, { targetId: 'play', targetGeneration: 1 }]) {
  it(`does not revoke Game observations for a stale stop ${JSON.stringify(args)}`, async () => {
    const scene = { target: { targetId: 'scene', generation: 1 } };
    const play = { target: { targetId: 'play', generation: 2 } };
    const engine = { previews: [scene], play };
    const broker = new ViewWorkspaceBroker({ engine, toolApi: {
      describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
      run: () => ({ terminal: Promise.resolve({ outcome: 'failed', failure: { code: 'engine-workspace-target-stale', expected: 'The current generation' } }) }),
    } });
    const unsubscribe = broker.subscribe(() => {});
    const before = broker.snapshot();
    try {
      await assert.rejects(broker.invoke('play.stop', args));
      assert.deepEqual(broker.snapshot(), before);
      assert.equal(engine.play, play);
    } finally { unsubscribe(); await broker.dispose(); }
  });
}

it('keeps failed-close Play ownership and reports its stop error after revoking Game observations', async () => {
  const scene = { target: { targetId: 'scene', generation: 1, worldId: 'edit-world' } };
  const play = { target: { targetId: 'play', generation: 2, worldId: 'game-world' } };
  const engine = { previews: [scene], play };
  const broker = new ViewWorkspaceBroker({ engine, accessToken: 'test', toolApi: {
    describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
    run: () => ({ terminal: Promise.resolve({ outcome: 'failed', failure: { code: 'engine-workspace-plugin-release-incomplete', expected: 'Native cleanup must complete' } }) }),
  } });
  const client = createViewWorkspaceClient({ clientId: 'observer', token: 'test', transport: {
    subscribe: (_topic, accept) => broker.subscribe(accept),
    request: (_service, request, options) => broker.call(request, options),
  } });
  const reports = [];
  const releaseErrors = subscribeWorkspaceCommandErrors(error => reports.push(error));
  try {
    await assert.rejects(client.call('play.stop', { targetId: 'play', targetGeneration: 2 }));
    assert.equal(reports.length, 1, 'the explicit stop error remains visible');
    const state = broker.snapshot();
    assert.equal(state.preview.target.worldId, 'edit-world');
    assert.equal(state.play.target.worldId, 'game-world');
    assert.equal(state.targetBinding, 'scene');
    assert.equal(engine.play, play);
    assert.equal(engine.previews[0], scene);
  } finally { releaseErrors(); await broker.dispose(); }
});


it('opens non-previewable UI assets as metadata without replacing the Scene or allocating a preview', async () => {
  const scene = { asset: { guid: 'scene', kind: 'scene' }, target: { targetId: 'scene', generation: 1 } };
  const ui = { guid: 'ui-guide', kind: 'ui', name: 'guide.ui.html', previewable: false };
  const engine = { project: { project: { id: 'p', root: '/p' } }, previews: [scene], preview: scene };
  const operations = [];
  const toolApi = {
    describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
    run(id) {
      operations.push(id);
      if (id === 'engine.asset.open') {
        const unsupported = { asset: ui, target: { targetId: 'ui-preview', generation: 2 } };
        engine.previews.push(unsupported); engine.preview = unsupported;
        return { terminal: Promise.resolve({ outcome: 'succeeded', result: { preview: unsupported } }) };
      }
      return { terminal: Promise.resolve({ outcome: 'succeeded', result: { inspection: { guid: ui.guid, asset: ui } } }) };
    },
  };
  const broker = new ViewWorkspaceBroker({ engine, toolApi, accessToken: 'test' });
  broker.assets = [scene.asset, ui];
  const result = await broker.openAsset({ projectId: 'p', guid: ui.guid });
  assert.deepEqual(operations, ['engine.asset.inspect']);
  assert.equal(result.openRequest.asset.guid, ui.guid);
  assert.equal(result.scenePreview.target.targetId, 'scene');
  assert.equal(engine.previews.length, 1);
});
