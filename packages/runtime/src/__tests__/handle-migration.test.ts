// M5 w18: unit tests verifying M5 site migration correctness.
// - GPU store Map key uses handleSlot (not unwrapHandle) — AC-09.
// - Tier judgment: gen>0 user handles route to world.sharedRefs.resolve,
//   not BuiltinAssetRegistry.
// - Builtin handles (gen=0) still route to BuiltinAssetRegistry.resolve.
//
// biome-ignore-all lint/suspicious/noExplicitAny: test seams accessing
// private store fields + raw Handle casts via pack().

import {
  BuiltinAssetRegistry,
  HANDLE_CUBE,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { handleSlot, pack } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

describe('M5 handle-migration', () => {
  describe('GPU store Map key uses handleSlot (AC-09)', () => {
    it('textureGpuHandles: slot-based key — gen>0 and gen=0 for same slot hit same entry', () => {
      const store = new GpuResidencyCache();
      const slot = 1050;
      const mockGpuTexture = { isDestroyed: false, destroy: () => ({ ok: true }) } as any;
      const mockEntry = { texture: mockGpuTexture, view: undefined };
      (store as any).textureGpuHandles.set(slot, mockEntry);

      const h0 = pack(slot, 0) as any;
      const h5 = pack(slot, 5) as any;

      expect((store as any).textureGpuHandles.get(handleSlot(h0))).toBe(mockEntry);
      expect((store as any).textureGpuHandles.get(handleSlot(h5))).toBe(mockEntry);
    });

    it('meshGpuHandles: slot-based key — different gen handles hit same entry', () => {
      const store = new GpuResidencyCache();
      const slot = 1055;
      const mockEntry = {
        vertexBuffer: { isDestroyed: false, destroy: () => ({ ok: true }) },
        indexBuffer: null,
        vboBytes: 0,
        iboBytes: 0,
        indexCount: 0,
        indexFormat: 'uint16' as const,
        vertexCount: 0,
        indexed: false,
        topology: 'triangle-list' as const,
        submeshes: [],
      };
      (store as any).meshGpuHandles.set(slot, mockEntry);

      const h0 = pack(slot, 0) as any;
      const h7 = pack(slot, 7) as any;

      expect((store as any).meshGpuHandles.get(handleSlot(h0))).toBe(mockEntry);
      expect((store as any).meshGpuHandles.get(handleSlot(h7))).toBe(mockEntry);
    });

    it('cubemapGpuHandles: slot-based key — different gen handles hit same cubemap entry', () => {
      const store = new GpuResidencyCache();
      const slot = 1060;
      const mockEntry = {
        texture: { isDestroyed: false, destroy: () => ({ ok: true }) },
        view: undefined,
        faceViews: undefined,
      };
      (store as any).cubemapGpuHandles.set(slot, mockEntry);

      const h0 = pack(slot, 0) as any;
      const h3 = pack(slot, 3) as any;

      expect((store as any).cubemapGpuHandles.get(handleSlot(h0))).toBe(mockEntry);
      expect((store as any).cubemapGpuHandles.get(handleSlot(h3))).toBe(mockEntry);
    });

    it('delete path uses handleSlot — gen>0 eviction removes entry stored under slot key', () => {
      const store = new GpuResidencyCache();
      const slot = 1070;
      const mockGpuTexture = { isDestroyed: false, destroy: () => ({ ok: true }) } as any;
      const mockEntry = { texture: mockGpuTexture, view: undefined };
      (store as any).textureGpuHandles.set(slot, mockEntry);

      const h = pack(slot, 9) as any;
      store.evictTexture(h);
      expect((store as any).textureGpuHandles.get(slot)).toBeUndefined();
    });
  });

  describe('tier judgment: resolveAssetHandle routes correctly', () => {
    it('gen=0 builtin handle routes to BuiltinAssetRegistry.resolve', () => {
      const result = resolveAssetHandle(new World(), HANDLE_CUBE as any);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(BuiltinAssetRegistry.resolve(HANDLE_CUBE as any)).toBe(result.value);
      }
    });

    it('gen>0 user handle routes to world.sharedRefs.resolve', () => {
      const world = new World();
      const h = world.allocSharedRef('MeshAsset', {
        kind: 'mesh',
        vertices: new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        indices: new Uint16Array([0, 1, 2]),
        submeshes: [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }],
      } as any);
      const result = resolveAssetHandle(world, h as any);
      expect(result.ok).toBe(true);
    });

    it('gen>0 builtin-slot handle routed via BuiltinAssetRegistry (slot < BUILTIN_BASE)', () => {
      const h = pack(1, 5) as any;
      const builtin = BuiltinAssetRegistry.resolve(h);
      expect(builtin).toBeDefined();
    });

    it('stale gen>0 handle returns shared-ref-stale error from resolveAssetHandle (AC-10)', () => {
      const world = new World();
      const fresh = world.allocSharedRef('MeshAsset', {
        kind: 'mesh',
        vertices: new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        indices: new Uint16Array([0, 1, 2]),
        submeshes: [{ indexOffset: 0, indexCount: 3, topology: 'triangle-list' }],
      } as any);
      const slot = handleSlot(fresh as any);
      const stale = pack(slot, 7) as any;
      const result = resolveAssetHandle(world, stale);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('shared-ref-stale');
      }
    });
  });
});
