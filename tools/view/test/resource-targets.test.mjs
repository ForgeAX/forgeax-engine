import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { selectWorkspaceSceneSurfaceTarget, selectWorkspaceResourcePreview } from '../packages/view-workspace-core/src/resource-open.ts';

test('Play before opening a scene never lends the game document to the Scene', () => {
  const game = { target: { targetId: 'game', generation: 1 } };
  assert.equal(selectWorkspaceSceneSurfaceTarget({ targetBinding: 'play', preview: game }), null);
  const scene = { target: { targetId: 'scene', generation: 1 } };
  assert.equal(selectWorkspaceSceneSurfaceTarget({ targetBinding: 'play', preview: game, scenePreview: scene }), scene.target);
  assert.equal(selectWorkspaceSceneSurfaceTarget({ targetBinding: 'scene', preview: scene }), scene.target);
});

test('consumer binding facts survive broker serialization and selection of an older live preview', () => {
  const asset = { guid: 'same-mesh', kind: 'mesh' };
  const old = { asset, target: { targetId: 'old', generation: 1 },
    assetBinding: { publication: { generation: 17, digest: 'old-content' }, meta: { aabb: [-1, -1, -1, 1, 1, 1] } } };
  const current = { asset, target: { targetId: 'new', generation: 2 },
    assetBinding: { publication: { generation: 42, digest: 'new-content' }, meta: { aabb: [-2, -1, -1, 2, 1, 1] } } };
  const engine = { project: { project: { id: 'p', root: '/p' } }, previews: [old, current] };
  const broker = new ViewWorkspaceBroker({ engine });
  broker.snapshot();
  broker.recordOpenRequest({ guid: asset.guid, result: { preview: old } });
  const first = broker.snapshot();
  assert.deepEqual(selectWorkspaceResourcePreview(first, asset.guid).assetBinding, old.assetBinding);
  broker.recordOpenRequest({ guid: asset.guid, result: { preview: current } });
  const next = broker.snapshot();
  assert.deepEqual(selectWorkspaceResourcePreview(next, asset.guid).assetBinding, current.assetBinding);
  assert.equal(first.previews[0].assetBinding.publication.digest, 'old-content');
  assert.deepEqual(broker.openRequest.preview.assetBinding, current.assetBinding, 'the accepted open preserves its exact native binding');
  assert.deepEqual(next.resourceOpens.mesh.preview.assetBinding, current.assetBinding);
});

test('the first Mesh preview is never mistaken for the Scene target', () => {
  const mesh = { asset: { guid: 'mesh-one', kind: 'mesh' }, target: { targetId: 'mesh-preview', worldId: 'mesh-world' } };
  const scene = { asset: { guid: 'scene-one', kind: 'scene' }, target: { targetId: 'scene', worldId: 'scene-world' } };
  const engine = {
    project: { project: { id: 'p', root: '/p', name: 'P' }, target: scene.target },
    previews: [mesh],
  };
  const broker = new ViewWorkspaceBroker({ engine });
  assert.equal(broker.snapshot().scenePreview, null);
  broker.recordOpenRequest({ guid: mesh.asset.guid, result: { preview: mesh } });
  assert.equal(broker.snapshot().resourceOpens.mesh.preview.target.targetId, 'mesh-preview');
  engine.previews.push(scene);
  assert.equal(broker.snapshot().scenePreview.target.targetId, 'scene');
  assert.equal(broker.snapshot().preview.target.targetId, 'scene');
  assert.equal(broker.snapshot().resourceOpens.mesh.preview.target.targetId, 'mesh-preview');
});

for (const kind of ['ui', 'vfx', 'custom']) {
  test(`${kind} resource targets never become the Scene, including when pinned`, () => {
    const resource = { asset: { guid: 'resource', kind }, target: { targetId: 'resource-preview' } };
    const broker = new ViewWorkspaceBroker({ engine: { previews: [resource] } });
    broker.sceneTargetId = resource.target.targetId;
    assert.equal(broker.snapshot().scenePreview, null);
  });
}
