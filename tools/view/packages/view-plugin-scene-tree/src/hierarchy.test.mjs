import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareComponentFilterIds,
} from './hierarchy-filters.ts';
import {
  HIERARCHY_SCENE_FOLDER_ID,
  isSceneRootRow,
  normalizeSceneTreeResponse,
  normalizeSceneTreeRows,
  wrapWithVirtualSceneRoot,
} from './hierarchy.ts';

describe('normalizeSceneTreeRows', () => {
  it('keeps an actual entity named Scene selectable below the View grouping row', () => {
    const rows = normalizeSceneTreeRows({ nodes: [
      { entityId: 'scene', name: 'Scene', componentNames: ['Transform'] },
      { entityId: 'mesh-1', parentId: 'scene', name: 'Cube', componentNames: ['MeshFilter'] },
    ] });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, HIERARCHY_SCENE_FOLDER_ID);
    assert.equal(rows[1].id, 'scene');
    assert.equal(rows[1].kind, 'entity');
    assert.equal(rows[2].depth, 2);
  });

  it('wraps a flat Engine entity list under the virtual Scene folder', () => {
    const rows = normalizeSceneTreeRows({
      nodes: [
        { entityId: 'ground', name: 'Ground', componentNames: ['MeshFilter'] },
        { entityId: 'sun', name: 'Sun', componentNames: ['DirectionalLight'] },
      ],
    });
    assert.equal(rows[0].id, HIERARCHY_SCENE_FOLDER_ID);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].id, 'ground');
    assert.equal(rows[1].depth, 1);
    assert.equal(rows[2].id, 'sun');
    assert.equal(rows[2].depth, 1);
  });

  it('keeps mixed leaf and nested roots under one Scene folder', () => {
    const rows = normalizeSceneTreeRows({
      nodes: [
        { entityId: 'player', name: 'Player' },
        { entityId: 'props', name: 'Props' }, { entityId: 'crate', parentId: 'props', name: 'Crate' },
      ],
    });
    assert.deepEqual(rows.map((row) => [row.id, row.depth]), [
      [HIERARCHY_SCENE_FOLDER_ID, 0],
      ['player', 1],
      ['props', 1],
      ['crate', 2],
    ]);
  });

  it('still shows the virtual Scene folder when the Engine tree is empty', () => {
    const rows = normalizeSceneTreeRows({ nodes: [] });
    assert.equal(rows.length, 1);
    assert.equal(isSceneRootRow(rows[0]), true);
  });
});

describe('normalizeSceneTreeResponse', () => {
  it('projects rows and filter options together', () => {
    const { rows, filterOptions } = normalizeSceneTreeResponse({
      filterOptions: [{ id: 'IgnoredLegacyPanelRule' }],
      nodes: [{ entityId: 'main-camera', name: 'Main Camera', componentNames: ['Camera', 'Transform'] }],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].componentNames?.includes('Camera'), true);
    assert.deepEqual(filterOptions.map((option) => option.id), ['Camera', 'Transform']);
  });
});

describe('compareComponentFilterIds', () => {
  it('orders lights before mesh components', () => {
    assert.ok(compareComponentFilterIds('DirectionalLight', 'MeshRenderer') < 0);
  });
});

describe('wrapWithVirtualSceneRoot', () => {
  it('does not nest a second Scene folder around an existing sentinel', () => {
    const rows = wrapWithVirtualSceneRoot([
      { id: HIERARCHY_SCENE_FOLDER_ID, name: 'Scene', kind: 'folder', depth: 0, hasChildren: true },
      { id: 'cube', name: 'Cube', kind: 'entity', depth: 1 },
    ]);
    assert.equal(rows.filter((row) => row.id === HIERARCHY_SCENE_FOLDER_ID).length, 1);
    assert.equal(rows[0].virtual, true);
  });
});
