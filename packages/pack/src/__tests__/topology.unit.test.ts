import { describe, expect, it } from 'vitest';
import { diffTopology } from '../topology.js';

describe('diffTopology', () => {
  it('preserves GUID identity when keyed outputs reorder', () => {
    const previous = [
      { guid: 'old-hero', sourceKey: 'node/hero', sourceIndex: 0, kind: 'mesh' },
      { guid: 'old-body', sourceKey: 'node/body', sourceIndex: 1, kind: 'mesh' },
    ];
    const next = [
      { guid: 'new-body', sourceKey: 'node/body', sourceIndex: 0, kind: 'mesh' },
      { guid: 'new-hero', sourceKey: 'node/hero', sourceIndex: 1, kind: 'mesh' },
    ];

    expect(diffTopology(previous, next)).toEqual({
      preserved: [
        { guid: 'old-hero', oldKey: 'node/hero', newKey: 'node/hero' },
        { guid: 'old-body', oldKey: 'node/body', newKey: 'node/body' },
      ],
      added: [],
      removed: [],
      changedKind: [],
      ambiguous: [],
    });
  });

  it('reports add/remove and kind changes without inventing identity', () => {
    const result = diffTopology(
      [{ guid: 'old', sourceKey: 'node/old', sourceIndex: 0, kind: 'mesh' }],
      [
        { guid: 'new', sourceKey: 'node/new', sourceIndex: 0, kind: 'mesh' },
        { guid: 'same', sourceKey: 'node/old', sourceIndex: 1, kind: 'scene' },
      ],
    );

    expect(result.preserved).toEqual([]);
    expect(result.added).toEqual([
      { guid: 'same', sourceKey: 'node/old', sourceIndex: 1, kind: 'scene' },
      { guid: 'new', sourceKey: 'node/new', sourceIndex: 0, kind: 'mesh' },
    ]);
    expect(result.removed).toEqual([
      { guid: 'old', sourceKey: 'node/old', sourceIndex: 0, kind: 'mesh' },
    ]);
    expect(result.changedKind).toEqual([
      {
        guid: 'old',
        oldKind: 'mesh',
        newKind: 'scene',
        sourceKey: 'node/old',
        action: 'remove-add',
      },
    ]);
  });

  it('marks multi-output source-index-only matching as ambiguous', () => {
    const result = diffTopology(
      [
        { guid: 'old-a', sourceIndex: 0, kind: 'mesh' },
        { guid: 'old-b', sourceIndex: 1, kind: 'mesh' },
      ],
      [
        { guid: 'new-a', sourceIndex: 0, kind: 'mesh' },
        { guid: 'new-b', sourceIndex: 1, kind: 'mesh' },
      ],
    );

    expect(result.preserved).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.ambiguous).toMatchObject([{ reason: 'source-index-ambiguous' }]);
  });

  it('does not preserve a GUID when a producer key is duplicated', () => {
    const result = diffTopology(
      [
        { guid: 'old-a', sourceKey: 'node/body', sourceIndex: 0, kind: 'mesh' },
        { guid: 'old-b', sourceKey: 'node/body', sourceIndex: 1, kind: 'mesh' },
      ],
      [{ guid: 'new-body', sourceKey: 'node/body', sourceIndex: 0, kind: 'mesh' }],
    );

    expect(result.preserved).toEqual([]);
    expect(result.ambiguous).toMatchObject([{ reason: 'duplicate-source-key' }]);
  });

  it('keeps LOD source keys prefix-stable while allowing a suffix level', () => {
    const result = diffTopology(
      [
        { guid: 'root', sourceKey: 'mesh/root', sourceIndex: 0, kind: 'mesh' },
        { guid: 'lod1', sourceKey: 'mesh/lod1', sourceIndex: 1, kind: 'mesh' },
      ],
      [
        { guid: 'root-next', sourceKey: 'mesh/root', sourceIndex: 0, kind: 'mesh' },
        { guid: 'lod1-next', sourceKey: 'mesh/lod1', sourceIndex: 1, kind: 'mesh' },
        { guid: 'lod2-next', sourceKey: 'mesh/lod2', sourceIndex: 2, kind: 'mesh' },
      ],
    );
    expect(result.preserved).toEqual([
      { guid: 'root', oldKey: 'mesh/root', newKey: 'mesh/root' },
      { guid: 'lod1', oldKey: 'mesh/lod1', newKey: 'mesh/lod1' },
    ]);
    expect(result.added).toEqual([
      { guid: 'lod2-next', sourceKey: 'mesh/lod2', sourceIndex: 2, kind: 'mesh' },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});
