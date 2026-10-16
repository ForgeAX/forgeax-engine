import { describe, expect, it } from 'vitest';
import { validateProducerOutputs } from '../producer-contract.js';
import { diffTopology } from '../topology.js';

describe('topology actions', () => {
  it('rejects sourceIndex-only override declarations', () => {
    const result = validateProducerOutputs([
      { guid: 'old-a', sourceIndex: 0, kind: 'mesh' },
      { guid: 'old-b', sourceIndex: 1, kind: 'mesh' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('source-index-ambiguous');
  });

  it('reports add, remove, and reorder as source-key sets', () => {
    const previous = [
      { guid: 'old-hero', sourceKey: 'node/hero', sourceIndex: 0, kind: 'mesh' },
      { guid: 'old-body', sourceKey: 'node/body', sourceIndex: 1, kind: 'mesh' },
      { guid: 'old-deleted', sourceKey: 'node/deleted', sourceIndex: 2, kind: 'mesh' },
    ];
    const next = [
      { guid: 'new-body', sourceKey: 'node/body', sourceIndex: 0, kind: 'mesh' },
      { guid: 'new-added', sourceKey: 'node/added', sourceIndex: 1, kind: 'mesh' },
      { guid: 'new-hero', sourceKey: 'node/hero', sourceIndex: 2, kind: 'mesh' },
    ];

    const result = diffTopology(previous, next);

    expect(result.preserved).toEqual([
      { guid: 'old-hero', oldKey: 'node/hero', newKey: 'node/hero' },
      { guid: 'old-body', oldKey: 'node/body', newKey: 'node/body' },
    ]);
    expect(result.added).toEqual([
      { guid: 'new-added', sourceKey: 'node/added', sourceIndex: 1, kind: 'mesh' },
    ]);
    expect(result.removed).toEqual([
      { guid: 'old-deleted', sourceKey: 'node/deleted', sourceIndex: 2, kind: 'mesh' },
    ]);
    expect(result.changedKind).toEqual([]);
  });

  it('uses remove-add for an incompatible kind change', () => {
    const result = diffTopology(
      [{ guid: 'old', sourceKey: 'output/main', sourceIndex: 0, kind: 'mesh' }],
      [{ guid: 'new', sourceKey: 'output/main', sourceIndex: 0, kind: 'scene' }],
    );

    expect(result.preserved).toEqual([]);
    expect(result.added).toEqual([
      { guid: 'new', sourceKey: 'output/main', sourceIndex: 0, kind: 'scene' },
    ]);
    expect(result.removed).toEqual([
      { guid: 'old', sourceKey: 'output/main', sourceIndex: 0, kind: 'mesh' },
    ]);
    expect(result.changedKind).toEqual([
      {
        guid: 'old',
        oldKind: 'mesh',
        newKind: 'scene',
        sourceKey: 'output/main',
        action: 'remove-add',
      },
    ]);
  });

  it('preserves the GUID only for producer-declared compatible kinds', () => {
    const compatibleNext = {
      guid: 'new',
      sourceKey: 'output/main',
      sourceIndex: 0,
      kind: 'scene',
      compatiblePreviousKinds: ['mesh'],
    };
    const result = diffTopology(
      [{ guid: 'old', sourceKey: 'output/main', sourceIndex: 0, kind: 'mesh' }],
      [compatibleNext],
    );

    expect(result.preserved).toEqual([
      { guid: 'old', oldKey: 'output/main', newKey: 'output/main' },
    ]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changedKind).toEqual([
      {
        guid: 'old',
        oldKind: 'mesh',
        newKind: 'scene',
        sourceKey: 'output/main',
        action: 'preserve-guid',
      },
    ]);
  });
});
