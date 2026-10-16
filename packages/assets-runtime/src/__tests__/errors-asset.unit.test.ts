// @forgeax/engine-assets-runtime -- asset-cluster error class coverage
// (fix issue #709). Exercises every constructor branch + .code / .expected /
// .hint / .detail four-field surface of the closed AssetRuntimeError union.

import { describe, expect, it } from 'vitest';
import {
  MaterialResolvedEmptyPassesError,
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '../errors/asset';

describe('MaterialResolvedEmptyPassesError', () => {
  it('missing-parent reason carries the parent handle in expected/hint/detail', () => {
    const e = new MaterialResolvedEmptyPassesError('mat-guid', 'missing-parent', 42);
    expect(e.code).toBe('material-resolved-empty-passes');
    expect(e.name).toBe('MaterialResolvedEmptyPassesError');
    expect(e.detail).toEqual({
      materialGuid: 'mat-guid',
      reason: 'missing-parent',
      missingParentHandle: 42,
    });
    expect(e.expected).toContain('42');
    expect(e.hint).toContain('mat-guid');
    expect(e.message).toContain('42');
  });

  it('no-pass-in-chain reason omits missingParentHandle from detail', () => {
    const e = new MaterialResolvedEmptyPassesError('mat-guid', 'no-pass-in-chain');
    expect(e.detail).toEqual({ materialGuid: 'mat-guid', reason: 'no-pass-in-chain' });
    expect('missingParentHandle' in e.detail).toBe(false);
    expect(e.expected).toContain('at least one material');
    expect(e.message).toContain('zero passes');
  });

  it('missing-parent with undefined handle still omits it from detail', () => {
    const e = new MaterialResolvedEmptyPassesError('g', 'missing-parent', undefined);
    expect('missingParentHandle' in e.detail).toBe(false);
  });
});

describe('MeshSsboCapacityExceededError', () => {
  it('surfaces requested / capacity / ceiling across all four fields', () => {
    const e = new MeshSsboCapacityExceededError(100, 64, 1024);
    expect(e.code).toBe('mesh-ssbo-capacity-exceeded');
    expect(e.name).toBe('MeshSsboCapacityExceededError');
    expect(e.detail).toEqual({ requested: 100, capacity: 64, ceiling: 1024 });
    expect(e.expected).toContain('100');
    expect(e.hint).toContain('100');
    expect(e.message).toContain('100');
  });
});

describe('MeshSsboCeilingReachedError', () => {
  it('surfaces requested / capacity / ceiling across all four fields', () => {
    const e = new MeshSsboCeilingReachedError(200, 128, 2048);
    expect(e.code).toBe('mesh-ssbo-ceiling-reached');
    expect(e.name).toBe('MeshSsboCeilingReachedError');
    expect(e.detail).toEqual({ requested: 200, capacity: 128, ceiling: 2048 });
    expect(e.expected).toContain('2048');
    expect(e.hint).toContain('2048');
    expect(e.message).toContain('200');
  });
});

describe('SceneCollectEntityRefOutOfClosureError', () => {
  it('carries entity / field / target and composes an expected+hint message', () => {
    const e = new SceneCollectEntityRefOutOfClosureError(3, 'target', 99);
    expect(e.code).toBe('scene-collect-entity-ref-out-of-closure');
    expect(e.name).toBe('SceneCollectEntityRefOutOfClosureError');
    expect(e.detail).toEqual({ entity: 3, field: 'target', target: 99 });
    expect(e.message).toBe(`${e.expected} — ${e.hint}`);
  });
});

describe('SceneCollectAssetGuidUnresolvedError', () => {
  it('numeric ref (collect path) populates detail.handle only', () => {
    const e = new SceneCollectAssetGuidUnresolvedError('meshHandle', 7);
    expect(e.code).toBe('scene-collect-asset-guid-unresolved');
    expect(e.detail).toEqual({ field: 'meshHandle', handle: 7 });
    expect('guid' in e.detail).toBe(false);
    expect(e.expected).toContain('handle 7');
  });

  it('string ref (serialize path) populates detail.guid only', () => {
    const e = new SceneCollectAssetGuidUnresolvedError('meshHandle', 'abc-guid');
    expect(e.detail).toEqual({ field: 'meshHandle', guid: 'abc-guid' });
    expect('handle' in e.detail).toBe(false);
    expect(e.expected).toContain("guid 'abc-guid'");
  });
});
