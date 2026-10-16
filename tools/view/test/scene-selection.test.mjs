import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import { normalizeSceneTreeRows, sceneTreeComponentFilters } from '../packages/view-plugin-scene-tree/src/hierarchy.ts';
import { inspectorEntityFromInspection } from '../packages/view-plugin-inspector/src/inspection.ts';

function fixture(inspect = args => ({ entityId: args.entityId })) {
  const engine = { preview: { asset: { guid: 'scene', kind: 'scene' }, target: { targetId: 'target', generation: 1 } } };
  const toolApi = {
    describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
    run: (_id, args) => ({ terminal: Promise.resolve(inspect(args)).then(result => ({ outcome: 'succeeded', result })) }),
  };
  return { engine, broker: new ViewWorkspaceBroker({ engine, toolApi }) };
}
const selection = { entityId: 'world:1', label: 'Player', targetId: 'target', targetGeneration: 1 };

describe('workspace scene selection', () => {
  it('projects a multi-selection while inspecting and highlighting only the primary', async () => {
    const calls = [];
    const { broker } = fixture(args => { calls.push(args); return { entityId: args.entityId }; });
    const result = await broker.selectSceneEntity({ ...selection, entityIds: ['world:1', 'world:2', 'world:1'] });
    assert.deepEqual(result.sceneSelection.entityIds, ['world:1', 'world:2']);
    assert(calls.every(args => args.entityId === 'world:1'));
    await assert.rejects(broker.selectSceneEntity({ ...selection, entityIds: ['world:2'] }), /selection-invalid/);
    assert.equal((await broker.selectSceneEntity(selection)).sceneSelection.entityIds, undefined);
  });
  it('keeps camera and selection presentation on the explicitly bound preview', async () => {
    const { broker, engine } = fixture(args => ({ camera: { source: args.targetId }, entityId: args.entityId }));
    const other = { asset: { guid: 'other', kind: 'material' }, target: { targetId: 'other', generation: 2 } };
    engine.previews = [engine.preview, other];
    await broker.invoke('camera.get', { targetId: 'target', targetGeneration: 1 });
    const result = await broker.invoke('camera.get', { targetId: 'other', targetGeneration: 2 });
    assert.equal(result.target.targetId, 'other');
    assert.deepEqual(broker.snapshot().preview.camera, { source: 'target' });
    await assert.rejects(broker.selectSceneEntity({ ...selection, targetId: 'other', targetGeneration: 2 }), /selection-stale/);
    broker.selectTarget({ targetId: 'other' });
    await broker.selectSceneEntity({ ...selection, targetId: 'other', targetGeneration: 2 });
    assert.equal(broker.snapshot().sceneSelection.targetId, 'other');
    assert.equal(broker.snapshot().editorPreview.target.targetId, 'target');
  });
  it('stores an Engine-validated target binding, separately from asset inspection', async () => {
    const { broker } = fixture();
    const state = await broker.selectSceneEntity(selection);
    assert.deepEqual(state.sceneSelection, { primary: { entityId: 'world:1', label: 'Player' }, targetId: 'target', targetGeneration: 1 });
    assert.equal((await broker.clearSceneSelection(selection)).sceneSelection, null);
    assert.equal(inspectorEntityFromInspection({ guid: 'asset', meta: { components: [] } }), null);
  });
  it('does not accept an entity selection without the Engine capability', async () => {
    const broker = new ViewWorkspaceBroker({ engine: { preview: { asset: { guid: 'scene', kind: 'scene' }, target: { targetId: 'target', generation: 1 } } } });
    await assert.rejects(broker.selectSceneEntity(selection), /operation-unavailable/);
    assert.equal(broker.snapshot().sceneSelection, null);
  });
  it('rejects a late selection after another selection, clear, or target replacement', async () => {
    for (const event of ['select', 'clear', 'replace']) {
      let resolve;
      const { broker, engine } = fixture(args => args.entityId === 'world:1' ? new Promise(r => { resolve = r; }) : { entityId: args.entityId });
      const pending = broker.selectSceneEntity(selection);
      await Promise.resolve();
      if (event === 'select') await broker.selectSceneEntity({ ...selection, entityId: 'world:2' });
      if (event === 'clear') await broker.clearSceneSelection(selection);
      if (event === 'replace') engine.preview = { ...engine.preview, target: { targetId: 'target', generation: 2 } };
      resolve({ entityId: 'world:1' });
      await assert.rejects(pending, event === 'replace' ? undefined : error => error.code === 'view-workspace-selection-superseded');
      assert.equal(broker.snapshot().sceneSelection?.primary.entityId ?? null, event === 'select' ? 'world:2' : null);
    }
  });
  it('does not mark the editing target lost when the Play document fails', async () => {
    const { broker, engine } = fixture();
    engine.play = { target: { targetId: 'play', generation: 1 }, phase: 'failed' };
    broker.toolApi.run = () => ({ terminal: Promise.resolve({ outcome: 'failed', failure: {
      code: 'engine-workspace-page-lost', expected: 'A live target', hint: 'Stop the failed target.',
    } }) });
    await assert.rejects(broker.invoke('scene.tree.get', { targetId: 'play', targetGeneration: 1 }));
    assert.equal(broker.snapshot().workspaceTargetLost, false);
    engine.play = null;
    for (const [targetId, targetGeneration] of [['play', 1], ['closed-asset', 1], ['target', 0]]) {
      await assert.rejects(broker.invoke('scene.tree.get', { targetId, targetGeneration }));
      assert.equal(broker.snapshot().workspaceTargetLost, false, 'retired targets must not disconnect the workspace');
    }
    await assert.rejects(broker.invoke('scene.tree.get', { targetId: 'target', targetGeneration: 1 }));
    assert.equal(broker.snapshot().workspaceTargetLost, true);
  });
  it('projects flat parent references without losing roots, cycles, or selectable parents', () => {
    const rows = normalizeSceneTreeRows({ nodes: [
      { entityId: 'child', parentId: 'parent' }, { entityId: 'parent' },
      { entityId: 'cycle', parentId: 'cycle' }, { entityId: 'orphan', parentId: 'missing' },
    ] });
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.slice(1, 3).map(row => [row.id, row.depth, row.kind]), [['parent', 1, 'entity'], ['child', 2, 'entity']]);
  });
  it('keeps component display and loaded-row filter counts in View', () => {
    const rows = normalizeSceneTreeRows({ nodes: [
      { entityId: 'camera', componentNames: ['Camera', 'Transform'] },
      { entityId: 'mesh', componentNames: ['MeshFilter', 'Transform'] },
    ] });
    assert.deepEqual(rows.slice(1).map(row => row.typeKey), ['camera', 'mesh']);
    assert.deepEqual(sceneTreeComponentFilters(rows), [
      { id: 'Camera', count: 1 }, { id: 'MeshFilter', count: 1 }, { id: 'Transform', count: 2 },
    ]);
  });
  it('projects only supplied component schemas and values, including false and zero', () => {
    const entity = inspectorEntityFromInspection({ entityId: 'world:1', name: 'Player', components: [
      { name: 'Health', fields: { value: { type: 'f32' }, alive: { type: 'bool' } }, values: { value: 0, alive: false } },
    ] });
    assert.deepEqual(entity.components[0].fields.map(field => field.value), [0, false]);
  });
});
