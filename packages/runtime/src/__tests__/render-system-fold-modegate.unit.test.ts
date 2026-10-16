// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w3 — mode-gate (D-5).
//
// Drives the pure fold helper for the four transparent-sort modes:
//   mode 0 (LAYER_Z)   -> fold on posZ (world[14]); equal-key runs collapse.
//   mode 1 (LAYER_Y)   -> fold on posY (world[13]); same-row tiles collapse.
//   mode 2 (LAYER_YZ)  -> bypass per-entity (composite foot-Y key).
//   mode 3 (DISTANCE)  -> bypass per-entity (per-entity camera distance).
//
// Bypass semantics (modes 2/3): each DispatchEntry produces its own
// singleton bucket (bucketSize=1). The fold dispatcher (record-stage)
// treats singleton buckets identically to per-entity drawIndexed (charter
// P3 silent fallback — no error, no warning).
//
// Mode 1 (LAYER_Y) folds using posY as the sort-axis bucket key: tiles in
// the same row share posY and consecutive same-material runs collapse into
// one instanced draw call (D-5 extension).

import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { foldDispatchBuckets } from '../../../render/src/record/mesh-ssbo';
import type { DispatchEntry } from '../../../render/src/render-system-extract';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../../../render/src/systems/transparent-sort-config';

function mockEntry(opts: {
  renderableIndex: number;
  materialHandle: number;
  layer: number;
  materialShaderId?: string;
}): DispatchEntry {
  return {
    entityIndex: opts.renderableIndex,
    materialHandle: opts.materialHandle,
    renderableIndex: opts.renderableIndex,
    passIndex: 0,
    queue: RenderQueue.Transparent,
    layer: opts.layer,
    tags: {},
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: opts.materialShaderId,
    paramSnapshot: undefined,
  };
}

function mockRenderable(
  tz: number,
  ty = 0,
): {
  transform: { world: Float32Array };
  material: { transparent?: true | undefined };
} {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[13] = ty;
  world[14] = tz;
  // PR #502 fix + feat-20260625 R2 fix-up: `transparent: true` preserves the
  // fold-eligible behavior these mode-gate tests exercise; see
  // record/mesh-ssbo.ts transparent-pass-only gate (the sprite
  // discriminator was removed in M3 / w15 and replaced with `transparent`).
  return { transform: { world }, material: { transparent: true } };
}

describe('foldDispatchBuckets — mode-gate (D-5, w3)', () => {
  // 5 entries all sharing (layer=0, posZ=0, posY=0, materialHandle=1).
  // Under mode 0 and 1 they collapse to 1 bucket. Under mode 2/3 they each
  // get their own singleton bucket (bypass).
  function makeUniformInputs(N: number): {
    entries: DispatchEntry[];
    renderables: ReturnType<typeof mockRenderable>[];
  } {
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(
        mockEntry({
          renderableIndex: i,
          materialHandle: 1,
          layer: 0,
          materialShaderId: 'forgeax::sprite',
        }),
      );
      renderables.push(mockRenderable(0, 0));
    }
    return { entries, renderables };
  }

  it('mode 0 (LAYER_Z) — N equal-key entries collapse to 1 bucket', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(1);
    const b = buckets[0];
    expect(b).toBeDefined();
    if (b === undefined) return;
    expect(b.bucketSize).toBe(5);
  });

  it('mode 1 (LAYER_Y) — N equal-posY entries collapse to 1 bucket', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables);
    expect(buckets).toHaveLength(1);
    const b = buckets[0];
    expect(b).toBeDefined();
    if (b === undefined) return;
    expect(b.bucketSize).toBe(5);
  });

  it('mode 1 (LAYER_Y) — distinct posY per entry -> N singleton buckets', () => {
    // Each tile is in a different row (different posY); no consecutive run
    // can form, so each entry becomes its own bucket.
    const N = 4;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(
        mockEntry({
          renderableIndex: i,
          materialHandle: 1,
          layer: 0,
          materialShaderId: 'forgeax::sprite',
        }),
      );
      renderables.push(mockRenderable(0, i * 16)); // posY = 0, 16, 32, 48
    }
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables);
    expect(buckets).toHaveLength(N);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode 1 (LAYER_Y) — sortKey carries posY (world[13])', () => {
    // Single bucket from N entries at posY=3.0; sortKey must equal 3.0.
    const N = 3;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(
        mockEntry({
          renderableIndex: i,
          materialHandle: 1,
          layer: 0,
          materialShaderId: 'forgeax::sprite',
        }),
      );
      renderables.push(mockRenderable(0, 3.0));
    }
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables);
    expect(buckets).toHaveLength(1);
    const b = buckets[0];
    expect(b).toBeDefined();
    if (b === undefined) return;
    expect(b.sortKey).toBeCloseTo(3.0);
  });

  it('mode 2 (LAYER_YZ) — N entries bypass to N singleton buckets (no fold)', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_YZ, renderables);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode 3 (DISTANCE) — N entries bypass to N singleton buckets (no fold)', () => {
    const { entries, renderables } = makeUniformInputs(5);
    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_DISTANCE, renderables);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) expect(b.bucketSize).toBe(1);
  });

  it('mode-gate is silent: bypass modes 2/3 do not throw or fire errors', () => {
    const { entries, renderables } = makeUniformInputs(3);
    // The pure helper does not have access to errorRegistry; "silent"
    // here means no thrown exception. Negative-space assertion.
    expect(() =>
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_YZ, renderables),
    ).not.toThrow();
    expect(() =>
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_DISTANCE, renderables),
    ).not.toThrow();
  });
});
