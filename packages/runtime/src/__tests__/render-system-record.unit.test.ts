// render-system-record.unit.test.ts
// feat-20260615-pipeline-spec-ssot M6-T1-TEST.
//
// Reverse-evidence ("falsify the silent fallback") tests for the M6-T1
// deletion of `selectStandardFallbackPipeline`. The pre-M6 record stage
// silently fell back to URP `pipelineState.standardPipeline*` whenever the
// per-MaterialShader cache returned null and HDRP was inactive. M6 removes
// that branch: cache miss now resolves to null and the per-submesh draw is
// skipped (mirroring the HDRP-active and skin-shader miss-skip semantics
// that existed before). The fallback path is no longer reachable.
//
// What this file asserts:
//   1. The exported `selectStandardFallbackPipeline` symbol is gone --
//      grep gate at runtime via `import * as mod`.
//   2. `getOrBuildPipeline` throws `PipelineSpecError` on a build failure
//      rather than returning a silently-substituted boot-time fallback.
//      This is the charter P3 explicit-failure invariant the M6 cleanup
//      preserves end-to-end (no silent route remains in the chain).
//   3. The MSAA route (sampleCount=4) takes a distinct cache slot from the
//      non-MSAA route -- evidence that the record stage never folds the
//      MSAA path back onto a non-MSAA boot-prewarmed pipeline (the old
//      `selectGeometryPipeline(... 'standard', tonemapActive, msaaActive)`
//      branch did exactly that fold via the `*PipelineMsaa` field hand-off).
//
// Anchors:
//   - plan-strategy §M6 / D-2: silent fallback removal is the core invariant.
//   - implement-decisions §M6-T1: dedicated function + 1 record-stage call
//     site (line ~5080) go; the only remaining path through "shader cache
//     returned null" is `smPipelineHandle === null -> continue` skip-draw.

import { describe, expect, it } from 'vitest';
import type { InstanceBufferCacheEntry } from '../../../render/src/instance-buffer-cache';
import {
  cacheKeyOf,
  getOrBuildPipeline,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from '../../../render/src/pipeline-spec';
import {
  interleaveSpriteInstanceBuffer,
  type SpriteInstancesSnapshot,
  spriteInstancesCacheHit,
} from '../../../render/src/record/sprite-instance-buffer';

const SPEC_BASE: PipelineSpec = {
  shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
  attachments: {
    colorFormats: ['bgra8unorm-srgb' as unknown as GPUTextureFormat],
    depthFormat: 'depth24plus-stencil8' as unknown as GPUTextureFormat,
    sampleCount: 1,
  },
  geometry: {
    topology: 'triangle-list',
    vertexLayout: {
      position: new Float32Array(0),
    },
  },
  renderState: undefined,
};

const SPEC_MSAA: PipelineSpec = {
  ...SPEC_BASE,
  attachments: { ...SPEC_BASE.attachments, sampleCount: 4 },
};

describe('render-system-record M6-T1 silent fallback removal', () => {
  it('selectStandardFallbackPipeline export is gone (grep gate)', async () => {
    const mod = await import('@forgeax/engine-render');
    expect((mod as Record<string, unknown>).selectStandardFallbackPipeline).toBeUndefined();
  });

  it('getOrBuildPipeline throws PipelineSpecError on build failure (no silent fallback)', () => {
    const cache = new Map();
    const deviceProvider: PipelineDeviceProvider = {
      createRenderPipeline: () => ({
        ok: false,
        error: { code: 'webgpu-runtime-error', message: 'simulated build failure' },
      }),
    };
    let caught: unknown;
    try {
      getOrBuildPipeline(SPEC_BASE, deviceProvider, cache);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineSpecError);
    expect((caught as PipelineSpecError).code).toBe('pipeline-build-failed');
    // Critical: no boot-time URP `standardPipeline` is substituted for the
    // failure. Charter P3 explicit failure surfaces upward; the record
    // stage's `if (smPipelineHandle === null) continue` then skip-draws.
  });

  it('MSAA route takes a distinct cache slot from non-MSAA (sampleCount=4)', () => {
    const baseKey = cacheKeyOf(SPEC_BASE);
    const msaaKey = cacheKeyOf(SPEC_MSAA);
    expect(baseKey).not.toBe(msaaKey);
    // The pre-M6 silent fallback could route an MSAA frame through a
    // boot-prewarmed standard handle even when the per-shader cache missed,
    // collapsing the MSAA spec onto the sampleCount=1 slot.
    // M6 removes that path; identity of the cache key is the witness that
    // sampleCount is part of the hash and never folds onto sampleCount=1.
  });
});

// ─── feat-20260625 M3 / w9 — sprite-pass 80B interleaved single-buffer cache ──
//
// TDD-RED contract for the sprite-pass `SpriteInstances` upload path. The
// plan-strategy §2 D-1 invariant:
//
//   The per-entity `SpriteInstances` carries mat4 transforms (16f, 64B) and
//   per-instance UV regions (vec4, 4f, 16B). They share the same instance
//   count and ride a SINGLE GPU buffer (one binding slot @group(3) @binding(0))
//   with interleaved layout 80B per instance:
//     [mat4(16f), region(4f), mat4(16f), region(4f), ...]
//
//   The record stage MUST:
//     - upload `transforms.byteLength + regions.byteLength` bytes (= 80*N);
//     - cache the GpuBuffer keyed by the entity packed u32 (cacheKey from the
//       extract snapshot — D-9);
//     - reuse the buffer iff (uploadedArchVersion === snapshot.archVersion
//       AND uploadedByteLength === requestedBytes); otherwise destroy + realloc.
//
// Sub-assertions covered (5):
//   (a) `interleaveSpriteInstanceBuffer(transforms, regions)` produces a
//       Float32Array of length `N * (16 + 4) === N * 20` and total byte length
//       `transforms.byteLength + regions.byteLength` (= 80*N).
//   (b) Per-instance layout: byte [0..64) is the mat4, byte [64..80) is the
//       region; second instance starts at byte 80. Probe values: distinct mat4
//       and region per instance verify the interleave ordering.
//   (c) Cache hit fires when both `archVersion` and `byteLength` match — the
//       same buffer instance is reused (no `createBuffer` round).
//   (d) Cache miss fires (byteLength change): byteLength delta marks the cache
//       fingerprint invalid; the record stage must replace the entry.
//   (e) Reverse-evidence: same `cacheKey` but `byteLength` changes -> cache
//       miss (fingerprint triple is *all three* values; cacheKey alone is not
//       sufficient).
//
// Anchors:
//   - requirements AC-05 (sprite-pass 80B interleave + record-stage upload)
//   - plan-strategy §2 D-1 (interleaved single buffer + single binding slot)
//   - plan-strategy §2 D-9 (cacheKey still packed Entity u32)
//   - research §Q-R-2.2 (cache fingerprint triple), §Q-R-2.4 (BGL untouched)

const TRANSFORMS_PER_INSTANCE = 16;
const REGIONS_PER_INSTANCE = 4;
const BYTES_PER_INSTANCE = 80; // 64 (mat4) + 16 (region)

function makeTransforms(count: number, seed: number): Float32Array {
  const out = new Float32Array(count * TRANSFORMS_PER_INSTANCE);
  for (let i = 0; i < out.length; i++) out[i] = seed + i;
  return out;
}

function makeRegions(count: number, seed: number): Float32Array {
  const out = new Float32Array(count * REGIONS_PER_INSTANCE);
  for (let i = 0; i < out.length; i++) out[i] = seed + i;
  return out;
}

// Minimal `GpuBuffer`-shaped stand-in for the cache entry — the cache test
// only exercises fingerprint comparison; buffer-internal behaviour is OOS.
const MOCK_BUFFER = {
  handle: { id: 'mock' } as unknown,
  isDestroyed: false,
  destroy: () => ({ ok: true as const, value: undefined }),
  // biome-ignore lint/suspicious/noExplicitAny: stand-in, full shape unused
} as any;

describe('render-system-record sprite-pass 80B interleaved upload (w9, AC-05)', () => {
  it('(a) interleaveSpriteInstanceBuffer length === N * (16 + 4) === transforms.byteLength + regions.byteLength', () => {
    const N = 4;
    const transforms = makeTransforms(N, 0);
    const regions = makeRegions(N, 1000);
    const out = interleaveSpriteInstanceBuffer(transforms, regions);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(N * (TRANSFORMS_PER_INSTANCE + REGIONS_PER_INSTANCE));
    expect(out.byteLength).toBe(transforms.byteLength + regions.byteLength);
    expect(out.byteLength).toBe(N * BYTES_PER_INSTANCE);
  });

  it('(b) per-instance layout: mat4 @ [0..16), region @ [16..20); second instance @ [20..40)', () => {
    const N = 2;
    // Distinct probe values: instance 0 mat4=[100..115], region=[200..203];
    //                       instance 1 mat4=[300..315], region=[400..403].
    const transforms = new Float32Array([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 300, 301, 302,
      303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315,
    ]);
    const regions = new Float32Array([200, 201, 202, 203, 400, 401, 402, 403]);
    const out = interleaveSpriteInstanceBuffer(transforms, regions);
    expect(out.length).toBe(N * 20);
    // Instance 0
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(100 + i);
    for (let i = 0; i < 4; i++) expect(out[16 + i]).toBe(200 + i);
    // Instance 1
    for (let i = 0; i < 16; i++) expect(out[20 + i]).toBe(300 + i);
    for (let i = 0; i < 4; i++) expect(out[36 + i]).toBe(400 + i);
  });

  it('(c) cache hit when (archVersion, byteLength) both match (cacheKey + triple fingerprint, D-9)', () => {
    const cache = new Map<number, InstanceBufferCacheEntry>();
    const entityKey = 7;
    const snap: SpriteInstancesSnapshot = {
      transforms: makeTransforms(4, 0),
      regions: makeRegions(4, 0),
      instanceCount: 4,
      cacheKey: entityKey,
      archVersion: 1,
    };
    const requestedBytes = snap.transforms.byteLength + snap.regions.byteLength;
    cache.set(entityKey, {
      buffer: MOCK_BUFFER,
      uploadedArchVersion: 1,
      uploadedByteLength: requestedBytes,
    });
    expect(spriteInstancesCacheHit(cache.get(entityKey), snap, requestedBytes)).toBe(true);
  });

  it('(d) cache miss when archVersion bumps (archetype grew/reallocated)', () => {
    const cache = new Map<number, InstanceBufferCacheEntry>();
    const entityKey = 9;
    const snap: SpriteInstancesSnapshot = {
      transforms: makeTransforms(4, 0),
      regions: makeRegions(4, 0),
      instanceCount: 4,
      cacheKey: entityKey,
      archVersion: 2,
    };
    const requestedBytes = snap.transforms.byteLength + snap.regions.byteLength;
    cache.set(entityKey, {
      buffer: MOCK_BUFFER,
      uploadedArchVersion: 1, // stale
      uploadedByteLength: requestedBytes,
    });
    expect(spriteInstancesCacheHit(cache.get(entityKey), snap, requestedBytes)).toBe(false);
  });

  it('(e) reverse-evidence: same cacheKey but byteLength changes -> cache miss', () => {
    const cache = new Map<number, InstanceBufferCacheEntry>();
    const entityKey = 11;
    // First record: 4 instances.
    const snap4: SpriteInstancesSnapshot = {
      transforms: makeTransforms(4, 0),
      regions: makeRegions(4, 0),
      instanceCount: 4,
      cacheKey: entityKey,
      archVersion: 1,
    };
    const requestedBytes4 = snap4.transforms.byteLength + snap4.regions.byteLength;
    cache.set(entityKey, {
      buffer: MOCK_BUFFER,
      uploadedArchVersion: 1,
      uploadedByteLength: requestedBytes4,
    });
    // Second record on the same entity: 8 instances (grew). archVersion stays
    // at 1 to isolate the byteLength axis -- only the byte count changed.
    const snap8: SpriteInstancesSnapshot = {
      transforms: makeTransforms(8, 0),
      regions: makeRegions(8, 0),
      instanceCount: 8,
      cacheKey: entityKey,
      archVersion: 1,
    };
    const requestedBytes8 = snap8.transforms.byteLength + snap8.regions.byteLength;
    expect(requestedBytes8).not.toBe(requestedBytes4);
    expect(spriteInstancesCacheHit(cache.get(entityKey), snap8, requestedBytes8)).toBe(false);
  });
});
