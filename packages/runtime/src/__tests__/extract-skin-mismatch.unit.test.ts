// feat-20260611-fox-skinning-vertex-attribute-chain M4 / w19 (AC-07).
//
// Asserts the bidirectional Skin <-> pbr-skin material fail-fast added to
// `render-system-extract.ts` (w17 / D-5):
//
//   (a) Skin component on entity + first-pass shader != forgeax::pbr-skin
//       -> _routeError fires `SkinMaterialMismatchError` (.code
//       === 'skin-material-mismatch') and the entity is skipped (continue),
//       leaving sibling entities in the same frame to render normally.
//
//   (b) First-pass shader === forgeax::pbr-skin + mesh.attributes missing
//       skinIndex / skinWeight -> _routeError fires
//       `MaterialSkinAttrMissingError` (.code === 'material-skin-attr-missing')
//       and the entity is skipped.
//
//   (c) Valid Skin without a GPU allocator -> publish a serializable pose;
//       the receiving Renderer owns palette allocation (positive control).
//
// Plan-strategy D-5: extract uses `_routeError` + `continue` (one entity's
// misconfiguration must NOT abort the whole frame's draw list); this test
// also asserts that a sibling unlit entity in the same frame still extracts
// to a renderable entry alongside the bad-skin one.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type {
  Handle,
  MaterialAsset,
  MaterialProgramAbi,
  MeshAsset,
  SkeletonAsset,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaterialRenderProjection } from '../../../assets-runtime/src/material/runtime-shader';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── helpers ──────────────────────────────────────────────────────────────

const UNIT_AABB = new Float32Array([-1, -1, -1, 1, 1, 1]);
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Unskinned: 12 floats / vertex × 3 vertices = 36 (position vec3 + normal vec3 + uv vec2 + tangent vec4).
const TRIANGLE_VERTICES = new Float32Array([
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0,
]);
// Skinned: 18 floats / vertex × 3 vertices = 54 (12 base + skinIndex u16x4 packed in 2 floats at slots 12-13 + skinWeight vec4 at slots 14-17).
// validateMeshPayload (asset-registry feat: validateMeshPayload skin-aware stride) rejects skin meshes at the 12F stride.
// Trailing 6 floats per vertex are placeholder (extract path reads attributes.skinIndex/Weight directly, not from interleaved buffer).
const TRIANGLE_VERTICES_SKINNED = new Float32Array([
  // v0: pos (0,0,0) | normal (0,0,1) | uv (0,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v1: pos (1,0,0) | normal (0,0,1) | uv (1,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v2: pos (0,1,0) | normal (0,0,1) | uv (0,1) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
]);
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function makeAssetRegistry(): AssetRegistry {
  const shaderRegistry: ShaderRegistry = makeMockShaderRegistry();
  // The shared mock registry omits forgeax::pbr-skin (it is the
  // engine-shipped skin shader registered at boot time elsewhere). The
  // mismatch path under test needs MaterialAsset register-time validation
  // to accept first-pass shader === 'forgeax::pbr-skin', so we register a
  // minimal entry here. paramSchema mirrors the standard PBR family head
  // (baseColor / metallic / roughness) since this test does not exercise
  // skin-specific param overlay.
  shaderRegistry.installMaterialArtifact('forgeax::pbr-skin', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'metallic', type: 'f32', default: 0.0 },
      { name: 'roughness', type: 'f32', default: 0.5 },
    ],
  });
  return new AssetRegistry(shaderRegistry);
}

function registerSkinnedMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: TRIANGLE_VERTICES_SKINNED,
    indices: new Uint16Array([0, 1, 2]),
    attributes: {
      position: TRIANGLE_POSITIONS,
      // pbr-skin requires skinIndex + skinWeight in attributes; values are
      // irrelevant here -- key presence is what extract reads.
      skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    },
    aabb: UNIT_AABB,
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
}

function registerUnskinnedMesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: TRIANGLE_VERTICES,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: TRIANGLE_POSITIONS },
    aabb: UNIT_AABB,
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  });
}

function registerPbrSkinMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  });
}

function registerUnlitMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  });
}

function registerSkeleton(world: World): Handle<'SkeletonAsset', 'shared'> {
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices: new Float32Array(IDENTITY_MATRIX),
    jointCount: 1,
  });
}

function spawnCamera(world: World): void {
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 5],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
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
}

const IDENTITY_TRANSFORM = {
  pos: [0, 0, 0],
  quat: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const CUSTOM_CONTEXT = {
  backend: 'webgpu' as const,
  capability: 'storage-buffer' as const,
  pipeline: 'forward' as const,
  geometry: 'mesh' as const,
  pass: 'forward' as const,
  profile: 'forgeax-material-wgsl-v1' as const,
  toolchain: 'naga-oil' as const,
  instrumentation: 'none' as const,
};

const CUSTOM_MESH_ABI = {
  vertexInputs: [{ semantic: 'position' }],
} as unknown as MaterialProgramAbi;

const CUSTOM_SKIN_ABI = {
  skinPaletteAddress: { group: 2, binding: 1, stride: 64 },
  vertexInputs: [{ semantic: 'position' }, { semantic: 'skinIndex' }, { semantic: 'skinWeight' }],
} as unknown as MaterialProgramAbi;

function customSkinProjection(): MaterialRenderProjection {
  return {
    materialGuid: '019ffa97-4000-7000-8000-000000000202',
    publicationGeneration: 1,
    specializationKey: 'sha256:custom-skin',
    artifactHash: 'sha256:custom-skin-artifact',
    runtimeValues: {},
    staticSelection: [],
    passes: [
      {
        name: 'Forward',
        module: 'game::custom-skin',
        renderState: { tags: { LightMode: 'Forward' } },
        programs: [
          {
            context: CUSTOM_CONTEXT,
            specializationKey: 'sha256:custom-mesh',
            artifactHash: 'sha256:custom-mesh-artifact',
            address: 'direct',
            abi: CUSTOM_MESH_ABI,
          },
          {
            context: { ...CUSTOM_CONTEXT, geometry: 'skinned' },
            specializationKey: 'sha256:custom-skin',
            artifactHash: 'sha256:custom-skin-artifact',
            address: 'direct',
            abi: CUSTOM_SKIN_ABI,
          },
          {
            context: { ...CUSTOM_CONTEXT, geometry: 'skinned' },
            specializationKey: 'sha256:custom-skin',
            artifactHash: 'sha256:custom-skin-artifact',
            address: 'scene-index',
            abi: CUSTOM_SKIN_ABI,
          },
        ],
      },
    ],
  };
}

function spawnRenderable(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
): void {
  world
    .spawn(
      { component: Transform, data: IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
}

function spawnSkinnedRenderable(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
  skeletonHandle: Handle<'SkeletonAsset', 'shared'>,
) {
  // feat-20260612 M2 / m2-6: Skin.joints[] now validated against
  // SkeletonAsset.jointCount (=1 here) at extract time; spawn one joint
  // Entity bearing Transform so the count matches and the new
  // `joint-count-mismatch` / `joint-entity-dangling` checks pass for the
  // bidirectional Skin <-> pbr-skin mismatch happy path (test (c)).
  const jointEntity = world.spawn({ component: Transform, data: IDENTITY_TRANSFORM }).unwrap();
  world
    .spawn(
      { component: Transform, data: IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      {
        component: Skin,
        data: {
          skeleton: skeletonHandle,
          joints: new Uint32Array([jointEntity as unknown as number]),
        },
      },
    )
    .unwrap();
  return jointEntity;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('render-system-extract Skin / pbr-skin mismatch (AC-07 / w19)', () => {
  it('(a) Skin + non-pbr-skin material -> SkinMaterialMismatchError routed + entity skipped', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const unlitMatHandle = registerUnlitMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    spawnSkinnedRenderable(world, meshHandle, unlitMatHandle, skeletonHandle);
    propagateTransforms(world);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, errArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('skin-material-mismatch');
    expect((errArg as { detail: { actualShader: string | undefined } }).detail.actualShader).toBe(
      'forgeax::default-unlit',
    );
    // entity skipped -> no renderable entry
    expect(frame.renderables).toHaveLength(0);
  });

  it('(b) pbr-skin material + non-skin mesh -> MaterialSkinAttrMissingError routed + entity skipped', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerUnskinnedMesh(world);
    const skinMatHandle = registerPbrSkinMaterial(world);
    spawnCamera(world);
    spawnRenderable(world, meshHandle, skinMatHandle);
    propagateTransforms(world);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, errArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('material-skin-attr-missing');
    expect(
      (errArg as { detail: { missing: 'skinIndex' | 'skinWeight' | 'both' } }).detail.missing,
    ).toBe('both');

    expect(frame.renderables).toHaveLength(0);
  });

  it('(c) Skin + pbr-skin material without a GPU allocator publishes a source pose', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const skinMatHandle = registerPbrSkinMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    spawnSkinnedRenderable(world, meshHandle, skinMatHandle, skeletonHandle);
    propagateTransforms(world);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(frame.renderables).toHaveLength(1);
    const row = frame.renderables[0];
    expect(row?.skin).toBeUndefined();
    expect(row?.skinPose?.jointCount).toBe(1);
    expect(row?.skinPose?.inverseBindMatrices).toEqual([IDENTITY_MATRIX]);
    expect(row?.skinPose?.jointWorlds).toEqual([IDENTITY_MATRIX]);
    expect(structuredClone(row?.skinPose)).toEqual(row?.skinPose);
    expect(frame.dispatch.some((entry) => entry.materialShaderId === 'forgeax::pbr-skin')).toBe(
      true,
    );
  });

  it('(d) D-5 continue semantics: bad-skin entity skipped does NOT abort sibling extract', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const skinnedMesh = registerSkinnedMesh(world);
    const unskinnedMesh = registerUnskinnedMesh(world);
    const unlitMat = registerUnlitMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    spawnCamera(world);
    // bad-skin entity (Skin + unlit material) -> mismatch -> skipped
    spawnSkinnedRenderable(world, skinnedMesh, unlitMat, skeletonHandle);
    // sibling well-formed entity (no Skin, unlit material, unskinned mesh)
    spawnRenderable(world, unskinnedMesh, unlitMat);
    propagateTransforms(world);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    // exactly one mismatch error (the bad-skin entity), and the sibling
    // emerges as a renderable -- proving `continue` did not turn into
    // `return Result.err` for the whole frame.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, errArg] = errorSpy.mock.calls[0] ?? [];
    expect((errArg as { code: string }).code).toBe('skin-material-mismatch');
    expect(frame.renderables.length).toBeGreaterThanOrEqual(1);
  });

  it('uses the selected custom skin ABI to publish a source pose without a GPU allocator', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const materialHandle = registerUnlitMaterial(world);
    const skeletonHandle = registerSkeleton(world);
    vi.spyOn(assets, 'getMaterialProjectionForPayload').mockReturnValue(customSkinProjection());
    spawnCamera(world);
    spawnSkinnedRenderable(world, meshHandle, materialHandle, skeletonHandle);
    propagateTransforms(world);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frame = extractFrame(
      world,
      prepareExtractContext(world, { assets, materialContext: CUSTOM_CONTEXT }),
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(frame.renderables).toHaveLength(1);
    expect(frame.renderables[0]?.skin).toBeUndefined();
    expect(frame.renderables[0]?.skinPose?.jointWorlds).toEqual([IDENTITY_MATRIX]);
    expect(frame.dispatch.some((entry) => entry.materialShaderId === 'sha256:custom-skin')).toBe(
      true,
    );
  });

  it.each([
    false,
    true,
  ])('rejects a dangling joint before publishing skin dispatch (custom=%s)', (custom) => {
    const world = new World();
    const assets = makeAssetRegistry();
    const mesh = registerSkinnedMesh(world);
    const material = custom ? registerUnlitMaterial(world) : registerPbrSkinMaterial(world);
    const skeleton = registerSkeleton(world);
    if (custom) {
      vi.spyOn(assets, 'getMaterialProjectionForPayload').mockReturnValue(customSkinProjection());
    }
    spawnCamera(world);
    const joint = spawnSkinnedRenderable(world, mesh, material, skeleton);
    world.despawn(joint).unwrap();
    propagateTransforms(world);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const frame = extractFrame(
      world,
      prepareExtractContext(world, {
        assets,
        ...(custom ? { materialContext: CUSTOM_CONTEXT } : {}),
      }),
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({ code: 'joint-entity-dangling' });
    expect(frame.renderables).toHaveLength(0);
    expect(frame.dispatch).toHaveLength(0);
  });

  it('keeps an exact mesh-context publication miss instead of fabricating skin-attribute failure', () => {
    const world = new World();
    const assets = makeAssetRegistry();
    const meshHandle = registerSkinnedMesh(world);
    const materialHandle = registerUnlitMaterial(world);
    const projection = customSkinProjection();
    vi.spyOn(assets, 'getMaterialProjectionForPayload').mockReturnValue({
      ...projection,
      passes: projection.passes.map((pass) => ({
        ...pass,
        programs: pass.programs.filter((program) => program.context.geometry === 'skinned'),
      })),
    });
    spawnCamera(world);
    // The mesh has both skin attributes, so a missing mesh-context program is
    // a producer publication error rather than an attribute error.
    spawnRenderable(world, meshHandle, materialHandle);
    propagateTransforms(world);

    expect(() =>
      extractFrame(
        world,
        prepareExtractContext(world, { assets, materialContext: CUSTOM_CONTEXT }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'material-specialization-not-cooked' }));
  });
});
