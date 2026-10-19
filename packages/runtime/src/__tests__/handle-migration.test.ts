// M5 w18: unit tests verifying M5 site migration correctness.
// - Texture and mesh residency retain complete handle generations.
// - Cubemap projection retains its source-slot lookup contract.
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
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import type { Handle, TextureAsset } from '@forgeax/engine-types';
import { handleSlot, pack } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

describe('M5 handle-migration', () => {
  describe('GPU residency handle identity', () => {
    async function setup() {
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const store = new GpuResidencyCache();
      store.configureGpuDevice(
        device,
        undefined,
        () => {
          throw new Error('cubemap projection is outside this fixture');
        },
        device.caps,
      );
      return store;
    }

    const texture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    };

    it('keeps gen=0 and gen>0 textures in the same slot independently resident', async () => {
      const store = await setup();
      try {
        const h0 = pack(1050, 0) as Handle<'TextureAsset', 'shared'>;
        const h5 = pack(1050, 5) as Handle<'TextureAsset', 'shared'>;
        const first = store.ensureResident(h0, texture).unwrap();
        expect(store.getTextureGpuView(h5)).toBeUndefined();
        const next = store.ensureResident(h5, texture).unwrap();
        expect(next.view).not.toBe(first.view);
        expect(store.getTextureGpuView(h0)).toBe(first.view);
        expect(store.getTextureGpuView(h5)).toBe(next.view);
      } finally {
        store.destroyAll();
      }
    });

    it('evicts one mesh generation without retiring another in the same slot', async () => {
      const store = await setup();
      try {
        const h0 = pack(1055, 0) as Handle<'MeshAsset', 'shared'>;
        const h7 = pack(1055, 7) as Handle<'MeshAsset', 'shared'>;
        const first = store.ensureResident(h0, createBoxGeometry(1, 1, 1).unwrap()).unwrap();
        expect(store.getMeshGpuHandles(h7)).toBeUndefined();
        const next = store.ensureResident(h7, createBoxGeometry(2, 2, 2).unwrap()).unwrap();
        expect(next).not.toBe(first);
        expect(store.getMeshGpuHandles(h0)).toBe(first);
        store.evictMesh(h0);
        expect(store.getMeshGpuHandles(h0)).toBeUndefined();
        expect(store.getMeshGpuHandles(h7)).toBe(next);
        expect(next.vertexBuffer.isDestroyed).toBe(false);
      } finally {
        store.destroyAll();
      }
    });

    it('retains only the requested cubemap generation when sweeping complete handles', () => {
      const store = new GpuResidencyCache();
      const destroy = vi.fn(() => ({ ok: true }));
      const mockGpuTexture = { isDestroyed: false, destroy };
      const slot = 1060;
      (store as any).cubemapGpuHandles.set(
        pack(slot, 3),
        {
          texture: mockGpuTexture,
          view: undefined,
          faceViews: [],
        },
        0,
      );
      const h0 = pack(slot, 0) as Handle<'EquirectAsset', 'shared'>;
      const h3 = pack(slot, 3) as Handle<'EquirectAsset', 'shared'>;
      expect(store.getCubemapGpuTexture(h0)).toBeUndefined();
      expect(store.getCubemapGpuTexture(h3)).toBe(mockGpuTexture);
      expect(store.releaseUnreferenced(new Set([Number(h3)])).freed).toBe(0);
      expect(destroy).not.toHaveBeenCalled();
      expect(store.getCubemapGpuTexture(h3)).toBe(mockGpuTexture);
      expect(store.releaseUnreferenced(new Set()).freed).toBe(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(store.getCubemapGpuTexture(h3)).toBeUndefined();
    });

    it('evicts exactly the requested texture generation and ignores stale retirement', async () => {
      const store = await setup();
      try {
        const h8 = pack(1070, 8) as Handle<'TextureAsset', 'shared'>;
        const h9 = pack(1070, 9) as Handle<'TextureAsset', 'shared'>;
        const first = store.ensureResident(h8, texture).unwrap();
        const next = store.ensureResident(h9, texture).unwrap();
        expect(store.evictTexture(h8).freed).toBe(1);
        expect(first.texture.isDestroyed).toBe(true);
        expect(store.getTextureGpuView(h8)).toBeUndefined();
        expect(store.getTextureGpuView(h9)).toBe(next.view);
        expect(next.texture.isDestroyed).toBe(false);
        expect(store.evictTexture(h8).freed).toBe(0);
        expect(store.getTextureGpuView(h9)).toBe(next.view);
        expect(store.evictTexture(h9).freed).toBe(1);
        expect(next.texture.isDestroyed).toBe(true);
        expect(store.getTextureGpuView(h9)).toBeUndefined();
      } finally {
        store.destroyAll();
      }
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
