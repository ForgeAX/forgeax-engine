// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w1 — fold-bucket basics.
//
// Drives the pure fold helper `foldDispatchBuckets(entries, mode, renderables)`
// for mode-0 (LAYER_Z) basic paths:
//   (1) single material, N consecutive DispatchEntry sharing (layer, posZ,
//       materialHandle) -> 1 fold bucket with bucketSize=N.
//   (2) empty input -> 0 buckets.
//   (3) chunkSize=1 (each entry has its own (layer, posZ, material)) ->
//       N buckets each with bucketSize=1 (degenerate single-instance path).
//   (4) Float32Array layout: assembled transforms is a Float32Array with
//       stride=16 (16 f32 per instance, column-major mat4), length=N*16.
//
// Constraints from plan-tasks.json w1:
//   - mode 0 (LAYER_Z) only (mode 1/2/3 in w3)
//   - Instances schema not touched (stride=16)
//   - no new file in packages/runtime/src/scene-instances/ (AC-08)

import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { foldDispatchBuckets } from '../../../render/src/record/mesh-ssbo';
import type { DispatchEntry } from '../../../render/src/render-system-extract';
import { TRANSPARENT_SORT_MODE_LAYER_Z } from '../../../render/src/systems/transparent-sort-config';

// Minimal mock DispatchEntry — only the fields the fold helper reads:
// materialHandle, renderableIndex, layer, queue. Other fields are
// `undefined` / placeholder; the helper does not consult them.
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
    materialShaderId: opts.materialShaderId ?? 'forgeax::sprite',
    paramSnapshot: undefined,
  };
}

// Minimal renderable snapshot — only the world mat4 is consulted (for posZ
// and for assembled transforms). Build an identity mat4 with a chosen tz.
// PR #502 fix + feat-20260625 R2 fix-up: foldDispatchBuckets gates fold to
// transparent entries (the M3 ablation collapsed `shadingModel === 'sprite'`
// into `transparent === true` as the LDR-split-sub-pass discriminator). The
// `transparent` parameter is a 3-arity optional flag: omitted (arity=1)
// defaults to `true` so legacy basic-paths tests keep their fold-eligible
// behavior; explicit values may pass `undefined` (non-transparent /
// geometry-pass) which must land as undefined in the renderable (do NOT
// collapse to default via arity-2 default-parameter substitution).
function mockRenderable(
  tz: number,
  ...rest: [true | undefined] | []
): {
  transform: { world: Float32Array };
  material: { transparent?: true | undefined };
} {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[14] = tz; // posZ
  const transparent = rest.length === 0 ? true : rest[0];
  return { transform: { world }, material: { transparent } };
}

describe('foldDispatchBuckets — mode 0 basic paths (w1)', () => {
  it('empty entries produces 0 buckets', () => {
    const buckets = foldDispatchBuckets([], TRANSPARENT_SORT_MODE_LAYER_Z, []);
    expect(buckets).toHaveLength(0);
  });

  it('single material N consecutive entries with same (layer, posZ, materialHandle) -> 1 bucket, bucketSize=N', () => {
    const N = 5;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 42, layer: 7 }));
      renderables.push(mockRenderable(1.5));
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket).toBeDefined();
    if (bucket === undefined) return;
    expect(bucket.bucketSize).toBe(N);
    expect(bucket.materialHandle).toBe(42);
    expect(bucket.layer).toBe(7);
    expect(bucket.sortKey).toBeCloseTo(1.5);
    expect(bucket.entries).toHaveLength(N);
  });

  it('assembled transforms Float32Array stride=16 (N*16 floats, column-major mat4)', () => {
    const N = 4;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 1, layer: 0 }));
      // Distinct tz per entry so we can verify per-instance slot ordering.
      renderables.push(mockRenderable(2.0));
    }
    // Force distinct world mat4 contents while keeping posZ equal (posZ
    // is at index 14; we mutate index 12 / 13 to assert per-instance copy
    // semantics in the assembled buffer).
    for (let i = 0; i < N; i++) {
      const w = renderables[i]?.transform.world;
      if (w === undefined) continue;
      w[12] = i * 10; // distinct posX
      w[13] = i * 100; // distinct posY
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket).toBeDefined();
    if (bucket === undefined) return;

    expect(bucket.transforms).toBeInstanceOf(Float32Array);
    expect(bucket.transforms.length).toBe(N * 16);
    // Verify each instance slot holds its renderable's world mat4 contents:
    // slot i posX (index 12) === i * 10; slot i posY (index 13) === i * 100;
    // slot i posZ (index 14) === 2.0.
    for (let i = 0; i < N; i++) {
      expect(bucket.transforms[i * 16 + 12]).toBeCloseTo(i * 10);
      expect(bucket.transforms[i * 16 + 13]).toBeCloseTo(i * 100);
      expect(bucket.transforms[i * 16 + 14]).toBeCloseTo(2.0);
      // Identity diagonal preserved
      expect(bucket.transforms[i * 16 + 0]).toBeCloseTo(1);
      expect(bucket.transforms[i * 16 + 5]).toBeCloseTo(1);
      expect(bucket.transforms[i * 16 + 10]).toBeCloseTo(1);
      expect(bucket.transforms[i * 16 + 15]).toBeCloseTo(1);
    }
  });

  it('chunkSize=1 degenerate path: each entry distinct -> N singleton buckets', () => {
    // Distinct posZ per entry -> each becomes its own bucket (no fold).
    const N = 3;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 1, layer: 0 }));
      renderables.push(mockRenderable(i + 0.5)); // distinct posZ
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);
    expect(buckets).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const b = buckets[i];
      expect(b).toBeDefined();
      if (b === undefined) continue;
      expect(b.bucketSize).toBe(1);
      expect(b.transforms.length).toBe(16);
    }
  });
});

// PR #502 hello-room CI red regression + feat-20260625 R2 fix-up:
// geometry-pass entries (non-transparent: standard-PBR / unlit / skin) were
// folded into multi-entry buckets when they shared (layer, posZ,
// materialHandle). The mesh-SSBO upload loop then overwrote their slot
// with identity (because `headBuckets.has(i)` was true), but the
// geometry-pass dispatch loop does NOT branch on `headBuckets` — it kept
// emitting per-entity drawIndexed which then read identity and rendered
// the 3D geometry at the world origin, collapsing the frame to black.
//
// The fix gates fold to transparent entries at the bucket-key level
// (`foldDispatchBuckets` itself), so non-transparent entries always
// produce singleton buckets that `buildFoldDispatchPlan` filters out from
// `headBuckets` / `skipIndices`. The mesh-SSBO upload loop then keeps
// writing the entity's real world matrix for those slots, and both
// dispatch loops behave byte-identically to the pre-fold path.
//
// feat-20260625 R2 fix-up: the gate migrated from `shadingModel ===
// 'sprite'` to `transparent === true` (the M3 ablation collapsed the
// sprite discriminator into the generic transparent flag).
describe('foldDispatchBuckets — transparent-only gate (PR #502 fix + feat-20260625 R2 fix-up)', () => {
  it('transparent Standard PBR entries remain singleton while sprite shaders fold', () => {
    const standardEntries = [0, 1].map((renderableIndex) =>
      mockEntry({
        renderableIndex,
        materialHandle: 13,
        layer: 0,
        materialShaderId: 'forgeax::default-standard-pbr',
      }),
    );
    const standardRenderables = standardEntries.map(() => mockRenderable(1.0, true));
    const standardBuckets = foldDispatchBuckets(
      standardEntries,
      TRANSPARENT_SORT_MODE_LAYER_Z,
      standardRenderables,
    );
    expect(standardBuckets.map((bucket) => bucket.bucketSize)).toEqual([1, 1]);

    for (const materialShaderId of ['forgeax::sprite', 'forgeax::sprite-lit']) {
      const spriteEntries = [0, 1].map((renderableIndex) =>
        mockEntry({ renderableIndex, materialHandle: 13, layer: 0, materialShaderId }),
      );
      const spriteBuckets = foldDispatchBuckets(
        spriteEntries,
        TRANSPARENT_SORT_MODE_LAYER_Z,
        standardRenderables,
      );
      expect(spriteBuckets).toHaveLength(1);
      expect(spriteBuckets[0]?.bucketSize).toBe(2);
    }
  });

  it('non-transparent (unlit-shading) entries never form multi-entry buckets', () => {
    // 4 entries sharing (layer, posZ, materialHandle) — pre-fix would have
    // folded into a single bucketSize=4 bucket. With the transparent-only
    // gate they MUST each be their own singleton.
    const N = 4;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 7, layer: 0 }));
      renderables.push(mockRenderable(1.0, undefined)); // <-- not transparent
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(N);
    for (const b of buckets) {
      expect(b.bucketSize).toBe(1);
    }
  });

  it('standard-PBR (non-transparent) entries never form multi-entry buckets', () => {
    // Standard / PBR materials carry shadingModel=undefined + materialShaderId
    // (feat-20260523-shader-template-instance-split M4-T05). They must also
    // stay singleton — same hello-room CI red root cause (sphereChild +
    // planeChild use Standard, geometry-pass collapsed them to (0,0,0)).
    const N = 3;
    const entries: DispatchEntry[] = [];
    const renderables: ReturnType<typeof mockRenderable>[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(mockEntry({ renderableIndex: i, materialHandle: 9, layer: 0 }));
      renderables.push(mockRenderable(2.0, undefined)); // <-- not transparent
    }

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(N);
    for (const b of buckets) {
      expect(b.bucketSize).toBe(1);
    }
  });

  it('mixed transparent + non-transparent entries: transparent run folds, non-transparent stays singleton', () => {
    // Three transparent entries (fold-eligible) followed by three non-
    // transparent. Result: 1 bucket of size 3 (the transparent run) + 3
    // singletons (one per non-transparent entry).
    const entries: DispatchEntry[] = [
      mockEntry({ renderableIndex: 0, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 1, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 2, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 3, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 4, materialHandle: 11, layer: 0 }),
      mockEntry({ renderableIndex: 5, materialHandle: 11, layer: 0 }),
    ];
    const renderables: ReturnType<typeof mockRenderable>[] = [
      mockRenderable(1.0, true),
      mockRenderable(1.0, true),
      mockRenderable(1.0, true),
      mockRenderable(1.0, undefined),
      mockRenderable(1.0, undefined),
      mockRenderable(1.0, undefined),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(4);
    expect(buckets[0]?.bucketSize).toBe(3); // transparent run
    expect(buckets[1]?.bucketSize).toBe(1); // non-transparent singletons
    expect(buckets[2]?.bucketSize).toBe(1);
    expect(buckets[3]?.bucketSize).toBe(1);
  });

  it('transparent run interrupted by non-transparent breaks fold even with matching key', () => {
    // transparent, transparent, non-transparent, transparent — pre-fix the
    // (layer, posZ, material) equality would have folded all four; the gate
    // now splits at the non-transparent entry (forcing it singleton) and
    // the trailing transparent starts a fresh head (which becomes a
    // singleton bucket since the run ends immediately — no further matching
    // entry follows in this fixture).
    const entries: DispatchEntry[] = [
      mockEntry({ renderableIndex: 0, materialHandle: 2, layer: 0 }),
      mockEntry({ renderableIndex: 1, materialHandle: 2, layer: 0 }),
      mockEntry({ renderableIndex: 2, materialHandle: 2, layer: 0 }),
      mockEntry({ renderableIndex: 3, materialHandle: 2, layer: 0 }),
    ];
    const renderables: ReturnType<typeof mockRenderable>[] = [
      mockRenderable(0.5, true),
      mockRenderable(0.5, true),
      mockRenderable(0.5, undefined), // breaks the run
      mockRenderable(0.5, true),
    ];

    const buckets = foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, renderables);

    expect(buckets).toHaveLength(3);
    expect(buckets[0]?.bucketSize).toBe(2); // transparent run [0,1]
    expect(buckets[1]?.bucketSize).toBe(1); // non-transparent singleton [2]
    expect(buckets[2]?.bucketSize).toBe(1); // transparent singleton [3]
  });
});
