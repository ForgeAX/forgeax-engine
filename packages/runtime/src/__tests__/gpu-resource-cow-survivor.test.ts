// feat-20260619 M5 / w18 — AC-11 cow-survivor long-session steady-state
// bounded test covering A-family (texture / mesh / cubemap) through real
// store evict primitives. B-family (instance buffers) and D-family (nested
// WeakMap per-entity cache) single-family boundedness are guarded by w15-w17
// rewritten tests (systems.unit.test.ts / gpu-resource-cow-survivor.test.ts).
// C-family (transient pool) is guarded by w9-w10 through graph.compile+resize.
//
// The survivor negative assertions verify that live resources survive
// round-trip spawn/despawn cycles — the core cow-survivor invariant.
//
// Architecture (plan-strategy D-7): epsilon=0.1 permits WebGPU deferred-destroy
// in-flight double-buffer float, while forbidding monotonic growth.

import type { Result, RhiCaps, RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-rhi';
import type { EquirectAsset, Handle, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { toShared, unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { cleanPerEntityCache } from '../../../render/src/record/mesh-ssbo';

// ── Mock device (same shape as gpu-resource.test.ts makeStoreMockDevice) ──

interface CowProbe {
  bufs: number;
  texs: number;
  views: number;
  destroyedBufs: number;
  destroyedTexs: number;
}

function freshProbe(): CowProbe {
  return { bufs: 0, texs: 0, views: 0, destroyedBufs: 0, destroyedTexs: 0 };
}

const okShim = <T>(v: T) => ({ ok: true as const, value: v });

// biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
function makeMockDevice(probe: CowProbe): any {
  const destroyedBufs = new WeakSet<object>();
  const destroyedTexs = new WeakSet<object>();
  return {
    limits: { maxTextureDimension2D: 16384 },
    createShaderModule: () => okShim({ __mock: 'shader' }),
    createSampler: () => okShim({ __mock: 'sampler' }),
    createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
    createPipelineLayout: () => okShim({ __mock: 'layout' }),
    createRenderPipeline: () => okShim({ __mock: 'pipeline' }),
    createBindGroup: () => okShim({ __mock: 'bindGroup' }),
    createBuffer: (desc: { size?: number }) => {
      probe.bufs += 1;
      return okShim({ __mock: `buffer-${probe.bufs}`, size: desc.size ?? 0 });
    },
    createTexture: () => {
      probe.texs += 1;
      return okShim({ __mock: `texture-${probe.texs}` });
    },
    createTextureView: () => {
      probe.views += 1;
      return okShim({ __mock: `view-${probe.views}` });
    },
    destroyBuffer(buf: object): Result<void, RhiError> {
      if (destroyedBufs.has(buf)) {
        return err(
          Object.assign(new Error('destroy-after-destroy'), {
            code: 'destroy-after-destroy',
            expected: '',
            hint: '',
          }) as unknown as RhiError,
        );
      }
      destroyedBufs.add(buf);
      probe.destroyedBufs += 1;
      return ok(undefined);
    },
    destroyTexture(tex: object): Result<void, RhiError> {
      if (destroyedTexs.has(tex)) {
        return err(
          Object.assign(new Error('destroy-after-destroy'), {
            code: 'destroy-after-destroy',
            expected: '',
            hint: '',
          }) as unknown as RhiError,
        );
      }
      destroyedTexs.add(tex);
      probe.destroyedTexs += 1;
      return ok(undefined);
    },
    queue: {
      writeBuffer: () => okShim(undefined),
      writeTexture: () => okShim(undefined),
      submit: () => okShim(undefined),
    },
  };
}

const mockCaps: RhiCaps = {
  backendKind: 'webgpu',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
};

function makeRegisterCube(): (
  pod: EquirectAsset,
) => Result<Handle<'EquirectAsset', 'shared'>, never> {
  let next = 1000;
  return () => ok(toShared<'EquirectAsset'>(next++));
}

// biome-ignore lint/suspicious/noExplicitAny: shader-module factory shim
const shaderFactory = async (_d: any, desc: { code: string; label?: string }) =>
  ok({ __mock: 'shader', label: desc.label ?? '' }) as never;

function configuredStore(probe: CowProbe): GpuResidencyCache {
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    makeMockDevice(probe),
    shaderFactory,
    makeRegisterCube() as never,
    mockCaps,
  );
  return store;
}

// ── Fixture pods ──

function texturePod(w = 2, h = 2): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: w, height: h } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array(w * h * 4).fill(188),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

function meshPod(vertexCount = 4): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(vertexCount * 12),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: {
      position: new Float32Array(vertexCount * 3),
      normal: new Float32Array(vertexCount * 3),
      uv: new Float32Array(vertexCount * 2),
      tangent: new Float32Array(vertexCount * 4),
    },
    aabb: new Float32Array(6),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

// ── Helpers ──

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    if (a === undefined || b === undefined) return 0;
    return (a + b) / 2;
  }
  return sorted[mid] ?? 0;
}

function aFamilyStoreSize(store: GpuResidencyCache): number {
  // biome-ignore lint/suspicious/noExplicitAny: access private store maps for size tracking
  const s = store as any;
  return (
    (s.textureGpuHandles.size as number) +
    (s.cubemapGpuHandles.size as number) +
    (s.meshGpuHandles.size as number)
  );
}

// ── Cow-survivor test suite ──

describe('cow-survivor long-session steady-state bounded (AC-11) [w18]', () => {
  it('A-family steady-state bounded: peak <= baseline * 1.1 across rounds', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    const N = 50;
    const WARMUP = 25;
    const totalSizes: number[] = [];

    const survivorTexHandle = toShared<'TextureAsset'>(80000);
    const survivorMeshHandle = toShared<'MeshAsset'>(90000);
    let survivorSpawned = false;

    for (let round = 0; round < N; round++) {
      // ── Spawn ──
      const texHandles: Handle<'TextureAsset', 'shared'>[] = [];
      for (let i = 0; i < 3; i++) {
        const h = toShared<'TextureAsset'>(10000 + round * 100 + i);
        const res = store.ensureResident(h, texturePod());
        if (res.ok) texHandles.push(h);
      }

      const meshHandles: Handle<'MeshAsset', 'shared'>[] = [];
      for (let i = 0; i < 2; i++) {
        const h = toShared<'MeshAsset'>(20000 + round * 100 + i);
        const res = store.ensureResident(h, meshPod());
        if (res.ok) meshHandles.push(h);
      }

      if (!survivorSpawned) {
        store.ensureResident(survivorTexHandle, texturePod());
        store.ensureResident(survivorMeshHandle, meshPod());
        survivorSpawned = true;
      }

      totalSizes.push(aFamilyStoreSize(store));

      // ── Despawn ──
      for (const h of texHandles) store.evictTexture(h);
      for (const h of meshHandles) store.evictMesh(h);

      // Verify survivor intact after despawn
      if (survivorSpawned) {
        const tex = store._getTextureGpuTexture(survivorTexHandle);
        expect(tex).toBeDefined();
        expect(tex?.isDestroyed).toBe(false);

        const entry = store.getMeshGpuHandles(survivorMeshHandle);
        expect(entry).toBeDefined();
        expect(entry?.vertexBuffer.isDestroyed).toBe(false);
      }
    }

    const warmupSlice = totalSizes.slice(0, WARMUP);
    const testSlice = totalSizes.slice(WARMUP);

    const baseline = median([...warmupSlice].sort((a, b) => a - b));
    const peak = Math.max(...testSlice);

    expect(peak).toBeLessThanOrEqual(baseline * 1.1);

    // After final evictions: survivor texture + mesh remain.
    // biome-ignore lint/suspicious/noExplicitAny: access private store maps
    const sf = store as any;
    expect(sf.textureGpuHandles.size).toBe(1);
    expect(sf.meshGpuHandles.size).toBe(1);

    // Equal vertex bytes share one VBO. Only the survivor texture, shared
    // vertex buffer and survivor index buffer may remain allocated.
    expect(probe.texs - probe.destroyedTexs).toBe(1);
    expect(probe.bufs - probe.destroyedBufs).toBe(2);
    store.evictTexture(survivorTexHandle);
    store.evictMesh(survivorMeshHandle);
    expect(probe.destroyedTexs).toBe(probe.texs);
    expect(probe.destroyedBufs).toBe(probe.bufs);
  });

  it('no monotonic growth: second half slope ~ 0', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    const N = 50;
    const sizes: number[] = [];

    for (let round = 0; round < N; round++) {
      const texHandles: Handle<'TextureAsset', 'shared'>[] = [];
      for (let i = 0; i < 3; i++) {
        const h = toShared<'TextureAsset'>(40000 + round * 100 + i);
        store.ensureResident(h, texturePod());
        texHandles.push(h);
      }

      sizes.push(aFamilyStoreSize(store));

      for (const h of texHandles) store.evictTexture(h);
    }

    // Second half should have near-zero slope.
    const secondHalf = sizes.slice(25);
    const minS2 = Math.min(...secondHalf);
    const maxS2 = Math.max(...secondHalf);
    expect(maxS2 - minS2).toBeLessThanOrEqual(2);
  });

  it('survivor entity not evicted: negative assertion', () => {
    const probe = freshProbe();
    const store = configuredStore(probe);

    const survivorHandle = toShared<'TextureAsset'>(99901);
    store.ensureResident(survivorHandle, texturePod());

    const tex = store._getTextureGpuTexture(survivorHandle);
    expect(tex).toBeDefined();
    expect(tex?.isDestroyed).toBe(false);

    for (let round = 0; round < 20; round++) {
      const handles: Handle<'TextureAsset', 'shared'>[] = [];
      for (let i = 0; i < 2; i++) {
        const h = toShared<'TextureAsset'>(60000 + round * 100 + i);
        store.ensureResident(h, texturePod());
        handles.push(h);
      }

      for (const h of handles) store.evictTexture(h);

      const t = store._getTextureGpuTexture(survivorHandle);
      expect(t).toBeDefined();
      expect(t?.isDestroyed).toBe(false);
    }

    // releaseUnreferenced: survivor in liveSet keeps resource
    const liveSet = new Set<number>([unwrapHandle(survivorHandle)]);
    store.releaseUnreferenced(liveSet);

    const t2 = store._getTextureGpuTexture(survivorHandle);
    expect(t2).toBeDefined();
    expect(t2?.isDestroyed).toBe(false);

    // When survivor is removed from liveSet, it IS evicted
    store.releaseUnreferenced(new Set());
    expect(store._getTextureGpuTexture(survivorHandle)).toBeUndefined();
  });

  it('D-family nested WeakMap steady-state bounded (AC-04)', () => {
    // AC-04: outer Map<number, WeakMap> bounded across multi-frame
    // spawn/despawn cycles. cleanPerEntityCache delete removes despawned
    // entityKeys; GC collects unreachable inner WeakMaps. No numeric
    // counter or nextHandleId — bound is proven by Map.size stability.
    const cache = new Map<number, WeakMap<object, unknown>>();

    const maxConcurrent = 5;
    const rounds = 100;

    const sizes: number[] = [];

    for (let round = 0; round < rounds; round++) {
      // Spawn `maxConcurrent` fresh entities
      for (let i = 0; i < maxConcurrent; i++) {
        const ek = round * maxConcurrent + i;
        const inner = new WeakMap<object, unknown>();
        inner.set({}, { __mock: 'bg' });
        cache.set(ek, inner);
      }

      // Validate current-round entityKeys, clean stale ones
      const validated = new Set<number>();
      for (let i = 0; i < maxConcurrent; i++) {
        validated.add(round * maxConcurrent + i);
      }
      cleanPerEntityCache(cache, validated);

      // Record size AFTER cleanup so we measure steady-state boundedness
      sizes.push(cache.size);
    }

    // After all rounds, the last round's validated keys remain;
    // all previous-round keys were deleted. Size must stay at
    // maxConcurrent or fewer (not monotonic growth to rounds * maxConcurrent).
    const steadySizes = sizes.slice(50);
    const maxSteady = Math.max(...steadySizes);
    const minSteady = Math.min(...steadySizes);
    // At steady state, cache size is bounded at maxConcurrent
    expect(maxSteady).toBeLessThanOrEqual(maxConcurrent + 1);
    // Cleanup ensures entries from prior rounds don't accumulate
    // (size never grows beyond maxConcurrent across all rounds)
    const overallMax = Math.max(...sizes);
    expect(overallMax).toBeLessThanOrEqual(maxConcurrent + 1);

    // Final validated set size equals maxConcurrent
    expect(cache.size).toBe(maxConcurrent);

    // verify that max-min spread is tight (no accumulation/deletion jitter)
    expect(maxSteady - minSteady).toBeLessThanOrEqual(1);
  });
});
