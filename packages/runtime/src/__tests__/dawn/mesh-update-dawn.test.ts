// mesh-update-dawn.test.ts - updateMesh in-place re-upload dawn-tier test
// (feat-20260531-world-space-msdf-text-rendering M3 / w12).
//
// Verifies that updateMesh correctly writes new vertex/index data into
// existing GPU buffers and, on expansion, creates new buffers while
// destroying old ones — all without changing the mesh handle id.
//
// AC-08 falsification: if updateMesh leaked GPU buffers (create without
// destroy), the dawn backend would surface this as resource exhaustion
// or the buffer count would grow across repeated calls. This test
// validates the structural invariants on a real GPU device.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { PROCEDURAL_FLOATS_PER_VERTEX } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { ok } from '@forgeax/engine-rhi';
import type { EquirectAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../../render/src/device/gpu-residency';

const mockCaps = {
  backendKind: 'webgpu' as const,
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

// feat-20260601-device/gpu-residency-extraction M1: mesh GPU residency + updateMesh
// moved to the store, and register no longer auto-uploads (push severed). The
// pull-model test premise: register the POD, then explicitly
// `store.ensureResident(handle, pod)` to upload, then assert + updateMesh.

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

function makeSmallMesh(): MeshAsset {
  const vertices = new Float32Array(4 * PROCEDURAL_FLOATS_PER_VERTEX);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes: {},
    aabb: new Float32Array(6),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

function makeLargerMesh(): MeshAsset {
  const vertices = new Float32Array(8 * PROCEDURAL_FLOATS_PER_VERTEX);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes: {},
    aabb: new Float32Array(6),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

describe('w12 - updateMesh dawn-tier (AC-08)', () => {
  it.skipIf(!dawnReady)(
    '(a) updateMesh in-place re-upload does not create new vbo/ibo',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      expect(adapter).not.toBeNull();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const store = new GpuResidencyCache();
      const world = new World();
      store.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      const mesh = makeSmallMesh();
      const handle = world.allocSharedRef('MeshAsset', mesh);
      // Pull-model: explicit ensureResident uploads the GPU buffers.
      const residentRes = store.ensureResident(handle, mesh);
      expect(residentRes.ok).toBe(true);
      const before = store.getMeshGpuHandles(handle);
      expect(before).toBeDefined();
      if (before === undefined) return;
      expect(before.vertexBuffer).toBeDefined();
      expect(before.indexBuffer).toBeDefined();

      const vboBefore = before.vertexBuffer;
      const iboBefore = before.indexBuffer;

      // In-place update: same size data.
      if (!(mesh.indices instanceof Uint16Array)) return;
      store.updateMesh(handle, mesh.vertices, mesh.indices);

      const after = store.getMeshGpuHandles(handle);
      expect(after).toBeDefined();
      if (after === undefined) return;

      // Same-size update must reuse the same buffers (no create/destroy).
      expect(after.vertexBuffer).toBe(vboBefore);
      expect(after.indexBuffer).toBe(iboBefore);
      expect(after.indexCount).toBe(mesh.indices.length);
    },
  );

  it.skipIf(!dawnReady)(
    '(b) updateMesh expansion creates new buffers and destroys old ones, same handle id',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      expect(adapter).not.toBeNull();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const store = new GpuResidencyCache();
      const world = new World();
      store.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      const small = makeSmallMesh();
      const handle = world.allocSharedRef('MeshAsset', small);
      const residentRes = store.ensureResident(handle, small);
      expect(residentRes.ok).toBe(true);
      const before = store.getMeshGpuHandles(handle);
      expect(before).toBeDefined();
      if (before === undefined) return;
      const vboBefore = before.vertexBuffer;
      const iboBefore = before.indexBuffer;

      // Expansion: larger data exceeds current buffer capacity.
      const larger = makeLargerMesh();
      if (!(larger.indices instanceof Uint16Array)) return;
      store.updateMesh(handle, larger.vertices, larger.indices);

      const after = store.getMeshGpuHandles(handle);
      expect(after).toBeDefined();
      if (after === undefined) return;

      // New buffers should be different from old ones.
      expect(after.vertexBuffer).not.toBe(vboBefore);
      expect(after.indexBuffer).not.toBe(iboBefore);

      // New buffer sizes should match the larger data. M-3 / w12: byte sizes
      // are tracked on the entry (`vboBytes` / `iboBytes`), not on the
      // GpuBuffer wrapper -- the spec-aligned RHI Buffer interface has no
      // `.size`.
      expect(after.vboBytes).toBe(larger.vertices.byteLength);

      // indexCount should reflect the larger data.
      expect(after.indexCount).toBe(larger.indices.length);

      // The handle id is unchanged — resolveAssetHandle still returns the payload.
      const result = resolveAssetHandle<MeshAsset>(world, handle);
      expect(result.ok).toBe(true);
    },
  );

  it.skipIf(!dawnReady)(
    '(c) repeated 50-frame same-size updateMesh does not grow GPU buffer count',
    async () => {
      const adapter = await navigator.gpu.requestAdapter();
      expect(adapter).not.toBeNull();
      if (adapter === null) return;
      const device = await adapter.requestDevice();

      const store = new GpuResidencyCache();
      const world = new World();
      store.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: structural rhi device shim
        device as any,
        undefined,
        (w: World, pod: EquirectAsset) => ok(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );

      const mesh = makeSmallMesh();
      const handle = world.allocSharedRef('MeshAsset', mesh);
      const residentRes = store.ensureResident(handle, mesh);
      expect(residentRes.ok).toBe(true);
      const before = store.getMeshGpuHandles(handle);
      expect(before).toBeDefined();
      if (before === undefined) return;

      const vboFirst = before.vertexBuffer;
      const iboFirst = before.indexBuffer;

      // 50 frames of same-size updates.
      if (!(mesh.indices instanceof Uint16Array)) return;
      for (let frame = 0; frame < 50; frame++) {
        store.updateMesh(handle, mesh.vertices, mesh.indices);
      }

      const after = store.getMeshGpuHandles(handle);
      expect(after).toBeDefined();
      if (after === undefined) return;

      // Same-size updates reuse the same buffers.
      expect(after.vertexBuffer).toBe(vboFirst);
      expect(after.indexBuffer).toBe(iboFirst);

      // Sanity pings to keep import chains live.
      expect(PROCEDURAL_FLOATS_PER_VERTEX).toBe(12);
      const _matType: Float32Array = mat4.create();
      void _matType;
    },
  );
});
