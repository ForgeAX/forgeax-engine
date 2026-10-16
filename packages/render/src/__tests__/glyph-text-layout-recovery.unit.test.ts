import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset, GlyphMetric, Handle, MeshAsset } from '@forgeax/engine-types';
import { TextError } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { GlyphText } from '../components/glyph-text';
import { GpuResidencyCache } from '../device/gpu-residency';
import { glyphTextLayoutSystem, resetGlyphBakeCache } from '../glyph-text-layout-system';

function metric(): GlyphMetric {
  return {
    advance: 10,
    bearingX: 0,
    bearingY: 8,
    size: { w: 8, h: 8 },
    region: { x: 0, y: 0, w: 8, h: 8 },
  };
}

function makeFont(): FontAsset {
  const glyphs = Object.fromEntries([65, 66, 67, 72, 105].map((code) => [String(code), metric()]));
  return {
    kind: 'font',
    atlas: AssetGuid.random(),
    sampler: AssetGuid.random(),
    glyphs,
    common: {
      lineHeight: 12,
      base: 8,
      distanceRange: 4,
      pxRange: 4,
      atlasWidth: 64,
      atlasHeight: 64,
    },
  };
}

function registerFont(world: World): number {
  return world.allocSharedRef('FontAsset', makeFont()) as unknown as number;
}

function spawnLabel(world: World, fontHandle: number): EntityHandle {
  return world
    .spawn({
      component: GlyphText,
      data: {
        fontHandle: fontHandle as unknown as Handle<'FontAsset', 'shared'>,
        text: 'A',
        fontSize: 1,
        color: [1, 1, 1, 1],
      },
    })
    .unwrap();
}

describe('glyph-text-layout-system font-cap recovery', () => {
  const gpuStore = new GpuResidencyCache();

  beforeEach(() => resetGlyphBakeCache());

  it('clears the rejected ninth label and rebuilds it on the next frame', () => {
    const world = new World();
    const fonts = Array.from({ length: 9 }, () => registerFont(world));
    const prefix = fonts.slice(0, 8).map((fontHandle) => spawnLabel(world, fontHandle));
    const rejected = spawnLabel(world, fonts[0] as number);
    const unrelated = world.spawn({ component: Transform, data: { pos: [2, 3, 0] } }).unwrap();

    expect(glyphTextLayoutSystem(world, gpuStore).ok).toBe(true);
    const oldMeshHandle = (world.get(rejected, MeshFilter).unwrap() as { assetHandle: number })
      .assetHandle;
    const oldMaterialHandle = Number(
      (world.get(rejected, MeshRenderer).unwrap() as unknown as { materials: readonly number[] })
        .materials[0] ?? 0,
    );
    const baselineLiveRefs = world.sharedRefs._liveCount();

    world
      .set(rejected, GlyphText, {
        fontHandle: fonts[8] as unknown as Handle<'FontAsset', 'shared'>,
      })
      .unwrap();
    const overflow = glyphTextLayoutSystem(world, gpuStore);

    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error).toBeInstanceOf(TextError);
      expect(overflow.error.code).toBe('font-concurrency-exceeded');
      expect(overflow.error.expected).toBe('8');
      expect(overflow.error.detail).toEqual({
        active: 8,
        limit: 8,
        rejected: fonts[8],
      });
    }
    expect(world.get(rejected, MeshFilter).ok).toBe(false);
    expect(world.get(rejected, MeshRenderer).ok).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(baselineLiveRefs - 2);
    for (const entity of prefix) {
      expect(world.get(entity, MeshFilter).ok).toBe(true);
      expect(world.get(entity, MeshRenderer).ok).toBe(true);
    }
    expect(world.get(unrelated, Transform).ok).toBe(true);

    world
      .set(rejected, GlyphText, {
        fontHandle: fonts[1] as unknown as Handle<'FontAsset', 'shared'>,
      })
      .unwrap();
    expect(glyphTextLayoutSystem(world, gpuStore).ok).toBe(true);

    const rebuiltMeshHandle = (world.get(rejected, MeshFilter).unwrap() as { assetHandle: number })
      .assetHandle;
    const rebuiltMaterialHandle = Number(
      (world.get(rejected, MeshRenderer).unwrap() as unknown as { materials: readonly number[] })
        .materials[0] ?? 0,
    );
    expect(rebuiltMeshHandle).not.toBe(oldMeshHandle);
    expect(rebuiltMaterialHandle).not.toBe(oldMaterialHandle);
    const rebuiltMesh = resolveAssetHandle<MeshAsset>(
      world,
      rebuiltMeshHandle as unknown as Handle<'MeshAsset', 'shared'>,
    );
    expect(rebuiltMesh.ok).toBe(true);
    if (rebuiltMesh.ok) {
      expect(rebuiltMesh.value.indices?.length).toBe(6);
      expect(rebuiltMesh.value.vertices.length).toBeGreaterThan(0);
    }
    expect(world.sharedRefs._liveCount()).toBe(baselineLiveRefs);
    expect(glyphTextLayoutSystem(world, gpuStore).ok).toBe(true);
    expect(world.sharedRefs._liveCount()).toBe(baselineLiveRefs);

    world.despawn(rejected).unwrap();
    expect(glyphTextLayoutSystem(world, gpuStore).ok).toBe(true);
    const afterCleanup = world.sharedRefs._liveCount();
    expect(glyphTextLayoutSystem(world, gpuStore).ok).toBe(true);
    expect(world.sharedRefs._liveCount()).toBe(afterCleanup);
  });

  it('replaces a resident GPU mesh when text changes its vertex shape', () => {
    const updateMesh = vi.fn();
    const residentStore = { updateMesh } as unknown as GpuResidencyCache;
    const world = new World();
    const font = registerFont(world);
    const label = spawnLabel(world, font);

    expect(glyphTextLayoutSystem(world, residentStore).ok).toBe(true);
    const meshHandle = (world.get(label, MeshFilter).unwrap() as { assetHandle: number })
      .assetHandle;
    const before = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle as never);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const oldVertexLength = before.value.vertices.length;

    world.set(label, GlyphText, { text: 'ABC' }).unwrap();
    expect(glyphTextLayoutSystem(world, residentStore).ok).toBe(true);

    expect(updateMesh).toHaveBeenCalledOnce();
    const after = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle as never);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.vertices.length).not.toBe(oldVertexLength);
    expect(after.value.indices?.length ?? 0).toBeGreaterThan(0);
    const positions = after.value.attributes.position as Float32Array;
    const normals = after.value.attributes.normal as Float32Array;
    expect(positions.length).toBe((after.value.vertices.length / 12) * 3);
    expect(normals.length).toBe(positions.length);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      expect(Array.from(positions.subarray(vertex * 3, vertex * 3 + 3))).toEqual(
        Array.from(after.value.vertices.subarray(vertex * 12, vertex * 12 + 3)),
      );
    }
  });
});
