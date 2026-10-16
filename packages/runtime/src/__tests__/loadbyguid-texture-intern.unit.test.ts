// tweak-20260627-model-loading-smoke-build-perf M4: regression test for the
// loadByGuid per-frame texture re-upload bug.
//
// SYMPTOM: a MaterialAsset loaded via loadByGuid keeps its texture/sampler
// values as embedded GUID strings (dash-form). The extract stage
// (render-system-extract.ts) re-resolved each GUID to a column handle EVERY
// frame by calling `world.allocSharedRef`, which mints a NEW monotonically-
// increasing slot id per call. The GPU residency cache
// (GpuResidencyCache.textureGpuHandles) is keyed on handleSlot(handle), so a
// fresh slot every frame meant the residency check ALWAYS missed -> all
// textures re-uploaded to the GPU every frame, GPU memory unbounded, per-frame
// draw time grew linearly until SIGKILL.
//
// FIX: the GUID-string -> column-handle resolution is interned per World, so a
// given (world, guid, brand) mints EXACTLY ONE stable handle reused across
// frames (architecture-principle §6 idempotency). This file asserts that
// invariant directly: resolving the same texture GUID across two extract
// frames yields the SAME handle, and `world.allocSharedRef` is NOT called again
// on the second frame's resolution.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function identityTx() {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function registerQuadMesh(world: World): Handle<'MeshAsset', 'shared'> {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: positions },
    aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 36,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
}

function textureAsset(red = 255): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    data: new Uint8Array([red, 255, 255, 255]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

// Build a loadByGuid-shaped scene: the material's baseColorTexture paramValue is
// an embedded GUID STRING (not a pre-minted numeric handle), catalogued to a
// texture payload. This is exactly the shape Sponza materials have after
// loadByGuid, and the shape that triggered the per-frame re-upload bug.
function spawnTexturedRenderable(world: World, assets: AssetRegistry): { textureGuidStr: string } {
  const mesh = registerQuadMesh(world);

  // Catalog the texture under a GUID; the material references it by GUID string.
  // The embedded ref must be the EXACT dash-form string that
  // AssetRegistry.lookup keys on (AssetGuid.format, lowercased) -- the same
  // shape loadByGuid leaves in a MaterialAsset's values (D-19).
  const textureGuid = AssetGuid.random();
  const textureGuidStr = AssetGuid.format(textureGuid);
  assets.catalog(textureGuid, textureAsset());

  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: {
      baseColor: [1, 1, 1],
      // Embedded GUID string -- the loadByGuid texture-ref shape (D-19).
      baseColorTexture: textureGuidStr,
    },
  } as unknown as MaterialAsset);

  world
    .spawn(
      { component: Transform, data: { ...identityTx(), pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: identityTx() },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
  propagateTransforms(world);

  return { textureGuidStr };
}

function baseColorHandleFromFrame(world: World, assets: AssetRegistry): number | undefined {
  const frame = extractFrame(world, prepareExtractContext(world, { assets, pipelineState: null }));
  const renderable = frame.renderables.find(
    (r) => r.material.materialShaderId === 'forgeax::default-unlit',
  );
  const snap = renderable?.material as
    | { readonly baseColorTexture?: Handle<'TextureAsset', 'shared'> }
    | undefined;
  return snap?.baseColorTexture as unknown as number | undefined;
}

describe('M4 loadByGuid texture handle interning (per-frame re-upload regression)', () => {
  it('resolves the same texture GUID to the SAME column handle across two extract frames', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    spawnTexturedRenderable(world, assets);

    const handleFrame1 = baseColorHandleFromFrame(world, assets);
    const handleFrame2 = baseColorHandleFromFrame(world, assets);

    expect(handleFrame1).toBeDefined();
    expect(handleFrame2).toBeDefined();
    // The whole fix: a stable handle across frames so handleSlot(handle) is
    // stable and the GPU residency cache hits instead of re-uploading.
    expect(handleFrame2).toBe(handleFrame1);
  });

  it('does NOT call world.allocSharedRef again when re-resolving the same GUID on a later frame', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    spawnTexturedRenderable(world, assets);

    // Warm the intern cache (frame 1 mints the texture handle exactly once).
    baseColorHandleFromFrame(world, assets);

    // Frame 2: spy on allocSharedRef and confirm the GUID resolution is served
    // from the intern cache -- zero new allocations for the cached texture GUID.
    const allocSpy = vi.spyOn(world, 'allocSharedRef');
    const handleFrame2 = baseColorHandleFromFrame(world, assets);
    expect(handleFrame2).toBeDefined();

    const textureAllocCalls = allocSpy.mock.calls.filter((c) => c[0] === 'TextureAsset');
    expect(textureAllocCalls.length).toBe(0);
    allocSpy.mockRestore();
  });

  it('retires the cached allocation grant when the GUID is re-catalogued', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const { textureGuidStr } = spawnTexturedRenderable(world, assets);

    const oldHandle = baseColorHandleFromFrame(world, assets);
    expect(oldHandle).toBeDefined();
    const replacement = textureAsset(127);
    assets.catalog(textureGuidStr, replacement);

    const newHandle = baseColorHandleFromFrame(world, assets);
    expect(newHandle).toBeDefined();
    expect(newHandle).not.toBe(oldHandle);
    expect(
      world.sharedRefs.resolve(newHandle as unknown as Handle<'TextureAsset', 'shared'>),
    ).toMatchObject({ ok: true, value: replacement });
    expect(
      world.sharedRefs.refcount(oldHandle as unknown as Handle<'TextureAsset', 'shared'>),
    ).toBe(0);
  });

  it('drops the cached allocation grant when the GUID is invalidated', () => {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const { textureGuidStr } = spawnTexturedRenderable(world, assets);

    const handle = baseColorHandleFromFrame(world, assets);
    expect(handle).toBeDefined();
    assets.invalidate(textureGuidStr);

    expect(baseColorHandleFromFrame(world, assets)).toBeUndefined();
    expect(world.sharedRefs.refcount(handle as unknown as Handle<'TextureAsset', 'shared'>)).toBe(
      0,
    );
  });
});
