import assert from 'node:assert/strict';
import { dispatch } from '../src/bridge.mjs';

const calls = [];
const owners = ['view.start', 'view.status', 'view.workspace.call', 'engine.asset.inspect', 'engine.scene.tree.get', 'engine.entity.inspect'];
const api = {
  list: () => owners.map(id => ({ callable: true, descriptor: { id },
    owner: { sourceId: id, providerId: id, generation: 1 } })),
  run(id, args) {
    calls.push({ id, args });
    const result = id === 'view.status' ? { phase: 'ready' }
      : id === 'view.workspace.call' && args.operation === 'summary.get'
        ? { project: { id: 'owner-game', root: '/game', name: 'Owner Game' }, projectPhase: 'failed',
          targets: [{ targetId: 'owner-target', generation: 3, role: 'project' }], revision: 7, browserGeneration: 2 }
        : id === 'view.workspace.call' && args.operation === 'pages.list'
          ? { pages: [{ connectionId: 'page-a', project: { id: 'game', root: '/game', name: 'Game' },
            projectPhase: 'running', targets: [{ targetId: 'target-a', generation: 2, role: 'project' },
              ...Array.from({ length: 5 }, (_, index) => ({ targetId: `preview-${index}`, generation: 1, role: 'preview' }))] }], hasMorePages: false }
          : id === 'view.workspace.call' && args.operation === 'pack.reveal'
            ? { ok: false, code: 'view-page-ambiguous', candidates: ['page-a', 'page-b'] }
      : id === 'engine.asset.inspect' ? { inspection: { guid: args.guid, kind: 'mesh', asset: { guid: args.guid, kind: 'mesh' } } }
        : id === 'engine.scene.tree.get' ? { ok: false, error: { code: 'engine-workspace-target-mismatch',
          expected: 'a current target', hint: 'Refresh status.' } }
              : { ok: true };
    return { terminal: Promise.resolve({ outcome: 'succeeded', result }) };
  },
};

const opened = await dispatch(api, '/game', 'view.start', {});
assert.equal(opened.ok, true);
assert.equal(calls.pop().id, 'view.start');

const status = await dispatch(api, '/game', 'view.status', {});
assert.equal(status.ok, true);
assert.equal(status.value.pages[0].connectionId, 'page-a');
assert.equal(status.value.pages[0].targets.length, 4);
assert.equal(status.value.pages[0].hasMoreTargets, true);
// Page-local facts must not replace the workspace owner's identity or phase.
assert.equal(status.value.project.id, 'owner-game');
assert.equal(status.value.projectPhase, 'failed');
assert.deepEqual(status.value.targets, [{ targetId: 'owner-target', generation: 3, role: 'project' }]);
assert.equal(status.value.pages[0].projectPhase, 'running');
assert.deepEqual(calls.slice(0, 3).map(call => [call.id, call.args.operation]), [
  ['view.status', undefined], ['view.workspace.call', 'summary.get'], ['view.workspace.call', 'pages.list'],
]);

const reveal = await dispatch(api, '/game', 'view.workspace.pack.reveal', {
  projectId: 'game', sourcePath: 'assets/scene.pack.json', revision: 'sha256:abc',
});
assert.equal(reveal.error.code, 'view-page-ambiguous');
assert.deepEqual(reveal.error.detail.candidates, ['page-a', 'page-b']);
assert.equal(calls.at(-1).args.operation, 'pack.reveal');

const asset = await dispatch(api, '/game', 'engine.asset.inspect', {
  projectId: 'game', targetId: 'target-a', guid: 'mesh-a',
});
assert.equal(asset.value.guid, 'mesh-a');
assert.deepEqual(calls.at(-1), { id: 'engine.asset.inspect',
  args: { projectId: 'game', targetId: 'target-a', guid: 'mesh-a' } });
assert.equal((await dispatch(api, '/game', 'engine.asset.inspect', { guid: 'mesh-a' })).error.code, 'invalid-argument');

const tree = await dispatch(api, '/game', 'engine.scene.tree.get', { targetId: 'target-a', targetGeneration: 2 });
assert.equal(calls.at(-1).id, 'engine.scene.tree.get');
assert.equal(tree.error.code, 'engine-workspace-target-mismatch');
await dispatch(api, '/game', 'engine.entity.inspect', { targetId: 'target-a', targetGeneration: 2, entityId: 'e1' });
assert.equal(calls.at(-1).id, 'engine.entity.inspect');
const cancelled = await dispatch({ list: api.list,
  run: () => ({ terminal: Promise.resolve({ outcome: 'cancelled' }) }) }, '/game', 'view.status', {});
assert.equal(cancelled.error.code, 'mcp-cancelled');
console.log(JSON.stringify({ publicOperations: calls.map(call => call.args.operation ?? call.id) }));
