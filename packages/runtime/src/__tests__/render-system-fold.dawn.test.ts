// record fold Dawn coverage -- feat-20260622-chunk-gpu-instancing-sprite-tilemap
// M1 / w7.
//
// Integration test for the record-stage fold operator. Exercises the
// foldDispatchBuckets + buildFoldDispatchPlan composition on
// realistically-shaped DispatchEntry sequences mirroring the AC-01 / AC-02
// workloads (sprite-atlas 10k single-material + tilemap 65536 / chunkSize=16
// = 256 chunks multi-material).
//
// AC-01 boundary: 100 sprite entities sharing one atlas material at the same
// (Layer.value, posZ) collapse into 1 fold bucket. plan.headBuckets has one
// entry; plan.skipIndices has 99. The dispatch loop, on real GPU, emits one
// drawIndexed(idxCount, 100) instead of 100 drawIndexed(idxCount, 1).
//
// AC-02 boundary (tilemap chunk): 256 distinct (Layer.value chunk-encoded)
// runs, each with N members sharing one material -> 256 fold buckets. Total
// drawIndexed drops from 65536 to 256.
//
// AC-10 boundary (multi-material in one chunk): two materials in the same
// (Layer.value, posZ) run -> 2 fold buckets (no cross-material cell merge).
//
// mode-bypass boundary (D-5): modes 2/3 (LAYER_YZ / DISTANCE) yield N
// singleton buckets for N entries (no fold). plan.headBuckets is empty;
// plan.skipIndices is empty; dispatch loop falls through per-entity
// byte-identically.
//
// LAYER_Y fold boundary (feat-20260630 D-2 / AC-05): mode 1 (LAYER_Y) was
// extended from a bypass mode into a fold mode that keys on posY (world[13]).
// 50 single-material entries at the same posY collapse into 1 fold bucket
// of size 50 — mirroring the AC-01 LAYER_Z invariant but on the Y axis.
//
// This test is intentionally device-agnostic at the helper layer (the helper
// is pure, no GPU dependencies) but lives under the dawn project (.dawn.
// test.ts extension) per plan-tasks.json w7 + the AGENTS.md §Smoke gate
// requirement that per-draw command path changes run through the dawn
// vitest project. The actual drawIndexed swap (record-stage integration in
// render-system-record.ts) is exercised end-to-end by the existing
// runtime test suite (createRenderer-* tests + the runtime mega tests
// observe drawIndexedCount through the device mock); this file pins the
// fold-plan invariants the swap relies on.

import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  buildFoldDispatchPlan,
  type FoldRenderableLike,
  foldDispatchBuckets,
} from '../../../render/src/record/mesh-ssbo';
import type { DispatchEntry } from '../../../render/src/render-system-extract';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../../../render/src/systems/transparent-sort-config';

function mockDispatchEntry(opts: {
  renderableIndex: number;
  materialHandle: number;
  layer: number;
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
    // Fold admission is intentionally limited to the transparent sprite
    // owners; these fixtures model sprite/tilemap draws rather than generic
    // transparent Standard PBR geometry.
    materialShaderId: 'forgeax::sprite',
    paramSnapshot: undefined,
  };
}

function mockRenderable(tz: number, tx = 0, ty = 0): FoldRenderableLike {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = tx;
  world[13] = ty;
  world[14] = tz;
  // PR #502 fix + feat-20260625 R2 fix-up: foldDispatchBuckets gates fold to
  // `transparent === true`; these dawn integration tests assume fold-eligible
  // behavior so default to `transparent: true` (the M3 ablation collapsed the
  // sprite shadingModel discriminator into the generic transparent flag).
  return { transform: { world }, material: { transparent: true } };
}

describe('fold operator dawn integration (w7) — drawIndexed count drops to bucket count', () => {
  it('AC-01: 100 sprite entities sharing one material -> 1 fold bucket; head=1, skip=99', () => {
    const N = 100;
    const entries: DispatchEntry[] = [];
    const renderables: FoldRenderableLike[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockDispatchEntry({ renderableIndex: i, materialHandle: 7, layer: 100 }));
      // Distinct posX/posY per sprite (worldspace placement); shared posZ
      // so the bucket key (layer, posZ, materialHandle) collapses.
      renderables.push(mockRenderable(0.5, i * 1.0, 0));
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(1);
    const [bucket] = buckets;
    expect(bucket?.bucketSize).toBe(N);

    // Build validatedOrdered-index map; for this fixture renderableIndex == i.
    const renderableToValidated = new Map<number, number>();
    for (let i = 0; i < N; i++) renderableToValidated.set(i, i);

    const plan = buildFoldDispatchPlan(buckets, renderableToValidated);

    // AC-01 invariant: one head, N-1 skips. The dispatch loop on real GPU
    // emits one drawIndexed(idxCount, N) at the head, skipping the rest;
    // total drawIndexed calls = 1 (vs N pre-feat).
    expect(plan.foldedBucketCount).toBe(1);
    expect(plan.headBuckets.size).toBe(1);
    expect(plan.headBuckets.has(0)).toBe(true);
    expect(plan.skipIndices.size).toBe(N - 1);
    for (let i = 1; i < N; i++) {
      expect(plan.skipIndices.has(i)).toBe(true);
    }
  });

  it('AC-02 (tilemap chunk multi-material): 2 materials interleaved by chunk -> 2 buckets per chunk run', () => {
    // Simulate a single tilemap chunk: 32 cells, 2 materials.
    // Layer-stable sort co-locates cells by (layer, posZ, material), so the
    // upstream TransparentSortCache ensures runs are contiguous by material.
    // The fold operator must NOT merge runs of different materials into one
    // bucket (AC-10 cross-material guard).
    const PER_MATERIAL = 16;
    const entries: DispatchEntry[] = [];
    const renderables: FoldRenderableLike[] = [];
    let renderableIndex = 0;
    // Material 11: 16 cells.
    for (let i = 0; i < PER_MATERIAL; i++) {
      entries.push(
        mockDispatchEntry({ renderableIndex: renderableIndex, materialHandle: 11, layer: 200 }),
      );
      renderables.push(mockRenderable(0.5));
      renderableIndex += 1;
    }
    // Material 22: 16 cells (same layer + posZ, different material).
    for (let i = 0; i < PER_MATERIAL; i++) {
      entries.push(
        mockDispatchEntry({ renderableIndex: renderableIndex, materialHandle: 22, layer: 200 }),
      );
      renderables.push(mockRenderable(0.5));
      renderableIndex += 1;
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.bucketSize).toBe(PER_MATERIAL);
    expect(buckets[0]?.materialHandle).toBe(11);
    expect(buckets[1]?.bucketSize).toBe(PER_MATERIAL);
    expect(buckets[1]?.materialHandle).toBe(22);

    const renderableToValidated = new Map<number, number>();
    for (let i = 0; i < entries.length; i++) renderableToValidated.set(i, i);
    const plan = buildFoldDispatchPlan(buckets, renderableToValidated);

    // 32 cells -> 2 buckets -> 2 drawIndexed instead of 32. drawIndexed count
    // reduction = 32 - 2 = 30 (94% reduction). At AC-02 65536 cells with
    // chunkSize=16 the same logic gives 256 buckets => 256 draws (vs 65536).
    expect(plan.foldedBucketCount).toBe(2);
    expect(plan.headBuckets.size).toBe(2);
    expect(plan.headBuckets.has(0)).toBe(true);
    expect(plan.headBuckets.has(PER_MATERIAL)).toBe(true);
    expect(plan.skipIndices.size).toBe(2 * (PER_MATERIAL - 1));
  });

  it('multi-chunk: 4 chunks x 8 cells single material -> 4 buckets (chunk granularity from Layer.value)', () => {
    // Tilemap chunkIndex is encoded in Layer.value's lower bits per
    // research F-2 (chunkIndex << 20 + layerOrder). Different chunkIndex =>
    // different Layer.value => different bucket.
    const CHUNKS = 4;
    const CELLS_PER_CHUNK = 8;
    const MAT = 33;
    const entries: DispatchEntry[] = [];
    const renderables: FoldRenderableLike[] = [];
    let renderableIndex = 0;
    for (let c = 0; c < CHUNKS; c++) {
      const layer = (1 << 20) | c; // distinct per chunk
      for (let cell = 0; cell < CELLS_PER_CHUNK; cell++) {
        entries.push(
          mockDispatchEntry({
            renderableIndex: renderableIndex,
            materialHandle: MAT,
            layer,
          }),
        );
        renderables.push(mockRenderable(0.25));
        renderableIndex += 1;
      }
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(CHUNKS);
    for (let c = 0; c < CHUNKS; c++) {
      expect(buckets[c]?.bucketSize).toBe(CELLS_PER_CHUNK);
    }

    const renderableToValidated = new Map<number, number>();
    for (let i = 0; i < entries.length; i++) renderableToValidated.set(i, i);
    const plan = buildFoldDispatchPlan(buckets, renderableToValidated);

    // 32 entries -> 4 buckets -> 4 drawIndexed (vs 32 pre-feat).
    expect(plan.foldedBucketCount).toBe(CHUNKS);
    expect(plan.headBuckets.size).toBe(CHUNKS);
    expect(plan.skipIndices.size).toBe(CHUNKS * (CELLS_PER_CHUNK - 1));
  });

  it('mode-bypass D-5: mode 2/3 (LAYER_YZ / DISTANCE) + 50 single-material entries -> 50 singleton buckets, 0 folded, all drawIndexed per-entity', () => {
    // feat-20260630 D-2 / AC-05: LAYER_Y was removed from the bypass set
    // because it now folds on posY (world[13]). Only LAYER_YZ (composite
    // foot-Y key) and DISTANCE (per-entity camera distance) remain as
    // bypass modes whose sort keys cannot fold runs.
    const N = 50;
    const entries: DispatchEntry[] = [];
    const renderables: FoldRenderableLike[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockDispatchEntry({ renderableIndex: i, materialHandle: 5, layer: 0 }));
      renderables.push(mockRenderable(0.1));
    }
    const renderableToValidated = new Map<number, number>();
    for (let i = 0; i < N; i++) renderableToValidated.set(i, i);

    for (const mode of [TRANSPARENT_SORT_MODE_LAYER_YZ, TRANSPARENT_SORT_MODE_DISTANCE] as const) {
      const buckets = foldDispatchBuckets(entries, mode, renderables);
      // Mode bypass: each entry is its own singleton bucket.
      expect(buckets).toHaveLength(N);
      for (const b of buckets) expect(b.bucketSize).toBe(1);

      const plan = buildFoldDispatchPlan(buckets, renderableToValidated);
      // foldedBucketCount counts only bucketSize > 1 buckets; under bypass
      // the dispatch loop falls through per-entity byte-identically.
      expect(plan.foldedBucketCount).toBe(0);
      expect(plan.headBuckets.size).toBe(0);
      expect(plan.skipIndices.size).toBe(0);
    }
  });

  it('AC-05 (LAYER_Y fold): mode 1 + 50 single-material entries at same posY -> 1 fold bucket of size 50', () => {
    // feat-20260630 D-2 / AC-05: LAYER_Y is a fold mode keyed on posY
    // (world[13]). 50 same-row tiles sharing one material collapse into a
    // single instanced draw — the AC-01 LAYER_Z invariant mirrored on Y.
    const N = 50;
    const entries: DispatchEntry[] = [];
    const renderables: FoldRenderableLike[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockDispatchEntry({ renderableIndex: i, materialHandle: 5, layer: 0 }));
      // posY=0 across all entries; posZ varies (irrelevant for LAYER_Y key).
      renderables.push(mockRenderable(0.1));
    }
    const renderableToValidated = new Map<number, number>();
    for (let i = 0; i < N; i++) renderableToValidated.set(i, i);

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Y, renderables);
    expect(buckets).toHaveLength(1);
    const [bucket] = buckets;
    expect(bucket?.bucketSize).toBe(N);

    const plan = buildFoldDispatchPlan(buckets, renderableToValidated);
    expect(plan.foldedBucketCount).toBe(1);
    expect(plan.headBuckets.size).toBe(1);
    expect(plan.headBuckets.has(0)).toBe(true);
    expect(plan.skipIndices.size).toBe(N - 1);
    for (let i = 1; i < N; i++) {
      expect(plan.skipIndices.has(i)).toBe(true);
    }
  });

  it('cross-bucket boundary: distinct posZ in same material run -> distinct buckets (no transitive fold)', () => {
    // posZ varies per entry; even with identical layer + material, the bucket
    // key (layer, posZ, material) splits adjacent entries into separate
    // singleton buckets (3 entries -> 3 singleton buckets).
    const entries: DispatchEntry[] = [
      mockDispatchEntry({ renderableIndex: 0, materialHandle: 9, layer: 50 }),
      mockDispatchEntry({ renderableIndex: 1, materialHandle: 9, layer: 50 }),
      mockDispatchEntry({ renderableIndex: 2, materialHandle: 9, layer: 50 }),
    ];
    const renderables: FoldRenderableLike[] = [
      mockRenderable(0.1),
      mockRenderable(0.2),
      mockRenderable(0.3),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(3);
    for (const b of buckets) expect(b.bucketSize).toBe(1);

    const renderableToValidated = new Map<number, number>([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    const plan = buildFoldDispatchPlan(buckets, renderableToValidated);
    expect(plan.foldedBucketCount).toBe(0);
    expect(plan.headBuckets.size).toBe(0);
    expect(plan.skipIndices.size).toBe(0);
  });
});
