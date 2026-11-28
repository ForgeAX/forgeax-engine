// Real ForgeAX ECS World + AssetRegistry bridge into @forgeax/engine-render-kernel/native.
// Extracts live Transform/GlobalTransform, Camera, MeshFilter, MeshRenderer, Visibility,
// ShadowParticipation, DirectionalLight, PointLight, and SpotLight entities and drives
// DesktopNativeSceneRenderer on the dedicated Rust OS render thread (wgpu 30).

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA_FXAA,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  DirectionalLight,
  Fog,
  FogModeValue,
  getActiveCamera,
  Instances,
  MeshFilter,
  MeshRenderer,
  PointLight,
  ShadowParticipation,
  SkyboxBackground,
  Skylight,
  SpotLight,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import {
  createDesktopNativeSceneRenderer,
  type DesktopBloomInput,
  type DesktopFogInput,
  type DesktopLightInput,
  type DesktopMaterialInput,
  type DesktopNativeSceneRenderer,
  type DesktopNativeSceneRendererOptions,
  type DesktopRenderObjectInput,
  type DesktopSceneStats,
  type DesktopSkyboxInput,
  type DesktopSkylightInput,
  type DesktopSubmeshInput,
  type DesktopWitnessFrameResult,
  desktopMat4Invert,
  desktopMat4Multiply,
  desktopMat4Ortho,
  desktopMat4Perspective,
  type KernelError,
  type NativeWindowEvent,
  packDesktopMeshVertices,
  packDesktopSkinnedMeshVertices,
} from '@forgeax/engine-render-kernel/native';
import { GlobalTransform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import {
  type AssetHandle,
  type MaterialAsset,
  type MeshAsset,
  ok,
  type Result,
  type SkeletonAsset,
  type TextureAsset,
  type UiPaintSource,
} from '@forgeax/engine-types';

export interface ForgeaxDesktopNativeRendererOptions extends DesktopNativeSceneRendererOptions {
  /** Override scene ambient light RGB (default [0.14, 0.17, 0.22]). */
  readonly ambientColor?: readonly [number, number, number] | undefined;
}

interface MutableObjectSlot {
  entityId: number;
  meshKey: number;
  submeshIndex: number;
  materialKey: string | number;
  skinKey: number | undefined;
  skinAffinePoint: boolean;
  readonly worldMatrix: Float32Array;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
  layerMask: number;
}

const DEFAULT_MATERIAL_KEY = '__forgeax_default_material__';
const DEG_TO_RAD = Math.PI / 180;
const INSTANCE_ENTITY_BASE = 1_000_000_000;

function readColor3Or4(
  value: unknown,
  fallback: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const arr = value as ArrayLike<number>;
    if (arr.length >= 3) {
      return [
        Number(arr[0] ?? fallback[0]),
        Number(arr[1] ?? fallback[1]),
        Number(arr[2] ?? fallback[2]),
        arr.length >= 4 ? Number(arr[3] ?? fallback[3]) : fallback[3],
      ];
    }
  }
  return fallback;
}

function readColor3(value: unknown): readonly [number, number, number] | undefined {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const arr = value as ArrayLike<number>;
    if (arr.length >= 3) {
      return [Number(arr[0] ?? 0), Number(arr[1] ?? 0), Number(arr[2] ?? 0)];
    }
  }
  return undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readTextureHandle(value: unknown): AssetHandle<'texture'> | undefined {
  if (typeof value === 'number' && value > 0) {
    return value as AssetHandle<'texture'>;
  }
  if (typeof value === 'object' && value !== null && 'texture' in value) {
    const tex = (value as { readonly texture?: unknown }).texture;
    if (typeof tex === 'number' && tex > 0) {
      return tex as AssetHandle<'texture'>;
    }
  }
  return undefined;
}

interface ExtractedPackedMesh {
  readonly vertices: Float32Array;
  readonly skinned: boolean;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

interface InterleavedVertexLayout {
  readonly strideFloats: number;
  readonly posOff: number;
  readonly nrmOff: number;
  readonly uvOff: number;
  readonly tanOff: number;
  readonly skinIdxOff: number;
  readonly skinWgtOff: number;
}

const INTERLEAVED_ATTRIBUTE_ORDER: readonly (readonly [string, number])[] = [
  ['position', 3],
  ['normal', 3],
  ['uv', 2],
  ['tangent', 4],
  ['tangentFrame', 1],
  ['color', 4],
  ['skinIndex', 2],
  ['skinWeight', 4],
  ['uv1', 2],
  ['uv2', 2],
  ['uv3', 2],
  ['uv4', 2],
  ['uv5', 2],
  ['uv6', 2],
  ['uv7', 2],
];

function readMeshAabbBounds(aabb: ArrayLike<number>): {
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
} {
  return {
    boundsMin: [aabb[0] ?? -0.5, aabb[1] ?? -0.5, aabb[2] ?? -0.5],
    boundsMax: [aabb[3] ?? 0.5, aabb[4] ?? 0.5, aabb[5] ?? 0.5],
  };
}

function extractUnpackedMeshVertices(mesh: MeshAsset): ExtractedPackedMesh | undefined {
  if (mesh.attributeStorage !== undefined) return undefined;
  const pos = mesh.attributes.position;
  if (!(pos instanceof Float32Array) || pos.length < 3) return undefined;

  const nrm = mesh.attributes.normal instanceof Float32Array ? mesh.attributes.normal : undefined;
  const uv = mesh.attributes.uv instanceof Float32Array ? mesh.attributes.uv : undefined;
  const tan = mesh.attributes.tangent instanceof Float32Array ? mesh.attributes.tangent : undefined;
  const rawSkinIdx = mesh.attributes.skinIndex as ArrayLike<number> | undefined;
  const rawSkinWgt =
    mesh.attributes.skinWeight instanceof Float32Array ? mesh.attributes.skinWeight : undefined;
  const hasSkin = rawSkinIdx !== undefined && rawSkinWgt !== undefined;
  const packed = hasSkin
    ? packDesktopSkinnedMeshVertices(pos, nrm, uv, tan, rawSkinIdx, rawSkinWgt)
    : packDesktopMeshVertices(pos, nrm, uv, tan);

  if (mesh.aabb !== undefined && mesh.aabb.length >= 6) {
    const bounds = readMeshAabbBounds(mesh.aabb);
    return {
      vertices: packed.vertices,
      skinned: hasSkin,
      boundsMin: bounds.boundsMin,
      boundsMax: bounds.boundsMax,
    };
  }
  return {
    vertices: packed.vertices,
    skinned: hasSkin,
    boundsMin: packed.boundsMin,
    boundsMax: packed.boundsMax,
  };
}

function inferInterleavedVertexLayout(
  attributes: MeshAsset['attributes'],
): InterleavedVertexLayout {
  const attrRecord = attributes as Record<string, unknown>;
  let strideFloats = 0;
  let posOff = -1;
  let nrmOff = -1;
  let uvOff = -1;
  let tanOff = -1;
  let skinIdxOff = -1;
  let skinWgtOff = -1;
  for (const [key, floats] of INTERLEAVED_ATTRIBUTE_ORDER) {
    if (key in attributes && attrRecord[key] !== undefined) {
      if (key === 'position') posOff = strideFloats;
      else if (key === 'normal') nrmOff = strideFloats;
      else if (key === 'uv') uvOff = strideFloats;
      else if (key === 'tangent') tanOff = strideFloats;
      else if (key === 'skinIndex') skinIdxOff = strideFloats;
      else if (key === 'skinWeight') skinWgtOff = strideFloats;
      strideFloats += floats;
    }
  }
  if (strideFloats <= 0) {
    return {
      strideFloats: 12,
      posOff: 0,
      nrmOff: 3,
      uvOff: 6,
      tanOff: -1,
      skinIdxOff: -1,
      skinWgtOff: -1,
    };
  }
  return { strideFloats, posOff, nrmOff, uvOff, tanOff, skinIdxOff, skinWgtOff };
}

function writeInterleavedTangent(
  packed: Float32Array,
  dst: number,
  vertices: Float32Array,
  src: number,
  tanOff: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  if (tanOff >= 0) {
    packed[dst + 8] = vertices[src + tanOff + 0] ?? 1;
    packed[dst + 9] = vertices[src + tanOff + 1] ?? 0;
    packed[dst + 10] = vertices[src + tanOff + 2] ?? 0;
    packed[dst + 11] = vertices[src + tanOff + 3] ?? 1;
    return;
  }
  const nonVertical = Math.abs(ny) < 0.99;
  const tx = nonVertical ? nz : 1;
  const tz = nonVertical ? -nx : 0;
  const tLen = Math.hypot(tx, tz) || 1;
  packed[dst + 8] = tx / tLen;
  packed[dst + 9] = 0;
  packed[dst + 10] = tz / tLen;
  packed[dst + 11] = 1;
}

function writeInterleavedBaseAttributes(
  packed: Float32Array,
  dst: number,
  vertices: Float32Array,
  src: number,
  layout: InterleavedVertexLayout,
): void {
  if (layout.posOff >= 0) {
    const base = src + layout.posOff;
    packed[dst + 0] = vertices[base + 0] ?? 0;
    packed[dst + 1] = vertices[base + 1] ?? 0;
    packed[dst + 2] = vertices[base + 2] ?? 0;
  }
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (layout.nrmOff >= 0) {
    const base = src + layout.nrmOff;
    nx = vertices[base + 0] ?? 0;
    ny = vertices[base + 1] ?? 1;
    nz = vertices[base + 2] ?? 0;
  }
  packed[dst + 3] = nx;
  packed[dst + 4] = ny;
  packed[dst + 5] = nz;
  if (layout.uvOff >= 0) {
    const base = src + layout.uvOff;
    packed[dst + 6] = vertices[base + 0] ?? 0;
    packed[dst + 7] = vertices[base + 1] ?? 0;
  }
  writeInterleavedTangent(packed, dst, vertices, src, layout.tanOff, nx, ny, nz);
}

function writeInterleavedSkinAttributes(
  packed: Float32Array,
  dst: number,
  vertices: Float32Array,
  src: number,
  srcU16: Uint16Array,
  skinIdxOff: number,
  skinWgtOff: number,
): void {
  const u16Base = (src + skinIdxOff) * 2;
  packed[dst + 12] = srcU16[u16Base + 0] ?? 0;
  packed[dst + 13] = srcU16[u16Base + 1] ?? 0;
  packed[dst + 14] = srcU16[u16Base + 2] ?? 0;
  packed[dst + 15] = srcU16[u16Base + 3] ?? 0;
  const w0 = vertices[src + skinWgtOff + 0] ?? 1;
  const w1 = vertices[src + skinWgtOff + 1] ?? 0;
  const w2 = vertices[src + skinWgtOff + 2] ?? 0;
  const w3 = vertices[src + skinWgtOff + 3] ?? 0;
  const wSum = w0 + w1 + w2 + w3;
  if (wSum > 1e-6) {
    packed[dst + 16] = w0 / wSum;
    packed[dst + 17] = w1 / wSum;
    packed[dst + 18] = w2 / wSum;
    packed[dst + 19] = w3 / wSum;
  } else {
    packed[dst + 16] = 1;
    packed[dst + 17] = 0;
    packed[dst + 18] = 0;
    packed[dst + 19] = 0;
  }
}

function computePackedVertexBounds(
  packed: Float32Array,
  vertexCount: number,
  stride: number,
): {
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
} {
  if (vertexCount <= 0) {
    return { boundsMin: [-0.5, -0.5, -0.5], boundsMax: [0.5, 0.5, 0.5] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < vertexCount; i++) {
    const dst = i * stride;
    const px = packed[dst + 0] ?? 0;
    const py = packed[dst + 1] ?? 0;
    const pz = packed[dst + 2] ?? 0;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }
  return { boundsMin: [minX, minY, minZ], boundsMax: [maxX, maxY, maxZ] };
}

function extractPackedMeshVertices(mesh: MeshAsset): ExtractedPackedMesh {
  // Authoring/unpacked form: separate TypedArrays in mesh.attributes
  const unpacked = extractUnpackedMeshVertices(mesh);
  if (unpacked !== undefined) return unpacked;

  // Packed interleaved buffer: infer stride & canonical attribute offsets from attribute map
  const layout = inferInterleavedVertexLayout(mesh.attributes);
  const hasSkin = layout.skinIdxOff >= 0 && layout.skinWgtOff >= 0;
  const outStride = hasSkin ? 20 : 12;
  const vertexCount = Math.floor(mesh.vertices.length / layout.strideFloats);
  const packed = new Float32Array(vertexCount * outStride);
  const srcU16 = hasSkin
    ? new Uint16Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength / 2)
    : undefined;

  for (let i = 0; i < vertexCount; i++) {
    const src = i * layout.strideFloats;
    const dst = i * outStride;
    writeInterleavedBaseAttributes(packed, dst, mesh.vertices, src, layout);
    if (srcU16 !== undefined) {
      writeInterleavedSkinAttributes(
        packed,
        dst,
        mesh.vertices,
        src,
        srcU16,
        layout.skinIdxOff,
        layout.skinWgtOff,
      );
    }
  }

  const bounds =
    mesh.aabb !== undefined && mesh.aabb.length >= 6
      ? readMeshAabbBounds(mesh.aabb)
      : computePackedVertexBounds(packed, vertexCount, outStride);
  return {
    vertices: packed,
    skinned: hasSkin,
    boundsMin: bounds.boundsMin,
    boundsMax: bounds.boundsMax,
  };
}

type EcsMaterialAsset = MaterialAsset & {
  readonly queue?: number;
  readonly shaderWgsl?: string;
  readonly customWgsl?: string;
  readonly renderState?: {
    readonly blend?: unknown;
    readonly cullMode?: 'none' | 'front' | 'back';
  };
  readonly values?: Readonly<Record<string, unknown>>;
};

function resolveMaterialCustomWgsl(
  mat: EcsMaterialAsset,
  values: Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeof mat.shaderWgsl === 'string' && mat.shaderWgsl.length > 0) return mat.shaderWgsl;
  if (typeof mat.customWgsl === 'string' && mat.customWgsl.length > 0) return mat.customWgsl;
  if (typeof values.__customWgsl === 'string' && values.__customWgsl.length > 0) {
    return values.__customWgsl;
  }
  if (typeof values.shaderWgsl === 'string' && values.shaderWgsl.length > 0) {
    return values.shaderWgsl;
  }
  return undefined;
}

function resolveMaterialPbrParams(values: Readonly<Record<string, unknown>>) {
  return {
    baseColor: readColor3Or4(
      values.baseColor ?? values.albedo ?? values.color,
      [0.75, 0.75, 0.75, 1],
    ),
    roughness: readNumber(values.roughness ?? values.roughnessFactor, 0.5),
    metallic: readNumber(values.metallic ?? values.metallicFactor, 0.0),
    normalScale: readNumber(values.normalScale, 1.0),
    occlusionStrength: readNumber(values.occlusionStrength ?? values.aoStrength, 1.0),
    emissive: readColor3(values.emissive ?? values.emissiveColor),
  };
}

function resolveMaterialAlphaAndQueue(
  mat: EcsMaterialAsset,
  values: Readonly<Record<string, unknown>>,
  baseAlpha: number,
): {
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff: number | undefined;
  readonly transparent: boolean;
  readonly queue: number;
} {
  const alphaCutoff =
    typeof values.alphaCutoff === 'number' && Number.isFinite(values.alphaCutoff)
      ? values.alphaCutoff
      : undefined;
  const rawAlphaMode = typeof values.alphaMode === 'string' ? values.alphaMode : undefined;
  const transparent =
    rawAlphaMode === 'blend' ||
    mat.renderState?.blend !== undefined ||
    (mat.queue ?? 2000) > 2500 ||
    (rawAlphaMode !== 'mask' && baseAlpha < 0.999);
  const alphaMode: 'opaque' | 'mask' | 'blend' = transparent
    ? 'blend'
    : rawAlphaMode === 'mask' || (alphaCutoff !== undefined && alphaCutoff > 0)
      ? 'mask'
      : 'opaque';
  const queue = mat.queue ?? (transparent ? 3000 : alphaMode === 'mask' ? 2450 : 2000);
  return { alphaMode, alphaCutoff, transparent, queue };
}

/**
 * Drives a real ForgeAX ECS `World` + `AssetRegistry` directly on NativeRenderKernel's
 * dedicated Rust OS render thread (wgpu 30 Metal / DX12 / Vulkan).
 */
export class ForgeaxDesktopNativeRenderer {
  readonly renderer: DesktopNativeSceneRenderer;
  readonly world: World;
  readonly assets: AssetRegistry;

  private readonly ambientColor: readonly [number, number, number] | undefined;
  private readonly uploadedMeshes = new Set<number>();
  private readonly meshSubmeshSlots = new Map<number, readonly number[]>();
  private readonly entitySubmeshCounts = new Map<number, number>();
  private readonly uploadedTextures = new Set<number>();
  private readonly materialRevisions = new Map<number, number>();
  private readonly seenMaterialsThisFrame = new Set<number>();
  private readonly objectPool: MutableObjectSlot[] = [];
  private readonly frameObjects: DesktopRenderObjectInput[] = [];
  private readonly frameLights: DesktopLightInput[] = [];

  private readonly viewMatrixScratch = new Float32Array(16);
  private readonly projMatrixScratch = new Float32Array(16);
  private readonly viewProjScratch = new Float32Array(16);
  private readonly camPosScratch: [number, number, number] = [0, 0, 5];
  private readonly clearColorScratch: [number, number, number, number] = [0.05, 0.08, 0.14, 1];
  private readonly skylightSkyScratch: [number, number, number] = [0.14, 0.17, 0.22];
  private readonly skylightGroundScratch: [number, number, number] = [0.14, 0.17, 0.22];

  private readonly renderableQuery;
  private readonly changedTransformQuery;
  private readonly changedMeshFilterQuery;
  private readonly changedMeshRendererQuery;
  private readonly changedVisibilityQuery;
  private readonly changedShadowQuery;
  private readonly changedInstancesQuery;
  private readonly cameraQuery;
  private readonly dirLightQuery;
  private readonly pointLightQuery;
  private readonly spotLightQuery;
  private readonly skylightQuery;
  private readonly fogQuery;
  private readonly skyboxQuery;
  private readonly trackedMaterialHandles = new Map<number, AssetHandle<'material'>>();
  private readonly activeSkinnedEntities = new Map<
    number,
    {
      readonly skeleton: AssetHandle<'skeleton'>;
      readonly joints: ArrayLike<number>;
    }
  >();
  private readonly instancedEntityCounts = new Map<number, number>();
  private skinPaletteScratch = new Float32Array(64 * 16);
  private readonly instanceMatScratch = new Float32Array(16);
  private readonly instanceWorldScratch = new Float32Array(16);
  private dirtyTransformEntityIds = new Uint32Array(256);
  private dirtyTransformMatrices = new Float32Array(256 * 16);
  private lastStructureEpoch = -1;
  private initializedScene = false;
  private elapsedSeconds = 0;

  constructor(
    world: World,
    assets: AssetRegistry,
    renderer: DesktopNativeSceneRenderer,
    ambientColor?: readonly [number, number, number],
  ) {
    this.world = world;
    this.assets = assets;
    this.renderer = renderer;
    this.ambientColor = ambientColor;

    this.renderableQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer],
        optional: [Visibility, ShadowParticipation, Skin, Instances],
      })
      .unwrap();
    this.changedTransformQuery = world
      .query({
        read: [GlobalTransform],
        optional: [Instances],
        with: [MeshFilter, MeshRenderer],
        changed: [GlobalTransform],
      })
      .unwrap();
    this.changedMeshFilterQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer],
        optional: [Visibility, ShadowParticipation, Skin, Instances],
        changed: [MeshFilter],
      })
      .unwrap();
    this.changedMeshRendererQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer],
        optional: [Visibility, ShadowParticipation, Skin, Instances],
        changed: [MeshRenderer],
      })
      .unwrap();
    this.changedVisibilityQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer, Visibility],
        optional: [ShadowParticipation, Skin, Instances],
        changed: [Visibility],
      })
      .unwrap();
    this.changedShadowQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer, ShadowParticipation],
        optional: [Visibility, Skin, Instances],
        changed: [ShadowParticipation],
      })
      .unwrap();
    this.changedInstancesQuery = world
      .query({
        read: [GlobalTransform, MeshFilter, MeshRenderer, Instances],
        optional: [Visibility, ShadowParticipation],
        changed: [Instances],
      })
      .unwrap();
    this.cameraQuery = world.query({ read: [GlobalTransform, Camera] }).unwrap();
    this.dirLightQuery = world.query({ read: [DirectionalLight] }).unwrap();
    this.pointLightQuery = world.query({ read: [GlobalTransform, PointLight] }).unwrap();
    this.spotLightQuery = world.query({ read: [GlobalTransform, SpotLight] }).unwrap();
    this.skylightQuery = world.query({ read: [Skylight] }).unwrap();
    this.fogQuery = world.query({ read: [Fog] }).unwrap();
    this.skyboxQuery = world.query({ read: [SkyboxBackground] }).unwrap();

    // Register ForgeAX D-Q7 default mid-grey material for MeshRenderer.materials = []
    this.renderer
      .ensureMaterial({
        key: DEFAULT_MATERIAL_KEY,
        baseColor: [0.65, 0.65, 0.65, 1],
        roughness: 0.6,
        metallic: 0.0,
        label: 'forgeax-default-material',
      })
      .unwrap();
  }

  private readAsset<T>(handle: AssetHandle): T | undefined {
    const snapRes = this.assets.snapshot(handle);
    if (!snapRes.ok) return undefined;
    const snap = snapRes.value;
    try {
      const readRes = snap.read<T>(handle as unknown as number);
      return readRes.ok ? readRes.value : undefined;
    } finally {
      snap.dispose();
    }
  }

  private ensureEcsMesh(handle: AssetHandle<'mesh'>): boolean {
    const key = handle as unknown as number;
    if (key === 0) return false;
    if (this.uploadedMeshes.has(key)) return true;
    const asset = this.readAsset<MeshAsset>(handle);
    if (asset === undefined || asset.kind !== 'mesh') return false;
    const extracted = extractPackedMeshVertices(asset);
    const submeshes: DesktopSubmeshInput[] | undefined =
      asset.submeshes !== undefined && asset.submeshes.length > 0
        ? asset.submeshes.map((s) => ({
            firstIndex: s.indexOffset ?? 0,
            indexCount: s.indexCount ?? 0,
            vertexCount: s.vertexCount ?? 0,
          }))
        : undefined;
    const uploaded = this.renderer.ensureMesh({
      key,
      vertices: extracted.vertices,
      indices: asset.indices,
      skinned: extracted.skinned,
      ...(submeshes !== undefined ? { submeshes } : {}),
      boundsMin: extracted.boundsMin,
      boundsMax: extracted.boundsMax,
      label: `ecs-mesh-${key}`,
    });
    if (!uploaded.ok) return false;
    this.uploadedMeshes.add(key);
    if (asset.submeshes !== undefined && asset.submeshes.length > 1) {
      this.meshSubmeshSlots.set(
        key,
        asset.submeshes.map((s) => s.materialSlot ?? 0),
      );
    }
    return true;
  }

  private ensureEcsTexture(handle: AssetHandle<'texture'>): number | undefined {
    const key = handle as unknown as number;
    if (key === 0) return undefined;
    if (this.uploadedTextures.has(key)) return key;
    const tex = this.readAsset<TextureAsset>(handle);
    if (tex === undefined || tex.kind !== 'texture') return undefined;
    if (tex.shape.viewDimension !== '2d') return undefined;
    const { width, height } = tex.shape.extent;
    const expectedBytes = width * height * 4;
    if (tex.data.byteLength < expectedBytes) return undefined;
    const bytes =
      tex.data.byteLength === expectedBytes ? tex.data : tex.data.subarray(0, expectedBytes);
    const uploaded = this.renderer.ensureTexture({
      key,
      width,
      height,
      rgbaBytes: bytes,
      label: `ecs-tex-${key}`,
    });
    if (!uploaded.ok) return undefined;
    this.uploadedTextures.add(key);
    return key;
  }

  private ensureOptionalEcsTexture(value: unknown): number | undefined {
    const handle = readTextureHandle(value);
    return handle !== undefined ? this.ensureEcsTexture(handle) : undefined;
  }

  private registerMaterialCustomShader(
    key: number,
    mat: EcsMaterialAsset,
    values: Readonly<Record<string, unknown>>,
  ): string | undefined {
    const customWgsl = resolveMaterialCustomWgsl(mat, values);
    if (customWgsl === undefined) return undefined;
    const candidateKey = `ecs-mat-shader-${key}`;
    const reg = this.renderer.registerCustomShader(candidateKey, customWgsl, {
      label: candidateKey,
    });
    return reg.ok ? candidateKey : undefined;
  }

  private resolveMaterialTextureKeys(values: Readonly<Record<string, unknown>>): {
    readonly baseColorTextureKey?: number;
    readonly normalTextureKey?: number;
    readonly metallicRoughnessTextureKey?: number;
    readonly emissiveTextureKey?: number;
    readonly occlusionTextureKey?: number;
  } {
    const baseColorTextureKey = this.ensureOptionalEcsTexture(
      values.baseColorMap ?? values.albedoMap ?? values.diffuseMap ?? values.map,
    );
    const normalTextureKey = this.ensureOptionalEcsTexture(values.normalMap);
    const metallicRoughnessTextureKey = this.ensureOptionalEcsTexture(
      values.metallicRoughnessMap ?? values.roughnessMap ?? values.metalnessMap,
    );
    const emissiveTextureKey = this.ensureOptionalEcsTexture(values.emissiveMap);
    const occlusionTextureKey = this.ensureOptionalEcsTexture(values.occlusionMap ?? values.aoMap);
    return {
      ...(baseColorTextureKey !== undefined ? { baseColorTextureKey } : {}),
      ...(normalTextureKey !== undefined ? { normalTextureKey } : {}),
      ...(metallicRoughnessTextureKey !== undefined ? { metallicRoughnessTextureKey } : {}),
      ...(emissiveTextureKey !== undefined ? { emissiveTextureKey } : {}),
      ...(occlusionTextureKey !== undefined ? { occlusionTextureKey } : {}),
    };
  }

  private ensureEcsMaterial(handle: AssetHandle<'material'> | undefined): string | number {
    if (handle === undefined || (handle as unknown as number) === 0) {
      return DEFAULT_MATERIAL_KEY;
    }
    const key = handle as unknown as number;
    if (this.seenMaterialsThisFrame.has(key)) return key;
    this.seenMaterialsThisFrame.add(key);

    const revRes = this.assets.revision(handle);
    if (!revRes.ok) return DEFAULT_MATERIAL_KEY;
    const rev = revRes.value;
    if (this.materialRevisions.get(key) === rev) {
      return key;
    }

    const mat = this.readAsset<EcsMaterialAsset>(handle);
    if (mat === undefined || mat.kind !== 'material') {
      return DEFAULT_MATERIAL_KEY;
    }
    const values = mat.values ?? {};
    const customShaderKey = this.registerMaterialCustomShader(key, mat, values);
    const pbr = resolveMaterialPbrParams(values);
    const textures = this.resolveMaterialTextureKeys(values);
    const alpha = resolveMaterialAlphaAndQueue(mat, values, pbr.baseColor[3]);
    const doubleSided = mat.renderState?.cullMode === 'none';

    const desc: DesktopMaterialInput = {
      key,
      baseColor: pbr.baseColor,
      roughness: pbr.roughness,
      metallic: pbr.metallic,
      normalScale: pbr.normalScale,
      occlusionStrength: pbr.occlusionStrength,
      alphaMode: alpha.alphaMode,
      ...(alpha.alphaCutoff !== undefined ? { alphaCutoff: alpha.alphaCutoff } : {}),
      ...(pbr.emissive !== undefined ? { emissive: pbr.emissive } : {}),
      queue: alpha.queue,
      transparent: alpha.transparent,
      doubleSided,
      ...textures,
      ...(customShaderKey !== undefined ? { customShaderKey } : {}),
      label: `ecs-mat-${key}`,
    };
    const ensured = this.renderer.ensureMaterial(desc);
    if (!ensured.ok) return DEFAULT_MATERIAL_KEY;
    this.materialRevisions.set(key, rev);
    this.trackedMaterialHandles.set(key, handle);
    return key;
  }

  private ensureDirtyTransformBuffer(minCount: number): void {
    if (minCount <= this.dirtyTransformEntityIds.length) return;
    let next = this.dirtyTransformEntityIds.length;
    while (next < minCount) next *= 2;
    const nextIds = new Uint32Array(next);
    nextIds.set(this.dirtyTransformEntityIds);
    this.dirtyTransformEntityIds = nextIds;
    const nextMats = new Float32Array(next * 16);
    nextMats.set(this.dirtyTransformMatrices);
    this.dirtyTransformMatrices = nextMats;
  }

  private writeCameraMatrices(
    worldMat: Float32Array,
    cam: {
      readonly projection: number;
      readonly left: number;
      readonly right: number;
      readonly bottom: number;
      readonly top: number;
      readonly near: number;
      readonly far: number;
      readonly autoAspect: boolean | number;
      readonly aspect: number;
      readonly fov: number;
    },
    aspectFallback: number,
  ): void {
    this.camPosScratch[0] = worldMat[12] ?? 0;
    this.camPosScratch[1] = worldMat[13] ?? 0;
    this.camPosScratch[2] = worldMat[14] ?? 0;

    desktopMat4Invert(worldMat, this.viewMatrixScratch);
    if (cam.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
      desktopMat4Ortho(
        cam.left,
        cam.right,
        cam.bottom,
        cam.top,
        cam.near,
        cam.far,
        this.projMatrixScratch,
      );
    } else {
      const aspect = cam.autoAspect ? aspectFallback : cam.aspect || aspectFallback;
      desktopMat4Perspective(cam.fov, aspect, cam.near, cam.far, this.projMatrixScratch);
    }
    desktopMat4Multiply(this.projMatrixScratch, this.viewMatrixScratch, this.viewProjScratch);
  }

  private writeCameraClearColor(cc: ArrayLike<number> | undefined): void {
    if (cc !== undefined && cc.length >= 4 && (cc[0] || cc[1] || cc[2] || cc[3])) {
      this.clearColorScratch[0] = cc[0] ?? 0;
      this.clearColorScratch[1] = cc[1] ?? 0;
      this.clearColorScratch[2] = cc[2] ?? 0;
      this.clearColorScratch[3] = cc[3] ?? 1;
      return;
    }
    this.clearColorScratch[0] = 0.05;
    this.clearColorScratch[1] = 0.08;
    this.clearColorScratch[2] = 0.14;
    this.clearColorScratch[3] = 1;
  }

  private extractCameraAndLights(width: number, height: number, dt: number) {
    this.elapsedSeconds += dt;
    this.seenMaterialsThisFrame.clear();
    this.frameLights.length = 0;

    const activeCamId = getActiveCamera(this.world)?.entity;
    let foundCamera = false;
    let camExposure = 1.0;
    let camCullMask = 0xffff_ffff;
    let camBloom: DesktopBloomInput | undefined;
    let camFxaa = false;
    const aspectFallback = Math.max(1, width) / Math.max(1, height);

    this.cameraQuery.forEach((row) => {
      const entityId = row.entity as unknown as number;
      if (foundCamera && (activeCamId === undefined || entityId !== activeCamId)) return;
      const gt = row.get(GlobalTransform);
      const cam = row.get(Camera);
      this.writeCameraMatrices(gt.world, cam, aspectFallback);
      this.writeCameraClearColor(cam.clearColor);
      camExposure = cam.exposure || 1.0;
      camCullMask = cam.cullMask >>> 0 || 0xffff_ffff;
      if (cam.bloom === BLOOM_ENABLED) {
        camBloom = {
          enabled: true,
          threshold: cam.bloomThreshold,
          intensity: cam.bloomIntensity,
        };
      }
      camFxaa = cam.antialias === ANTIALIAS_FXAA || cam.antialias === ANTIALIAS_MSAA_FXAA;
      foundCamera = true;
    });

    if (!foundCamera) {
      this.camPosScratch[0] = 0;
      this.camPosScratch[1] = 3;
      this.camPosScratch[2] = 8;
      desktopMat4Perspective(Math.PI / 4, aspectFallback, 0.1, 500, this.projMatrixScratch);
      this.viewMatrixScratch.fill(0);
      this.viewMatrixScratch[0] = 1;
      this.viewMatrixScratch[5] = 1;
      this.viewMatrixScratch[10] = 1;
      this.viewMatrixScratch[12] = 0;
      this.viewMatrixScratch[13] = -3;
      this.viewMatrixScratch[14] = -8;
      this.viewMatrixScratch[15] = 1;
      desktopMat4Multiply(this.projMatrixScratch, this.viewMatrixScratch, this.viewProjScratch);
    }

    this.dirLightQuery.forEach((row) => {
      const l = row.get(DirectionalLight);
      const id = row.entity as unknown as number;
      this.frameLights.push({
        id,
        kind: 'directional',
        direction: [l.direction[0] ?? 0, l.direction[1] ?? -1, l.direction[2] ?? 0],
        color: [l.color[0] ?? 1, l.color[1] ?? 1, l.color[2] ?? 1],
        intensity: l.intensity,
        castShadow: Boolean(l.castShadow),
        cascadeCount: l.cascadeCount ?? 1,
        shadowDistance: l.shadowDistance,
      });
    });

    this.pointLightQuery.forEach((row) => {
      const gt = row.get(GlobalTransform);
      const l = row.get(PointLight);
      const id = row.entity as unknown as number;
      this.frameLights.push({
        id,
        kind: 'point',
        position: [gt.world[12] ?? 0, gt.world[13] ?? 0, gt.world[14] ?? 0],
        color: [l.color[0] ?? 1, l.color[1] ?? 1, l.color[2] ?? 1],
        intensity: l.intensity,
        range: l.range,
      });
    });

    this.spotLightQuery.forEach((row) => {
      const gt = row.get(GlobalTransform);
      const l = row.get(SpotLight);
      const id = row.entity as unknown as number;
      this.frameLights.push({
        id,
        kind: 'spot',
        position: [gt.world[12] ?? 0, gt.world[13] ?? 0, gt.world[14] ?? 0],
        direction: [l.direction[0] ?? 0, l.direction[1] ?? -1, l.direction[2] ?? 0],
        color: [l.color[0] ?? 1, l.color[1] ?? 1, l.color[2] ?? 1],
        intensity: l.intensity,
        range: l.range,
        outerConeCos: Math.cos(Math.max(0, Math.min(89, l.outerConeDeg)) * DEG_TO_RAD),
      });
    });

    let skylight: DesktopSkylightInput | undefined;
    this.skylightQuery.forEach((row) => {
      if (skylight !== undefined) return;
      const sl = row.get(Skylight);
      const sc = sl.color;
      const gc = sl.groundColor;
      this.skylightSkyScratch[0] = sc[0] ?? 1;
      this.skylightSkyScratch[1] = sc[1] ?? 1;
      this.skylightSkyScratch[2] = sc[2] ?? 1;
      const hasGround =
        gc !== undefined && ((gc[0] ?? 0) > 0 || (gc[1] ?? 0) > 0 || (gc[2] ?? 0) > 0);
      if (hasGround) {
        this.skylightGroundScratch[0] = gc[0] ?? 0;
        this.skylightGroundScratch[1] = gc[1] ?? 0;
        this.skylightGroundScratch[2] = gc[2] ?? 0;
      } else {
        this.skylightGroundScratch[0] = this.skylightSkyScratch[0];
        this.skylightGroundScratch[1] = this.skylightSkyScratch[1];
        this.skylightGroundScratch[2] = this.skylightSkyScratch[2];
      }
      skylight = {
        skyColor: this.skylightSkyScratch,
        groundColor: this.skylightGroundScratch,
        intensity: sl.intensity,
      };
    });

    let fog: DesktopFogInput | undefined;
    this.fogQuery.forEach((row) => {
      if (fog !== undefined) return;
      const f = row.get(Fog);
      const mode: DesktopFogInput['mode'] =
        f.mode === FogModeValue.linear ? 'linear' : f.mode === FogModeValue.exp2 ? 'exp2' : 'exp';
      fog = {
        mode,
        color: [f.color[0] ?? 0, f.color[1] ?? 0, f.color[2] ?? 0],
        density: f.density,
        heightFalloff: f.heightFalloff,
        near: f.near,
        far: f.far,
        maxOpacity: f.maxOpacity,
      };
    });

    let skybox: DesktopSkyboxInput | undefined;
    this.skyboxQuery.forEach(() => {
      if (skybox !== undefined) return;
      const sky = skylight?.skyColor ?? [0.22, 0.45, 0.85];
      const ground = skylight?.groundColor ?? [0.12, 0.11, 0.1];
      skybox = {
        zenithColor: [sky[0] * 0.85, sky[1] * 0.95, sky[2] * 1.15],
        horizonColor: [
          Math.min(1, sky[0] * 1.2 + 0.12),
          Math.min(1, sky[1] * 1.2 + 0.14),
          Math.min(1, sky[2] * 1.2 + 0.16),
        ],
        groundColor: ground,
        intensity: skylight?.intensity ?? 1.0,
      };
    });

    return {
      camera: {
        viewProj: this.viewProjScratch,
        position: this.camPosScratch,
        clearColor: this.clearColorScratch,
        exposure: camExposure,
        cullMask: camCullMask,
        ...(camBloom !== undefined ? { bloom: camBloom } : {}),
        ...(camFxaa ? { fxaa: true } : {}),
      },
      skylight,
      fog,
      skybox,
    };
  }

  private uploadSkinPalette(
    entityId: number,
    skeletonHandle: AssetHandle<'skeleton'>,
    joints: ArrayLike<number>,
  ): boolean {
    const skeleton = this.readAsset<SkeletonAsset>(skeletonHandle);
    if (skeleton === undefined || skeleton.kind !== 'skeleton') return false;
    const jointCount = Math.min(skeleton.jointCount, joints.length);
    if (jointCount <= 0) return false;
    const neededFloats = jointCount * 16;
    if (this.skinPaletteScratch.length < neededFloats) {
      let next = this.skinPaletteScratch.length;
      while (next < neededFloats) next *= 2;
      this.skinPaletteScratch = new Float32Array(next);
    }
    const ibm = skeleton.inverseBindMatrices;
    for (let j = 0; j < jointCount; j++) {
      const jointEntity = joints[j];
      const gtRes =
        jointEntity !== undefined
          ? this.world.get(jointEntity as unknown as Parameters<World['get']>[0], GlobalTransform)
          : undefined;
      const outOff = j * 16;
      const ibmSlice = ibm.subarray(outOff, outOff + 16);
      if (gtRes?.ok) {
        desktopMat4Multiply(gtRes.value.world, ibmSlice, this.instanceWorldScratch);
        this.skinPaletteScratch.set(this.instanceWorldScratch, outOff);
      } else {
        this.skinPaletteScratch.set(ibmSlice, outOff);
      }
    }
    this.renderer.setSkinJoints(entityId, this.skinPaletteScratch, jointCount);
    return true;
  }

  private allocObjectSlot(slotIdx: number): MutableObjectSlot {
    let slot = this.objectPool[slotIdx];
    if (slot === undefined) {
      slot = {
        entityId: 0,
        meshKey: 0,
        submeshIndex: 0,
        materialKey: DEFAULT_MATERIAL_KEY,
        skinKey: undefined,
        skinAffinePoint: false,
        worldMatrix: new Float32Array(16),
        visible: true,
        castShadow: true,
        receiveShadow: true,
        frustumCulled: true,
        layerMask: 1,
      };
      this.objectPool.push(slot);
    }
    return slot;
  }

  private resolveSubmeshMaterialKey(
    materials: readonly number[],
    submeshSlots: readonly number[] | undefined,
    submeshIndex: number,
  ): string | number {
    const matSlot = submeshSlots !== undefined ? (submeshSlots[submeshIndex] ?? 0) : 0;
    const matHandle = (materials[matSlot] ?? materials[0]) as AssetHandle<'material'> | undefined;
    return this.ensureEcsMaterial(matHandle);
  }

  private writeObjectSlot(
    slotIdx: number,
    entityId: number,
    meshKey: number,
    submeshIndex: number,
    materialKey: string | number,
    skinKey: number | undefined,
    skinAffinePoint: boolean,
    worldMatrix: Float32Array,
    visible: boolean,
    castShadow: boolean,
    receiveShadow: boolean,
    frustumCulled: boolean,
    layerMask: number,
  ): number {
    const slot = this.allocObjectSlot(slotIdx);
    slot.entityId = entityId;
    slot.meshKey = meshKey;
    slot.submeshIndex = submeshIndex;
    slot.materialKey = materialKey;
    slot.skinKey = skinKey;
    slot.skinAffinePoint = skinAffinePoint;
    slot.worldMatrix.set(worldMatrix);
    slot.visible = visible;
    slot.castShadow = castShadow;
    slot.receiveShadow = receiveShadow;
    slot.frustumCulled = frustumCulled;
    slot.layerMask = layerMask;
    this.frameObjects.push(slot);
    return slotIdx + 1;
  }

  private pushInstancedRenderableSlots(
    slotIdx: number,
    entityId: number,
    meshKey: number,
    submeshSlots: readonly number[] | undefined,
    submeshCount: number,
    materials: readonly number[],
    worldMatrix: Float32Array,
    transforms: Float32Array,
    visible: boolean,
    castShadow: boolean,
    receiveShadow: boolean,
    frustumCulled: boolean,
    layerMask: number,
  ): number {
    const instanceCount = Math.floor(transforms.length / 16);
    this.instancedEntityCounts.set(entityId, instanceCount);
    let nextIdx = slotIdx;
    for (let s = 0; s < submeshCount; s++) {
      const materialKey = this.resolveSubmeshMaterialKey(materials, submeshSlots, s);
      for (let inst = 0; inst < instanceCount; inst++) {
        const localOff = inst * 16;
        for (let k = 0; k < 16; k++) {
          this.instanceMatScratch[k] = transforms[localOff + k] ?? 0;
        }
        desktopMat4Multiply(worldMatrix, this.instanceMatScratch, this.instanceWorldScratch);
        nextIdx = this.writeObjectSlot(
          nextIdx,
          INSTANCE_ENTITY_BASE + entityId * 65536 + inst * 16 + s,
          meshKey,
          s,
          materialKey,
          undefined,
          false,
          this.instanceWorldScratch,
          visible,
          castShadow,
          receiveShadow,
          frustumCulled,
          layerMask,
        );
      }
    }
    return nextIdx;
  }

  private pushStandardRenderableSlots(
    slotIdx: number,
    entityId: number,
    meshKey: number,
    submeshSlots: readonly number[] | undefined,
    submeshCount: number,
    materials: readonly number[],
    worldMatrix: Float32Array,
    skinKey: number | undefined,
    skinAffinePoint: boolean,
    visible: boolean,
    castShadow: boolean,
    receiveShadow: boolean,
    frustumCulled: boolean,
    layerMask: number,
  ): number {
    let nextIdx = slotIdx;
    for (let s = 0; s < submeshCount; s++) {
      const materialKey = this.resolveSubmeshMaterialKey(materials, submeshSlots, s);
      const slotEntityId = submeshCount > 1 ? entityId * 1024 + s : entityId;
      nextIdx = this.writeObjectSlot(
        nextIdx,
        slotEntityId,
        meshKey,
        s,
        materialKey,
        skinKey,
        skinAffinePoint,
        worldMatrix,
        visible,
        castShadow,
        receiveShadow,
        frustumCulled,
        layerMask,
      );
    }
    return nextIdx;
  }

  private pushRenderableSlot(
    slotIdx: number,
    entityId: number,
    meshHandle: AssetHandle<'mesh'>,
    mr: {
      readonly materials: readonly number[];
      readonly frustumCulled: boolean;
      readonly renderLayers: number;
    },
    gt: { readonly world: Float32Array },
    vis: { readonly state: number } | undefined,
    sp: { readonly cast: boolean; readonly receive: boolean } | undefined,
    skin:
      | {
          readonly skeleton: AssetHandle<'skeleton'>;
          readonly joints: ArrayLike<number>;
          readonly affinePoint?: boolean;
        }
      | undefined = undefined,
    instances: { readonly transforms: Float32Array } | undefined = undefined,
  ): number {
    // ForgeAX contract: Skin + Instances coexistence on one entity is forbidden.
    if (skin !== undefined && instances !== undefined) return slotIdx;
    if (!this.ensureEcsMesh(meshHandle)) return slotIdx;
    const meshKey = meshHandle as unknown as number;
    const submeshSlots = this.meshSubmeshSlots.get(meshKey);
    const submeshCount = submeshSlots !== undefined ? submeshSlots.length : 1;
    if (submeshCount > 1) {
      this.entitySubmeshCounts.set(entityId, submeshCount);
    } else {
      this.entitySubmeshCounts.delete(entityId);
    }

    const visible = vis === undefined || vis.state !== VisibilityStateValue.hidden;
    const castShadow = sp === undefined ? true : Boolean(sp.cast);
    const receiveShadow = sp === undefined ? true : Boolean(sp.receive);
    const layerMask = mr.renderLayers >>> 0 || 1;

    // GPU Skinning path
    let skinKey: number | undefined;
    let skinAffinePoint = false;
    if (skin !== undefined && this.uploadSkinPalette(entityId, skin.skeleton, skin.joints)) {
      skinKey = entityId;
      skinAffinePoint = Boolean(skin.affinePoint);
      this.activeSkinnedEntities.set(entityId, {
        skeleton: skin.skeleton,
        joints: skin.joints,
      });
    }
    const frustumCulled = skinKey !== undefined ? false : Boolean(mr.frustumCulled);

    // Hardware Instancing path (`Instances` component -> folds into 1 draw call in Rust draw_list)
    if (instances !== undefined && instances.transforms.length >= 16) {
      return this.pushInstancedRenderableSlots(
        slotIdx,
        entityId,
        meshKey,
        submeshSlots,
        submeshCount,
        mr.materials,
        gt.world,
        instances.transforms,
        visible,
        castShadow,
        receiveShadow,
        frustumCulled,
        layerMask,
      );
    }

    return this.pushStandardRenderableSlots(
      slotIdx,
      entityId,
      meshKey,
      submeshSlots,
      submeshCount,
      mr.materials,
      gt.world,
      skinKey,
      skinAffinePoint,
      visible,
      castShadow,
      receiveShadow,
      frustumCulled,
      layerMask,
    );
  }

  private markChangeQueriesObserved(): void {
    this.changedTransformQuery.markObserved();
    this.changedMeshFilterQuery.markObserved();
    this.changedMeshRendererQuery.markObserved();
    this.changedVisibilityQuery.markObserved();
    this.changedShadowQuery.markObserved();
    this.changedInstancesQuery.markObserved();
  }

  private extractFrame(width: number, height: number, dt: number) {
    const { camera, skylight, fog, skybox } = this.extractCameraAndLights(width, height, dt);
    this.frameObjects.length = 0;
    this.entitySubmeshCounts.clear();
    this.activeSkinnedEntities.clear();
    this.instancedEntityCounts.clear();

    let slotIdx = 0;
    this.renderableQuery.forEach((row) => {
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        row.entity as unknown as number,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        row.get(Skin),
        row.get(Instances),
      );
    });
    this.lastStructureEpoch = this.world.getStructureEpoch();
    this.initializedScene = true;
    this.markChangeQueriesObserved();

    return {
      width,
      height,
      camera,
      lights: this.frameLights,
      objects: this.frameObjects,
      elapsedSeconds: this.elapsedSeconds,
      deltaSeconds: dt,
      ...(this.ambientColor !== undefined ? { ambientColor: this.ambientColor } : {}),
      ...(skylight !== undefined ? { skylight } : {}),
      ...(fog !== undefined ? { fog } : {}),
      ...(skybox !== undefined ? { skybox } : {}),
    };
  }

  /**
   * Extracts live ECS state and submits an async pipelined frame on the OS render thread.
   * When world archetype structure is unchanged, consumes ECS change-detection queries directly
   * so only mutated transforms/renderables are touched on the JS main thread.
   */
  submitFrameAsync(width: number, height: number, dt = 1 / 60): Result<number, KernelError> {
    const structureEpoch = this.world.getStructureEpoch();
    if (!this.initializedScene || structureEpoch !== this.lastStructureEpoch) {
      return this.renderer.submitFrameAsync(this.extractFrame(width, height, dt));
    }

    const { camera, skylight, fog, skybox } = this.extractCameraAndLights(width, height, dt);

    // Refresh any live material asset edits by O(unique materials) revision check
    for (const handle of this.trackedMaterialHandles.values()) {
      this.ensureEcsMaterial(handle);
    }

    // Refresh live GPU skinning palettes for active skinned characters (O(skinned * joints))
    for (const [skinEntityId, rec] of this.activeSkinnedEntities) {
      this.uploadSkinPalette(skinEntityId, rec.skeleton, rec.joints);
    }

    // Collect only metadata-changed renderables via ECS change queries
    this.frameObjects.length = 0;
    const removedEntityIds: number[] = [];
    let slotIdx = 0;
    this.changedMeshFilterQuery.forEach((row) => {
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        row.entity as unknown as number,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        row.get(Skin),
        row.get(Instances),
      );
    });
    this.changedMeshRendererQuery.forEach((row) => {
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        row.entity as unknown as number,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        row.get(Skin),
        row.get(Instances),
      );
    });
    this.changedVisibilityQuery.forEach((row) => {
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        row.entity as unknown as number,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        row.get(Skin),
        row.get(Instances),
      );
    });
    this.changedShadowQuery.forEach((row) => {
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        row.entity as unknown as number,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        row.get(Skin),
        row.get(Instances),
      );
    });
    this.changedInstancesQuery.forEach((row) => {
      const entityId = row.entity as unknown as number;
      const prevCount = this.instancedEntityCounts.get(entityId) ?? 0;
      const inst = row.get(Instances);
      const nextCount = Math.floor(inst.transforms.length / 16);
      if (nextCount < prevCount) {
        const subCount = this.entitySubmeshCounts.get(entityId) ?? 1;
        for (let s = 0; s < subCount; s++) {
          for (let i = nextCount; i < prevCount; i++) {
            removedEntityIds.push(INSTANCE_ENTITY_BASE + entityId * 65536 + i * 16 + s);
          }
        }
      }
      slotIdx = this.pushRenderableSlot(
        slotIdx,
        entityId,
        row.get(MeshFilter).assetHandle,
        row.get(MeshRenderer),
        row.get(GlobalTransform),
        row.get(Visibility),
        row.get(ShadowParticipation),
        undefined,
        inst,
      );
    });

    // Collect only moved/rotated GlobalTransform rows via ECS chunked change detection
    let dirtyTransformCount = 0;
    this.changedTransformQuery.forEach((row) => {
      const entityId = row.entity as unknown as number;
      const gt = row.get(GlobalTransform);
      const subCount = this.entitySubmeshCounts.get(entityId) ?? 1;
      const inst = row.get(Instances);
      if (inst !== undefined && inst.transforms.length >= 16) {
        const instanceCount = Math.floor(inst.transforms.length / 16);
        this.ensureDirtyTransformBuffer(dirtyTransformCount + instanceCount * subCount);
        for (let s = 0; s < subCount; s++) {
          for (let i = 0; i < instanceCount; i++) {
            const localOff = i * 16;
            for (let k = 0; k < 16; k++) {
              this.instanceMatScratch[k] = inst.transforms[localOff + k] ?? 0;
            }
            desktopMat4Multiply(gt.world, this.instanceMatScratch, this.instanceWorldScratch);
            this.dirtyTransformEntityIds[dirtyTransformCount] =
              INSTANCE_ENTITY_BASE + entityId * 65536 + i * 16 + s;
            this.dirtyTransformMatrices.set(this.instanceWorldScratch, dirtyTransformCount * 16);
            dirtyTransformCount += 1;
          }
        }
      } else if (subCount > 1) {
        this.ensureDirtyTransformBuffer(dirtyTransformCount + subCount);
        for (let s = 0; s < subCount; s++) {
          this.dirtyTransformEntityIds[dirtyTransformCount] = entityId * 1024 + s;
          this.dirtyTransformMatrices.set(gt.world, dirtyTransformCount * 16);
          dirtyTransformCount += 1;
        }
      } else {
        this.ensureDirtyTransformBuffer(dirtyTransformCount + 1);
        this.dirtyTransformEntityIds[dirtyTransformCount] = entityId;
        this.dirtyTransformMatrices.set(gt.world, dirtyTransformCount * 16);
        dirtyTransformCount += 1;
      }
    });

    return this.renderer.submitIncrementalFrameAsync({
      width,
      height,
      camera,
      lights: this.frameLights,
      ...(this.frameObjects.length > 0 ? { upserts: this.frameObjects } : {}),
      ...(removedEntityIds.length > 0 ? { removedEntityIds } : {}),
      dirtyTransformEntityIds: this.dirtyTransformEntityIds,
      dirtyTransformMatrices: this.dirtyTransformMatrices,
      dirtyTransformCount,
      elapsedSeconds: this.elapsedSeconds,
      deltaSeconds: dt,
      ...(this.ambientColor !== undefined ? { ambientColor: this.ambientColor } : {}),
      ...(skylight !== undefined ? { skylight } : {}),
      ...(fog !== undefined ? { fog } : {}),
      ...(skybox !== undefined ? { skybox } : {}),
    });
  }

  /** Extracts live ECS state and executes one deterministic pixel-witness frame with readback. */
  renderWitnessFrame(
    width: number,
    height: number,
  ): Result<DesktopWitnessFrameResult, KernelError> {
    return this.renderer.renderWitnessFrame(this.extractFrame(width, height, 1 / 60));
  }

  setDebugLines(vertices: Float32Array | null): Result<void, KernelError> {
    return this.renderer.setDebugLines(vertices);
  }

  clearDebugLines(): void {
    this.renderer.clearDebugLines();
  }

  /**
   * Resets ECS upload caches after a native GPU device-loss recovery so the next frame
   * re-emits a complete baseline SceneDelta onto the recovered device.
   */
  resetForRecovery(): void {
    this.initializedScene = false;
    this.lastStructureEpoch = -1;
    this.uploadedMeshes.clear();
    this.meshSubmeshSlots.clear();
    this.entitySubmeshCounts.clear();
    this.uploadedTextures.clear();
    this.materialRevisions.clear();
    this.trackedMaterialHandles.clear();
    this.activeSkinnedEntities.clear();
    this.instancedEntityCounts.clear();
  }

  recover(): Result<number, KernelError> {
    const recovered = this.renderer.recover();
    if (!recovered.ok) return recovered;
    this.resetForRecovery();
    return recovered;
  }

  trimPoolTextures(): Result<number, KernelError> {
    return this.renderer.trimPoolTextures();
  }

  setUiOverlayRgba(
    width: number,
    height: number,
    rgbaBytes: Uint8Array,
    revision?: number,
  ): Result<boolean, KernelError> {
    return this.renderer.setUiOverlayRgba(width, height, rgbaBytes, revision);
  }

  clearUiOverlay(): void {
    this.renderer.clearUiOverlay();
  }

  /**
   * Evaluates a ForgeAX `UiPaintSource` (`rgba` mode) and uploads changed UI overlay bytes
   * into the retained DynamicTexture composited over the 3D scene.
   */
  paintUiSource(
    source: UiPaintSource | undefined,
    timeMs: number,
    width: number,
    height: number,
  ): Result<boolean, KernelError> {
    if (source === undefined || source.kind !== 'rgba') {
      return ok(false);
    }
    const bytes = source.paint(timeMs, width, height);
    if (bytes === null) return ok(false);
    return this.renderer.setUiOverlayRgba(width, height, bytes);
  }

  /**
   * Exposes a `DesktopWindow` adapter backed by NativeRenderKernel's winit window, directly
   * consumable by `createDesktopPlatform` and `createDesktopInput`.
   */
  asDesktopWindow() {
    const r = this.renderer;
    return {
      facts: () => r.getWindowFacts(),
      pollEvents: () =>
        ok(
          r
            .pollWindowEvents()
            .unwrap()
            .map((ev) => {
              if (ev.kind === 'resized' || ev.kind === 'scale-changed') {
                return { kind: 'display' as const };
              }
              return ev;
            }),
        ),
      requestRedraw: () => r.requestRedraw(),
      setPointerLock: (locked: boolean) => r.setPointerLock(locked),
      setImeArea: (area: readonly [number, number, number, number] | null) => r.setImeArea(area),
    };
  }

  pollWindowEvents(): Result<readonly NativeWindowEvent[], KernelError> {
    return this.renderer.pollWindowEvents();
  }

  resizeWindow(width: number, height: number): Result<void, KernelError> {
    return this.renderer.resizeWindow(width, height);
  }

  getWindowPhysicalSize(): Result<readonly [number, number], KernelError> {
    return this.renderer.getWindowPhysicalSize();
  }

  flush(): Result<void, KernelError> {
    return this.renderer.flush();
  }

  getStats(): Result<DesktopSceneStats, KernelError> {
    return this.renderer.getStats();
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

export function createForgeaxDesktopNativeRenderer(
  world: World,
  assets: AssetRegistry,
  options?: ForgeaxDesktopNativeRendererOptions,
): Result<ForgeaxDesktopNativeRenderer, KernelError> {
  const created = createDesktopNativeSceneRenderer(options);
  if (!created.ok) return created;
  return ok(new ForgeaxDesktopNativeRenderer(world, assets, created.value, options?.ambientColor));
}
