// @forgeax/engine-assets-runtime -- asset-cluster error class coverage
// (fix issue #709). Exercises every constructor branch + .code / .expected /
// .hint / .detail four-field surface of the closed AssetRuntimeError union.

import { describe, expect, it } from 'vitest';
import {
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '../errors/asset';

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
