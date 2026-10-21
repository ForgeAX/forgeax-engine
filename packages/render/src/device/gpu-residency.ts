import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { AssetHandle } from '@forgeax/engine-types';
import { compareBufferBytes } from '../buffer-bytes';
import type { IblPrecomputeOutput } from '../ibl/IblPipelineCache';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderAssetRevision } from '../publication/resource-scope';
import { type RecordProfileRunner, runRecordProfilePhase } from '../record/render-context';
import { ImagePages } from './image-pages';
import { MeshChanges, type MeshChangeToken } from './mesh-changes';
import { type ResidencyLease, ResidencyLifetime } from './residency-lifetime';
import { type GpuResourceNamespace, ScopedGpuResources } from './scoped-gpu-resources';
import { TextureDerivations } from './texture-derivation';
// @forgeax/engine-runtime - GpuResidencyCache
// (feat-20260601-device/gpu-residency-extraction M1; M2 added the deriveRenderData
// projection seam — see render-data.ts).
//
// Owns the GPU residency layer extracted from AssetRegistry: per-handle GPU
// texture / cubemap / mesh buffer caches plus the upload primitives that
// build them. The store is engine-agnostic by default (no @webgpu/types
// imports) and holds ZERO reference to AssetRegistry (D-2): every upload
// primitive receives its source POD from the caller, never reaches back into
// a registry. The cubemap path mints its EquirectAsset POD handle through
// a wire-injected `registerCube` callback (D-3) so CPU cataloguing stays the
// registry's job while the store keeps the single-call upload contract. The
// cubemap projection (`_uploadCubemapFromEquirect`) is internal (@internal,
// feat-20260630): AI users declare `Skylight{equirect}` and the render-system
// record arm drives the projection; the method is never reached from user code.
//
// Residency model (D-2 pull): consumers call `ensureResident(handle, pod)`
// at first draw-time access; the store builds the GPU resource on a miss and
// returns the cached handles on subsequent O(1) hits. There is no global
// replay queue -- the pull model is purely lazy (user ruling). Builtin
// meshes are NOT routed through `ensureResident`; createRenderer seeds them
// via its step-3 direct upload + pipelineState.meshes (D-1).
//
// Texture residency is SYNCHRONOUS (D-9): `uploadTexture`'s only async source
// was the one-time per-device mipmap shader-module build, which is hoisted to
// `prewarmMipmapPipeline` (called from `createRenderer.initialization`, already async).
// After prewarm the per-texture mipmap blit is pure synchronous encoder work,
// so the sync `draw(world)` frame contract is preserved. A format that was
// not prewarmed surfaces a structured RhiError on the sync path -- it is never
// lazily awaited (that would break the sync draw contract).

import {
  encodeMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapEncoderWork,
  type MipmapShaderModuleFactory,
  type MipmapTextureDescriptor,
  prepareMipmaps,
} from '@forgeax/engine-assets-runtime';
import {
  createPrimitiveMesh,
  deriveVertexCount,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  type Buffer,
  type BufferDescriptor,
  type CommandBuffer,
  err,
  ok,
  type Result,
  type RhiCaps,
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type RhiQueue,
  type Sampler,
  type Texture,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  countExtraUvSets,
  type DecodedImage,
  deriveTextureLayout,
  type EquirectAsset,
  type ImageError,
  type ImageErrorDetailFor,
  imageError,
  type PrimitiveTopology,
  type SamplerAsset,
  type TextureAsset,
  type TextureShape,
  type MeshAsset as TypesMeshAsset,
  textureFormatBlock,
} from '@forgeax/engine-types';
import { GpuBuffer, GpuTexture } from '../gpu-resource';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import {
  CAPTURE_VIEW_PROJS,
  CUBEMAP_FACE_VERTICES,
  createIblPipelines,
  IBL_UNIFORM_SLOT_STRIDE,
  type IblShaderModuleFactory,
  PREFILTER_SIZE,
  prefilterSubpassIndex,
  runIblPrecompute,
} from '../ibl/IblPipelineCache';
import { pmremLevelCount } from '../ibl/pmrem';
import type { RhiErrorListenerRegistry } from '../lifecycle';
import {
  type CubeRenderData,
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
  type MeshRenderData,
  type TextureRenderData,
} from '../render-data';
import type { DeviceScope, LifecycleResourceSpec } from './device-scope';

const FACE_COUNT = 6;

export type FaceUniformsDevice = Pick<RhiDevice, 'createBuffer'> & {
  readonly queue: Pick<RhiQueue, 'writeBuffer'>;
};

function invalidUniformInput(expected: string, hint: string): Result<never, RhiError> {
  return err(new RhiError({ code: 'webgpu-runtime-error', expected, hint }));
}

export function createFaceUniformsBuffer(device: FaceUniformsDevice): Result<Buffer, RhiError> {
  const descriptor: BufferDescriptor = {
    label: 'ibl-face-uniforms',
    size: FACE_COUNT * IBL_UNIFORM_SLOT_STRIDE,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  };
  return device.createBuffer(descriptor);
}

export function createPrefilterUniformsBuffer(
  device: FaceUniformsDevice,
  size = PREFILTER_SIZE,
): Result<Buffer, RhiError> {
  const descriptor: BufferDescriptor = {
    label: 'ibl-prefilter-uniforms',
    size: pmremLevelCount(size) * FACE_COUNT * IBL_UNIFORM_SLOT_STRIDE,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  };
  return device.createBuffer(descriptor);
}

export function writeFaceUniforms(
  device: FaceUniformsDevice,
  buffer: Buffer,
  faceIdx: number,
  viewProj: Float32Array,
): Result<void, RhiError> {
  if (faceIdx < 0 || faceIdx >= FACE_COUNT) {
    return invalidUniformInput(
      'faceIdx is an integer in the inclusive range [0, 5]',
      `writeFaceUniforms received faceIdx=${faceIdx}`,
    );
  }
  if (viewProj.length !== 16) {
    return invalidUniformInput(
      'viewProj contains exactly 16 floats',
      `writeFaceUniforms received ${viewProj.length} floats`,
    );
  }
  return device.queue.writeBuffer(buffer, faceIdx * IBL_UNIFORM_SLOT_STRIDE, viewProj);
}

export function writeAllFaceUniforms(
  device: FaceUniformsDevice,
  buffer: Buffer,
): Result<void, RhiError> {
  for (let face = 0; face < FACE_COUNT; face++) {
    const viewProj = CAPTURE_VIEW_PROJS[face];
    if (viewProj === undefined) continue;
    const result = writeFaceUniforms(device, buffer, face, viewProj);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

export function writeAllPrefilterUniforms(
  device: FaceUniformsDevice,
  buffer: Buffer,
  size = PREFILTER_SIZE,
  sourceSpace: 'image' | 'camera' = 'image',
): Result<void, RhiError> {
  if (size < 16 || !Number.isInteger(Math.log2(size))) {
    return invalidUniformInput(
      'a power-of-two PMREM face size of at least 16',
      `writeAllPrefilterUniforms received size=${size}`,
    );
  }
  for (let level = 0; level < pmremLevelCount(size); level++) {
    for (let face = 0; face < FACE_COUNT; face++) {
      const written = device.queue.writeBuffer(
        buffer,
        prefilterSubpassIndex(level, face) * IBL_UNIFORM_SLOT_STRIDE,
        new Float32Array([level, face, Number(sourceSpace === 'camera'), 0]),
      );
      if (!written.ok) return written;
    }
  }
  return ok(undefined);
}

/**
 * Upload an offline-baked mip chain. Each
 * level uses its own block-padded bytesPerRow / rowsPerImage and mip-major
 * byte offset (deriveTextureLayout, SSOT block math); full-subresource copies
 * keep their logical size for non-block-aligned dimensions. writeTexture
 * avoids the 256 B copyBufferToTexture row-alignment trap.
 */
export function writePackedTextureLevels(
  device: Pick<RhiDevice, 'queue'>,
  texture: Texture,
  tex: TextureAsset,
  format: GPUTextureFormat,
  bytes: Uint8Array,
): Result<void, AssetError | RhiError> {
  const layout = deriveTextureLayout({ shape: tex.shape, format, mips: tex.mips });
  if (!layout.ok) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: layout.error.expected,
        hint: layout.error.hint,
      }),
    );
  }
  for (const level of layout.value.levels) {
    for (let image = 0; image < level.imagesPerMip; image++) {
      const imageBytes = level.bytesPerRow * level.rowsPerImage;
      const offset = level.byteOffset + image * imageBytes;
      const writeRes = device.queue.writeTexture(
        { texture, mipLevel: level.level, origin: { x: 0, y: 0, z: image } },
        bytes.subarray(offset, offset + imageBytes),
        { offset: 0, bytesPerRow: level.bytesPerRow, rowsPerImage: level.rowsPerImage },
        { width: level.physicalWidth, height: level.physicalHeight, depthOrArrayLayers: 1 },
      );
      if (!writeRes.ok) return writeRes;
    }
  }
  return ok(undefined);
}

// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M-3 / w11:
// the three handle map value types now hold GpuTexture / GpuBuffer wrappers
// (plan-strategy D-9). Views (TextureView) stay raw RHI handles -- they are
// not destroyable on their own; their lifetime is bound to the parent
// GpuTexture, which the wrapper owns. destroyAll() walks the GpuResource
// fields and forwards .destroy() to the RHI shim.
export interface TextureResidencyReceipt {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;
  readonly extent: {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
  };
  readonly bytes: number;
  readonly view: '2d' | '2d-array' | '3d';
  readonly generation: number;
  readonly deviceEpoch: number;
  /** Accepted source bytes represented by this physical allocation, when owner-backed. */
  readonly sourceRevision?: number;
}

const EMPTY_LOD_MESHES: readonly (TypesMeshAsset | undefined)[] = Object.freeze([]);

/** One physical allocation owns both retirement and its immutable success publication. */
class PublishedResidency<T> extends ResidencyLifetime {
  readonly result: Result<T, never>;
  constructor(value: T, destroy: () => void) {
    super(destroy);
    this.result = Object.freeze(ok(value));
  }
}

export interface TextureGpuEntry {
  readonly texture: GpuTexture;
  /** Opaque RHI view handle; lifetime is bound to the parent texture. */
  readonly view: TextureView;
  readonly receipt: TextureResidencyReceipt;
}

/** A cold texture stays private until the caller submits its graph mip writers.
 * The caller also fences producer identity; current() checks only residency. */
export interface GraphTextureResidencyPreparation {
  readonly entry: TextureGpuEntry;
  readonly needsMipmaps: boolean;
  readonly lease: ResidencyLease;
  current(): boolean;
  commit(): boolean;
}

/** Candidate-only residency work; no queue submission is hidden here. */
export interface RecoveryResidencyPreparation {
  readonly mipmapWork?: MipmapEncoderWork;
}

// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M2 / w11
// (D-3): the projection-status truth lives here (the store's cubemap map is the
// single authority — the SkylightSnapshot carries no status, D-3). `status`:
//   - 'pending' — projection launched (fire-and-forget) but not complete; the
//     record arm binds the white-cube fallback for this frame.
//   - 'ready'   — texture + cube view + 6 face views are live; bind the real
//     IBL cube.
//   - 'failed'  — projection errored; recorded EXPLICITLY so the record arm
//     stops and does NOT retry every frame (R-2 / AC-09). A failed entry has
//     no GPU resources (texture/view are placeholders never bound).
// `texture`/`view`/`faceViews` are non-readonly so a 'pending' entry can be
// promoted to 'ready' in place (rebuilds the same slot). A 'failed' entry holds
// no GPU resources (`texture:null` / `view:undefined`): it exists only to mark
// the source as terminally failed so the record arm stops retrying (R-2).
interface CubemapGpuEntry {
  readonly revision: number | undefined;
  scope?: DeviceScope;
  status: 'pending' | 'ready' | 'failed';
  texture: GpuTexture | null;
  view: TextureView | undefined;
  faceViews: readonly TextureView[];
  /** Present exactly when `status === 'failed'`. */
  failure?: AssetError | RhiError;
  ibl?: IblPrecomputeOutput;
}

interface PackedMeshLodGeometry {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array | undefined;
  readonly lodRanges: readonly (readonly MeshGpuRange[])[] | undefined;
}

function packMeshLodGeometry(
  root: TypesMeshAsset,
  rootData: MeshRenderData,
  lowerMeshes: readonly (TypesMeshAsset | undefined)[],
): Result<PackedMeshLodGeometry, RhiError> {
  if (lowerMeshes.length === 0) {
    return ok({ vertices: root.vertices, indices: root.indices, lodRanges: undefined });
  }
  const rootStride = rootData.layoutProjection.arrayStride;
  const allMeshes = [root, ...lowerMeshes];
  const lowerData: (MeshRenderData | undefined)[] = [];
  for (const lower of lowerMeshes) {
    if (lower === undefined) {
      lowerData.push(undefined);
      continue;
    }
    const projected = deriveRenderDataMesh(lower);
    if (!projected.ok) {
      return err(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'every MeshAsset LOD to project to a compatible GPU layout',
          hint: 'repair the lower-detail MeshAsset attributes before drawing the LOD chain',
        }),
      );
    }
    lowerData.push(projected.value);
  }
  if (
    deriveVertexCount(root.vertices, rootData.layoutProjection) === undefined ||
    lowerMeshes.some((mesh, index) => {
      if (mesh === undefined) return false;
      const data = lowerData[index];
      return (
        data === undefined || deriveVertexCount(mesh.vertices, data.layoutProjection) === undefined
      );
    })
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'every MeshAsset LOD vertex byte length to match its layout projection stride',
        hint: 'reimport the LOD chain so interleaved vertex bytes match attributes',
      }),
    );
  }
  if (
    lowerData.some(
      (data) =>
        data !== undefined &&
        (data.layoutProjection.arrayStride !== rootStride ||
          data.submeshes.length !== rootData.submeshes.length ||
          data.indexFormat !== rootData.indexFormat),
    )
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'LOD meshes to share vertex/index layout and material-slot topology',
        hint: 'reimport LOD meshes with matching attributes, index format, and submesh slots',
      }),
    );
  }
  if (
    allMeshes.some(
      (mesh) => mesh !== undefined && (mesh.indices === undefined) !== (root.indices === undefined),
    )
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'all LOD meshes to use the same indexed or non-indexed draw mode',
        hint: 'reimport the LOD chain with consistent index data',
      }),
    );
  }
  const vertices = new Float32Array(
    allMeshes.reduce((sum, mesh) => sum + (mesh?.vertices.length ?? 0), 0),
  );
  const ranges: MeshGpuRange[][] = [];
  let vertexCursor = 0;
  let indexCursor = 0;
  const indexed = root.indices !== undefined;
  const sourceIndices: number[] = [];
  let requiresUint32 = root.indices instanceof Uint32Array;
  for (let level = 0; level < allMeshes.length; level += 1) {
    const mesh = allMeshes[level];
    const data = level === 0 ? rootData : lowerData[level - 1];
    if (mesh === undefined || data === undefined) {
      // Preserve the authored level index without allocating substitute geometry.
      ranges.push([]);
      continue;
    }
    vertices.set(mesh.vertices, vertexCursor);
    const levelRanges: MeshGpuRange[] = [];
    for (let submeshIndex = 0; submeshIndex < data.submeshes.length; submeshIndex += 1) {
      const submesh = data.submeshes[submeshIndex];
      const rootSubmesh = rootData.submeshes[submeshIndex];
      if (
        submesh === undefined ||
        rootSubmesh === undefined ||
        submesh.materialSlot !== rootSubmesh.materialSlot ||
        submesh.topology !== rootSubmesh.topology
      ) {
        return err(
          new RhiError({
            code: 'asset-not-registered',
            expected: 'LOD submeshes to preserve root material-slot and topology identity',
            hint: 'repair LOD material slots and primitive topology before import',
          }),
        );
      }
      levelRanges.push(
        indexed
          ? { first: indexCursor + submesh.indexOffset, count: submesh.indexCount, baseVertex: 0 }
          : { first: vertexCursor / (rootStride / 4), count: submesh.vertexCount, baseVertex: 0 },
      );
    }
    ranges.push(levelRanges);
    if (indexed) {
      const indices = mesh.indices;
      if (indices === undefined) continue;
      // Rebase into the packed vertex buffer here instead of through draw
      // baseVertex: WebGL2 has no base-vertex draw, and CPU-lane LOD draws
      // each level through the ordinary drawIndexed(firstIndex) path.
      const levelBase = vertexCursor / (rootStride / 4);
      if (indices instanceof Uint32Array) requiresUint32 = true;
      for (const value of indices) {
        const absolute = value + levelBase;
        sourceIndices.push(absolute);
        if (absolute > 0xffff) requiresUint32 = true;
      }
      indexCursor += indices.length;
    }
    vertexCursor += mesh.vertices.length;
  }
  const indices = indexed
    ? requiresUint32
      ? Uint32Array.from(sourceIndices)
      : Uint16Array.from(sourceIndices)
    : undefined;
  return ok({ vertices, indices, lodRanges: ranges });
}

/** Fixed physical candidate; commit publishes it, release retires its exact allocation. */
export interface PreparedMeshResidency {
  readonly entry: MeshGpuHandles;
  readonly lease: ResidencyLease;
  current(): boolean;
  commit(): boolean;
}

export interface MeshGpuHandles {
  /** Residency sequence when this mesh's buffer contents last changed. */
  readonly contentEpoch: number;
  /** Native physical generation; manual/custom handles cannot certify cache reuse. */
  readonly changeToken?: MeshChangeToken;
  readonly vertexBuffer: GpuBuffer;
  /**
   * Index buffer wrapper, or `null` for a vertex-only mesh
   * (no `MeshAsset.indices`). When `null` the record stage takes the
   * non-indexed `pass.draw(vertexCount)` path and never calls
   * `setIndexBuffer`. Gated on `indexed` below.
   */
  readonly indexBuffer: GpuBuffer | null;
  /**
   * Allocation byte sizes for the vbo / ibo (mirrors GPUBuffer.size). Used
   * to validate managed range reuse versus reallocation; tracked here so
   * the runtime never reads `.size` off the opaque RHI handle (which is
   * not on the spec-aligned RHI Buffer interface; charter §RHI form rules).
   */
  readonly vboBytes: number;
  /** Allocation byte size for the ibo, or 0 when indexBuffer is null. */
  readonly iboBytes: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  /** Geometry-owned vertex layout projection used by every GPU consumer. */
  readonly layoutProjection: VertexLayoutProjection;
  /**
   * Number of UV sets the interleaved buffer carries (1 = single `uv`, +1 per
   * `uv1..uv7`). feat-20260629-multi-uv-set-support: threaded to the record
   * stage so the forward PSO's vertex layout stride matches the buffer for
   * meshes with a real extra UV set. Mirrors MeshRenderData.uvSetCount /
   * MeshRenderData.uvSetCount.
   */
  readonly uvSetCount: number;
  /** Vertex count derived from the geometry-owned layout projection. */
  readonly vertexCount: number;
  /** True when `MeshAsset.indices` is present (indexed draw path). */
  readonly indexed: boolean;
  /** Primitive topology (default 'triangle-list'). */
  readonly topology: PrimitiveTopology;
  /**
   * Submeshes from MeshAsset.submeshes, carried through to the record stage
   * so per-submesh drawIndexed can iterate independently (feat-20260608 M4 / w16).
   * For single-submesh meshes this is a 1-element array (byte-identical to pre-M4).
   */
  readonly submeshes: readonly import('@forgeax/engine-types').Submesh[];
  /** Packed root + lower-detail geometry ranges in the shared mesh buffers. */
  readonly lodRanges?: readonly (readonly MeshGpuRange[])[];
}

export interface MeshGpuRange {
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
}

/**
 * GPU residency store. Owns the per-handle GPU caches and the upload
 * primitives that build them. Constructed once per renderer; wired with the
 * GPU device via `configureGpuDevice` after `Renderer.initialization` resolves.
 */
const EMPTY_MESH_COMPARISON_WORDS = new Uint32Array(0);

type SharedMeshAllocation = {
  buffer: GpuBuffer;
  bytes: Uint32Array;
  owners: number;
  key: string;
};

interface TextureProjection {
  encode(encoder: () => RhiCommandEncoder): { complete(submitted: boolean): void } | undefined;
}
const NO_TEXTURE_WORK = ok(undefined);
const DERIVED_GEOMETRY = Symbol();

export class GpuResidencyCache {
  private readonly textureDerivations = new TextureDerivations();
  private readonly pendingImageAdoptions = new ScopedGpuResources<AssetChange>();
  /** Actual consumers can request RGBA for CPU image pages; ordinary GPU uploads select device caps. */
  prepareTextureData(
    handle: number,
    source: TextureAsset,
    world: RenderResourceScope | number = 0,
    target?: GPUTextureFormat,
  ): Result<TextureAsset, AssetError> {
    return this.textureDerivations.prepare(
      handle,
      typeof world === 'number' ? 0 : (renderAssetRevision(world, handle) ?? 0),
      source,
      this.caps,
      target,
      this.worldNamespace(world),
    );
  }
  async waitTextureData(handle: number, world: RenderResourceScope | number = 0): Promise<void> {
    await this.textureDerivations.settled(handle, this.worldNamespace(world));
  }
  isTexturePreparing(handle: number, world: RenderResourceScope | number = 0): boolean {
    return this.textureDerivations.preparing(handle, this.worldNamespace(world));
  }

  readonly imagePages = new ImagePages();
  private readonly imagePageScopes = new WeakMap<RenderResourceScope, Set<number>>();
  private readonly pendingTextureProjections = new Set<TextureProjection>();
  queueTextureProjection(projection: TextureProjection, device: RhiDevice): void {
    if (device === this.gpuDevice) this.pendingTextureProjections.add(projection);
  }
  cancelTextureProjection(projection: TextureProjection): void {
    this.pendingTextureProjections.delete(projection);
  }
  ensureImagePage(
    handle: number,
    texture: TextureAsset,
    world: RenderResourceScope | number = 0,
  ): number {
    if (typeof world !== 'number') {
      let handles = this.imagePageScopes.get(world);
      if (handles === undefined) {
        handles = new Set();
        this.imagePageScopes.set(world, handles);
      }
      handles.add(handle);
    }
    const native = this.prepareTextureData(
      handle,
      texture,
      world,
      texture.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    ).unwrap();
    return this.imagePages.ensure(handle, native, this.worldNamespace(world));
  }

  releaseImagePages(world: RenderResourceScope): void {
    for (const handle of this.imagePageScopes.get(world) ?? [])
      this.imagePages.remove(handle, this.worldNamespace(world));
    this.imagePageScopes.delete(world);
  }
  private readonly meshSourceRevisions = new WeakMap<MeshGpuHandles, number>();
  readonly meshChanges = new MeshChanges();
  /** Monotonic within the native Mesh owner generation; no second publication clock. */
  get meshResidencyEpoch(): number {
    return this.meshChanges.epoch;
  }
  private gpuDevice: RhiDevice | undefined = undefined;
  /** RHI-only owner for IBL projection; never populated with a raw GPUDevice. */
  private iblDevice: RhiDevice | undefined = undefined;
  /** RHI Result-returning shader factory paired with `iblDevice`. */
  private iblShaderModuleFactory: IblShaderModuleFactory | undefined = undefined;
  private deviceScope: DeviceScope | undefined;
  // Shader-module factory injected at `configureGpuDevice`; threaded into the
  // mipmap-pipeline prewarm + the IBL precompute path. `undefined` until wired.
  private asyncCreateShaderModule: MipmapShaderModuleFactory | undefined = undefined;
  // Error registry injected by createRenderer; evict / releaseUnreferenced
  // fire structured errors through this channel (feat-20260619 D-1/D-6).
  private errorRegistry: RhiErrorListenerRegistry | undefined = undefined;
  // Hardware-probe caps injected at `configureGpuDevice`; guards the HDR cubemap
  // path (_uploadCubemapFromEquirect) when `rgba16floatRenderable` is false.
  private caps: RhiCaps | undefined = undefined;
  private deviceEpoch = 0;
  private textureGeneration = 0;

  private readonly textureGpuHandles = new ScopedGpuResources<TextureGpuEntry>();
  private readonly textureUploads = new ScopedGpuResources<{ dispose(): void }>();

  private cancelTextureUpload(key: string | number, namespace: GpuResourceNamespace): void {
    const pending = this.textureUploads.get(key, namespace);
    if (pending === undefined) return;
    this.textureUploads.delete(key, namespace);
    pending.dispose();
  }
  private readonly pendingTextureMips = new Map<Texture, MipmapTextureDescriptor>();

  /** Lazy texture uploads discovered while recording execute before that frame's draws. */
  prepareTextureMips(): Result<
    | {
        readonly buffer: CommandBuffer | undefined;
        complete(submitted: boolean): void;
      }
    | undefined,
    RhiError
  > {
    if (this.pendingTextureMips.size === 0 && this.pendingTextureProjections.size === 0)
      return NO_TEXTURE_WORK;
    const device = this.gpuDevice;
    if (device === undefined) return NO_TEXTURE_WORK;
    const epoch = this.deviceEpoch;
    // Source pages must precede every derived bake even if a retained Terrain
    // binding entered the queue before another view authored new image work.
    const projections = this.pendingTextureProjections.delete(this.imagePages)
      ? [this.imagePages, ...this.pendingTextureProjections]
      : [...this.pendingTextureProjections];
    this.pendingTextureProjections.clear();
    let encoder: RhiCommandEncoder | undefined;
    const commands = () => {
      encoder ??= device.createCommandEncoder({ label: 'texture-mips' }).unwrap();
      return encoder;
    };
    const entries = [...this.pendingTextureMips];
    const releases: (() => void)[] = [];
    const projected: { complete(submitted: boolean): void }[] = [];
    let finished = false;
    let completed = false;
    const complete = (submitted: boolean) => {
      if (completed) return;
      completed = true;
      let failures: unknown[] | undefined;
      const settle = (action: () => void) => {
        try {
          action();
        } catch (cause) {
          failures ??= [];
          failures.push(cause);
        }
      };
      if (submitted) {
        for (const [texture, descriptor] of entries)
          if (this.pendingTextureMips.get(texture) === descriptor)
            this.pendingTextureMips.delete(texture);
      } else if (this.deviceEpoch === epoch) {
        for (const projection of projections) this.pendingTextureProjections.add(projection);
      }
      for (const work of projected) settle(() => work.complete(submitted));
      if (!finished && encoder !== undefined) {
        finished = true;
        const unfinished = encoder;
        settle(() => unfinished.finish().unwrap());
      }
      for (const release of releases) settle(release);
      if (failures?.length === 1) throw failures[0];
      if (failures !== undefined)
        throw new AggregateError(failures, 'texture projection completion failed');
    };
    try {
      for (const projection of projections) {
        const work = projection.encode(commands);
        if (work !== undefined) projected.push(work);
      }
      for (const [texture, descriptor] of entries) {
        const encoded = encodeMipmaps(device, commands(), texture, descriptor);
        if (!encoded.ok) throw encoded.error;
        releases.push(encoded.value);
      }
      if (encoder === undefined && projected.length === 0) return NO_TEXTURE_WORK;
      finished = true;
      const result = encoder?.finish();
      if (result !== undefined && !result.ok) throw result.error;
      return ok({ buffer: result?.value, complete });
    } catch (cause) {
      try {
        complete(false);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'texture projection preparation failed');
      }
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
  }
  private readonly samplerGpuHandles = new ScopedGpuResources<{
    readonly source: SamplerAsset;
    readonly revision: number | undefined;
    readonly sampler: Sampler;
    readonly result: Result<Sampler, never>;
  }>();
  private readonly cubemapGpuHandles = new ScopedGpuResources<CubemapGpuEntry>();
  // Completed projections retain the source asset identity within its resource scope.
  private readonly cubemapIdempotentMap = new ScopedGpuResources<AssetHandle<'equirect'>>();
  private readonly meshGpuHandles = new ScopedGpuResources<MeshGpuHandles>();
  /**
   * Lower-detail POD identities packed into each resident mesh entry. The
   * GPU entry only carries byte ranges; keeping the source identities beside
   * it lets a later draw upgrade a root-only upload without hashing vertices.
   */
  private readonly meshLodAssets = new WeakMap<
    MeshGpuHandles,
    readonly (TypesMeshAsset | undefined)[]
  >();
  private readonly meshLifetimes = new WeakMap<
    MeshGpuHandles,
    PublishedResidency<MeshGpuHandles>
  >();
  private meshSubmissions = new Set<Promise<unknown>>();
  private readonly retiredMeshes = new Set<MeshGpuHandles>();
  // Immutable vertex and index uploads share physical allocations by their exact bytes.
  // Mesh residency still fences each owner; the last retired owner frees the allocation.
  private readonly sharedMeshBuffers = new Map<string, SharedMeshAllocation>();
  private readonly meshBufferOwners = new WeakMap<GpuBuffer, SharedMeshAllocation>();
  private meshBufferKey(words: Uint32Array, usage: number): string {
    let hash = 2166136261;
    let index = 0;
    if (words.length > 256) {
      let second = hash;
      let third = hash;
      let fourth = hash;
      // Independent lanes keep full byte coverage without one long multiply dependency.
      for (; index + 3 < words.length; index += 4) {
        // biome-ignore lint/style/noNonNullAssertion: bounded by words.length
        hash = Math.imul(hash ^ words[index]!, 16777619);
        // biome-ignore lint/style/noNonNullAssertion: bounded by words.length
        second = Math.imul(second ^ words[index + 1]!, 16777619);
        // biome-ignore lint/style/noNonNullAssertion: bounded by words.length
        third = Math.imul(third ^ words[index + 2]!, 16777619);
        // biome-ignore lint/style/noNonNullAssertion: bounded by words.length
        fourth = Math.imul(fourth ^ words[index + 3]!, 16777619);
      }
      hash = Math.imul(hash ^ second, 16777619);
      hash = Math.imul(hash ^ third, 16777619);
      hash = Math.imul(hash ^ fourth, 16777619);
    }
    for (; index < words.length; index++)
      // biome-ignore lint/style/noNonNullAssertion: bounded by words.length
      hash = Math.imul(hash ^ words[index]!, 16777619);
    return `${usage}:${words.byteLength}:${hash >>> 0}`;
  }
  private sharedMeshBuffer(key: string, words: Uint32Array): SharedMeshAllocation | undefined {
    const cached = this.sharedMeshBuffers.get(key);
    // Hashes only select candidates; byte equality is the sharing contract.
    if (cached === undefined || cached.buffer.isDestroyed || cached.bytes.length !== words.length)
      return undefined;
    if (words.byteLength >= 65_536) {
      const compared = compareBufferBytes(
        cached.bytes.buffer,
        cached.bytes.byteOffset,
        words.buffer,
        words.byteOffset,
        words.byteLength,
      );
      if (compared !== undefined) return compared ? cached : undefined;
    }
    for (let index = 0; index < words.length; index++)
      if (cached.bytes[index] !== words[index]) return undefined;
    return cached;
  }
  private retainMeshBuffer(allocation: SharedMeshAllocation): GpuBuffer {
    allocation.owners++;
    this.meshBufferOwners.set(allocation.buffer, allocation);
    this.sharedMeshBuffers.set(allocation.key, allocation);
    return allocation.buffer;
  }
  private unshareMeshBuffer(buffer: GpuBuffer): void {
    const record = this.meshBufferOwners.get(buffer);
    if (record === undefined) return;
    if (this.sharedMeshBuffers.get(record.key) === record)
      this.sharedMeshBuffers.delete(record.key);
    record.bytes = EMPTY_MESH_COMPARISON_WORDS;
  }
  private releaseMeshBuffer(buffer: GpuBuffer): void {
    const record = this.meshBufferOwners.get(buffer);
    if (record !== undefined && --record.owners > 0) return;
    this.unshareMeshBuffer(buffer);
    this.meshBufferOwners.delete(buffer);
    if (!buffer.isDestroyed) buffer.destroy();
  }

  private readonly textureLifetimes = new WeakMap<
    TextureGpuEntry,
    PublishedResidency<TextureGpuEntry>
  >();
  private readonly retiredTextures = new Set<TextureGpuEntry>();

  private textureLifetime(entry: TextureGpuEntry): PublishedResidency<TextureGpuEntry> {
    let lifetime = this.textureLifetimes.get(entry);
    if (lifetime === undefined) {
      lifetime = new PublishedResidency(entry, () => {
        this.pendingTextureMips.delete(entry.texture.handle);
        if (!entry.texture.isDestroyed) {
          const result = entry.texture.destroy();
          if (!result.ok) this.errorRegistry?.fire(result.error);
        }
        this.retiredTextures.delete(entry);
      });
      this.textureLifetimes.set(entry, lifetime);
    }
    return lifetime;
  }

  private retireTextureEntry(
    key: string | number,
    entry: TextureGpuEntry,
    namespace: GpuResourceNamespace,
  ): void {
    if (this.textureGpuHandles.get(key, namespace) === entry) {
      this.textureGpuHandles.delete(key, namespace);
    }
    this.retiredTextures.add(entry);
    this.textureLifetime(entry).retire();
  }

  private meshLifetime(entry: MeshGpuHandles): PublishedResidency<MeshGpuHandles> {
    let lifetime = this.meshLifetimes.get(entry);
    if (lifetime === undefined) {
      lifetime = new PublishedResidency(entry, () => {
        this.releaseMeshBuffer(entry.vertexBuffer);
        if (entry.indexBuffer !== null) this.releaseMeshBuffer(entry.indexBuffer);
        this.retiredMeshes.delete(entry);
      });
      this.meshLifetimes.set(entry, lifetime);
    }
    return lifetime;
  }

  /** Unchanged frames record queue work once; mesh retirement captures its pending fences. */
  trackMeshSubmission(completed: Promise<unknown>): void {
    const submissions = this.meshSubmissions;
    if (!submissions.has(completed)) {
      submissions.add(completed);
      const finish = () => {
        submissions.delete(completed);
      };
      void completed.then(finish, finish);
    }
    for (const [key, entry] of this.pendingGeneratedRetirement) {
      this.retireMeshEntry(key, entry, DERIVED_GEOMETRY);
    }
    this.pendingGeneratedRetirement.clear();
  }

  private retainMeshEntry(entry: MeshGpuHandles, evict: () => void): ResidencyLease {
    const lifetime = this.meshLifetime(entry);
    const submissions = this.meshSubmissions;
    const epoch = this.deviceEpoch;
    const retained = lifetime.retain(() => {
      if (this.deviceEpoch === epoch) evict();
      else lifetime.retire();
    });
    let released = false;
    return {
      track: (completed) => retained.track(completed),
      release: (evict) => {
        if (!released) {
          released = true;
          // This caller waits only for work submitted before its release.
          if (!this.retiredMeshes.has(entry))
            for (const completed of submissions) lifetime.track(completed);
        }
        return retained.release(evict);
      },
    };
  }

  private retireMeshEntry(
    key: string | number,
    entry: MeshGpuHandles,
    namespace: GpuResourceNamespace,
  ): void {
    this.meshChanges.assertIdle();
    try {
      // Retirement belongs to the old physical generation even after key->B publication.
      if (entry.changeToken !== undefined) this.meshChanges.retire(entry.changeToken);
    } finally {
      if (this.meshGpuHandles.get(key, namespace) === entry) {
        this.meshGpuHandles.delete(key, namespace);
      }
      // Immutable buffers remain shareable until their final physical release.
      // Another live mesh or a pending submission may still own this allocation.
      const lifetime = this.meshLifetime(entry);
      if (!this.retiredMeshes.has(entry)) {
        this.retiredMeshes.add(entry);
        for (const completed of this.meshSubmissions) lifetime.track(completed);
      }
      lifetime.retire();
    }
  }

  // Frame indices are not resource identities. Stable tokens retain no source World.
  private readonly worldNamespaces = new WeakMap<RenderResourceScope, symbol>();
  private worldNamespace(world: RenderResourceScope | number): GpuResourceNamespace {
    if (typeof world === 'number') return world;
    let namespace = this.worldNamespaces.get(world);
    if (namespace === undefined) {
      namespace = Symbol();
      this.worldNamespaces.set(world, namespace);
    }
    return namespace;
  }

  /**
   * Wire the GPU device and shader-module factory.
   * Called once by createRenderer after `Renderer.initialization` resolves. Unlike the
   * pre-extraction AssetRegistry.configureGpuDevice, this performs NO replay:
   * the pull model builds resources lazily at first `ensureResident` access.
   */
  configureGpuDevice(
    device: RhiDevice,
    asyncCreateShaderModule: MipmapShaderModuleFactory | undefined,
    caps: RhiCaps,
  ): void {
    this.meshChanges.assertIdle();
    for (const entry of [...this.textureGpuHandles.values(), ...this.retiredTextures]) {
      if (!entry.texture.isDestroyed) entry.texture.destroy();
    }
    this.textureGpuHandles.clear();
    this.pendingTextureMips.clear();
    for (const pending of this.textureUploads.values()) pending.dispose();
    this.textureUploads.clear();
    this.retiredTextures.clear();
    for (const entry of this.cubemapGpuHandles.values()) this.retireCubemap(entry);
    this.cubemapGpuHandles.clear();
    this.cubemapIdempotentMap.clear();
    this.deviceEpoch += 1;
    this.meshSubmissions = new Set();
    this.meshChanges.reset();
    this.gpuDevice = device;
    this.pendingTextureProjections.clear();
    const epoch = this.deviceEpoch;
    this.imagePages.configure(device, () => {
      if (this.deviceEpoch === epoch) this.queueTextureProjection(this.imagePages, device);
    });
    this.asyncCreateShaderModule = asyncCreateShaderModule;
    this.caps = caps;
  }

  /**
   * Bind the IBL projection to the same opaque RhiDevice used by assembly.
   * This is deliberately separate from the legacy-compatible mipmap fixture
   * seam: unit fixtures that only exercise ordinary residency do not need an
   * IBL device, while a real IBL projection never accepts a raw GPUDevice.
   */
  configureIblDevice(
    device: RhiDevice,
    shaderModuleFactory: IblShaderModuleFactory | undefined,
  ): void {
    this.iblDevice = device;
    this.iblShaderModuleFactory = shaderModuleFactory;
  }

  /** Bind residency ownership to the renderer's single DeviceScope tree. */
  bindDeviceScope(scope: DeviceScope): void {
    this.deviceScope = scope;
  }

  /** Arm the first-published-frame assertion on this generation's store. */

  /**
   * Wrap a raw RHI Buffer handle into a GpuBuffer. The wrapper holds a
   * reference to the device so `.destroy()` forwards to
   * `device.destroyBuffer(handle)` (M-3 / w11; plan-strategy D-2).
   *
   * Pre: `configureGpuDevice` has been called. Callers that build a buffer
   * via `device.createBuffer` already gate on a wired device, so this private
   * helper trusts the caller; an unwired call is a programmer error and
   * surfaces as a non-null assertion rather than a structured error.
   */
  private wrapBuf(rawHandle: Buffer): GpuBuffer {
    const device = this.gpuDevice;
    if (device === undefined) {
      throw new Error('GpuResidencyCache.wrapBuf called before configureGpuDevice');
    }
    return new GpuBuffer(device, rawHandle, this.deviceScope);
  }

  /** Wrap a raw RHI Texture handle into a GpuTexture (mirror of wrapBuf). */
  private wrapTex(rawHandle: Texture): GpuTexture {
    const device = this.gpuDevice;
    if (device === undefined) {
      throw new Error('GpuResidencyCache.wrapTex called before configureGpuDevice');
    }
    return new GpuTexture(device, rawHandle, this.deviceScope);
  }

  /**
   * Walk the three handle maps and destroy every GpuResource, then clear
   * the maps. Called from `Renderer.dispose()` (M-5) as the first step of
   * the dispose chain (plan-strategy D-2: dispose chain walks
   * `gpuStore.destroyAll()` → `graph.drain()` → `instanceBuffers.clear()`
   * → ...).
   *
   * Idempotent: a second call after the maps were cleared is a no-op
   * (architecture-principles §6 idempotency). Each `.destroy()` call
   * routes through the RHI shim's per-handle bookkeeping, so a stray
   * second-destroy on a handle the runtime did not flip to destroyed
   * surfaces as the structured `'destroy-after-destroy'` error from the
   * RHI shim; that error is *not* re-thrown here -- destroyAll is a
   * sweep that tolerates per-handle failures so the dispose chain can
   * make progress (plan-strategy D-3 / D-8).
   */
  destroyAll(): void {
    this.meshChanges.assertIdle();
    this.textureDerivations.clear();
    this.pendingImageAdoptions.clear();
    this.imagePages.dispose();
    this.pendingTextureProjections.clear();
    for (const entry of this.cubemapGpuHandles.values()) this.retireCubemap(entry);
    // Also invalidate unpublished graph candidates, which are caller-owned.
    this.deviceEpoch += 1;
    this.meshSubmissions = new Set();
    this.meshChanges.reset();
    const scopeOwnsResources = this.deviceScope !== undefined;
    const destroyTex = (gpuTex: GpuTexture): void => {
      if (!scopeOwnsResources && !gpuTex.isDestroyed) gpuTex.destroy();
    };
    const destroyBuf = (gpuBuf: GpuBuffer): void => {
      if (!scopeOwnsResources && !gpuBuf.isDestroyed) gpuBuf.destroy();
    };

    for (const entry of [...this.textureGpuHandles.values(), ...this.retiredTextures]) {
      destroyTex(entry.texture);
    }
    this.textureGpuHandles.clear();
    this.pendingTextureMips.clear();
    for (const pending of this.textureUploads.values()) pending.dispose();
    this.textureUploads.clear();
    this.retiredTextures.clear();
    this.samplerGpuHandles.clear();

    for (const entry of this.cubemapGpuHandles.values()) {
      if (entry.texture !== null) destroyTex(entry.texture);
    }
    this.cubemapGpuHandles.clear();
    this.cubemapIdempotentMap.clear();

    for (const entry of [
      ...this.meshGpuHandles.values(),
      ...this.retiredMeshes,
      ...this.pendingGeneratedRetirement.values(),
    ]) {
      this.unshareMeshBuffer(entry.vertexBuffer);
      this.meshBufferOwners.delete(entry.vertexBuffer);
      destroyBuf(entry.vertexBuffer);
      if (entry.indexBuffer !== null) {
        this.unshareMeshBuffer(entry.indexBuffer);
        this.meshBufferOwners.delete(entry.indexBuffer);
        destroyBuf(entry.indexBuffer);
      }
    }
    this.meshGpuHandles.clear();
    this.generatedMeshes.clear();
    this.pendingGeneratedRetirement.clear();
    this.retiredMeshes.clear();
    this.sharedMeshBuffers.clear();
  }

  /** Number of candidate-owned GPU resources currently held by this cache. */
  recoveryResourceCount(): number {
    let cubemapResources = 0;
    const seen = new Set<GpuTexture>();
    for (const entry of this.cubemapGpuHandles.values()) {
      if (entry.texture !== null && !seen.has(entry.texture)) {
        seen.add(entry.texture);
        cubemapResources += 1;
      }
    }
    return (
      this.meshGpuHandles.size +
      this.retiredMeshes.size +
      this.textureGpuHandles.size +
      this.retiredTextures.size +
      this.samplerGpuHandles.size +
      cubemapResources
    );
  }

  /** Candidate root for the cache owner, not a scalar readiness marker. */
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'texture',
      create: () => {
        if (!scope.isAlive()) throw new Error('GPU residency candidate scope is not active.');
        if (this.recoveryResourceCount() === 0) {
          throw new Error('GPU residency candidate has no prepared resources.');
        }
        return this;
      },
      cleanup: () => undefined,
    };
  }

  /**
   * Set the error registry channel (wired by createRenderer). evict /
   * releaseUnreferenced fire structured errors here instead of throwing -
   * sweeps continue past individual failures (feat-20260619 D-1/D-6).
   */
  setErrorRegistry(registry: RhiErrorListenerRegistry): void {
    this.errorRegistry = registry;
  }

  /**
   * evictTexture / evictMesh / evictCubemap — per-handle evict primitives.
   *
   * Reuses destroyAll's isDestroyed dedup logic + cubemap wrapper
   * shared-dedup (feat-20260619 D-1). Returns {freed, errors} so callers
   * can consume the aggregate result (D-3). Key not present -> no-op
   * returning {freed:0, errors:[]}.
   */
  evictTexture(
    handle: AssetHandle<'texture'>,
    worldId: RenderResourceScope | number = 0,
  ): { freed: number; errors: RhiError[] } {
    const id = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const entry = this.textureGpuHandles.get(id, namespace);
    if (entry === undefined) return { freed: 0, errors: [] };
    if (this.textureLifetimes.get(entry)?.inUse) return { freed: 0, errors: [] };

    let freed = 0;
    const errors: RhiError[] = [];

    if (!entry.texture.isDestroyed) {
      const r = entry.texture.destroy();
      if (r.ok) {
        freed = 1;
      } else {
        errors.push(r.error);
        if (this.errorRegistry) this.errorRegistry.fire(r.error);
      }
    }

    this.textureGpuHandles.delete(id, namespace);
    return { freed, errors };
  }

  evictMesh(
    handle: AssetHandle<'mesh'>,
    worldId: RenderResourceScope | number = 0,
  ): { freed: number; errors: RhiError[] } {
    const id = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const entry = this.meshGpuHandles.get(id, namespace);
    if (entry === undefined) return { freed: 0, errors: [] };

    if (this.meshLifetime(entry).owners > 0) return { freed: 0, errors: [] };
    this.retireMeshEntry(id, entry, namespace);
    return {
      freed:
        Number(entry.vertexBuffer.isDestroyed) + Number(entry.indexBuffer?.isDestroyed ?? false),
      errors: [],
    };
  }

  /** Retire one derivative without walking its users or other asset records. */
  adoptCubemapChange(change: AssetChange, world: RenderResourceScope | number = 0): void {
    const entry = this.cubemapGpuHandles.get(change.handle, this.worldNamespace(world));
    if (entry === undefined || (!change.removed && entry.revision === change.revision)) return;
    this.evictCubemap(change.handle, world);
  }

  private retireCubemap(entry: CubemapGpuEntry): void {
    const scope = entry.scope;
    if (scope === undefined || !scope.isAlive()) return;
    // Stop subsequent precompute batches before fencing already submitted work.
    scope.beginRetire();
    const lifetime = new ResidencyLifetime(() => scope.retire());
    for (const completed of this.meshSubmissions) lifetime.track(completed);
    if (entry.status === 'pending' && this.iblDevice !== undefined) {
      try {
        lifetime.track(this.iblDevice.queue.onSubmittedWorkDone());
      } catch {
        // A lost queue cannot retain resources from its retired device.
      }
    }
    lifetime.retire();
  }

  evictCubemap(
    id: number,
    worldId: RenderResourceScope | number = 0,
  ): { freed: number; errors: RhiError[] } {
    const namespace = this.worldNamespace(worldId);
    const entry = this.cubemapGpuHandles.get(id, namespace);
    if (entry === undefined) return { freed: 0, errors: [] };
    this.cubemapGpuHandles.delete(id, namespace);
    this.cubemapIdempotentMap.delete(id, namespace);
    this.retireCubemap(entry);
    return { freed: Number(entry.texture?.isDestroyed ?? false), errors: [] };
  }

  /**
   * releaseUnreferenced — iterate the three handle maps and evict entries
   * whose key is NOT in `liveSet`.
   *
   * Iterates Map keys (not liveSet — store has no reverse index, D-8).
   * IDs in liveSet that don't exist in the store are naturally ignored.
   * Empty liveSet -> full release; second call -> no-op (maps empty,
   * evict primitives are key-not-present no-op).
   */
  releaseUnreferenced(liveSet: Set<number>): { freed: number; errors: RhiError[] } {
    let freed = 0;
    const errors: RhiError[] = [];
    for (const [namespace, resources] of this.textureGpuHandles.entries()) {
      for (const key of resources.keys()) {
        if (typeof key !== 'number' || !liveSet.has(key)) {
          const entry = this.textureGpuHandles.get(key, namespace);
          if (entry !== undefined && !this.textureLifetimes.get(entry)?.inUse) {
            if (!entry.texture.isDestroyed) {
              const r = entry.texture.destroy();
              if (r.ok) {
                freed += 1;
              } else {
                errors.push(r.error);
                if (this.errorRegistry) this.errorRegistry.fire(r.error);
              }
            }
            this.textureGpuHandles.delete(key, namespace);
          }
        }
      }
    }
    for (const [namespace, resources] of this.samplerGpuHandles.entries()) {
      for (const key of resources.keys()) {
        if (typeof key !== 'number' || !liveSet.has(key)) {
          this.samplerGpuHandles.delete(key, namespace);
        }
      }
    }
    for (const [namespace, resources] of this.cubemapGpuHandles.entries()) {
      for (const [key, entry] of resources) {
        if (typeof key === 'number' && liveSet.has(key)) continue;
        this.cubemapGpuHandles.delete(key, namespace);
        this.cubemapIdempotentMap.delete(key, namespace);
        this.retireCubemap(entry);
        freed += Number(entry.texture?.isDestroyed ?? false);
      }
    }

    for (const [namespace, resources] of this.meshGpuHandles.entries()) {
      for (const [key, entry] of resources) {
        if (
          namespace !== DERIVED_GEOMETRY &&
          (typeof key !== 'number' || !liveSet.has(key)) &&
          this.meshLifetime(entry).owners === 0
        ) {
          this.retireMeshEntry(key, entry, namespace);
          freed +=
            Number(entry.vertexBuffer.isDestroyed) +
            Number(entry.indexBuffer?.isDestroyed ?? false);
        }
      }
    }

    return { freed, errors };
  }

  /**
   * Prewarm the mipmap pipeline cache for the given texture formats (D-9).
   * Called from `createRenderer.initialization` (already async): builds the one-time
   * mipmap shader module + per-format render pipeline into the mipmap-generator
   * deviceCache so the per-texture mipmap blit at record-stage `ensureResident`
   * is pure synchronous encoder work. A format absent from this list will make
   * the sync `ensureResident` texture arm return a structured RhiError rather
   * than lazily await a build (which would break the sync draw contract).
   */
  async prewarmMipmapPipeline(
    device: RhiDevice,
    formats: readonly TextureFormat[],
  ): Promise<Result<void, RhiError>> {
    const factory = this.asyncCreateShaderModule;
    if (factory === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'asyncCreateShaderModule wired by configureGpuDevice before prewarm',
          hint: 'call gpuStore.configureGpuDevice(device, packShaderFactory, caps) before prewarmMipmapPipeline',
        }),
      );
    }
    for (const format of formats) {
      const res = await getOrCreateMipmapPipeline(device, format, factory);
      if (!res.ok) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: `mipmap pipeline for format ${format} builds during prewarm`,
            hint: `prewarmMipmapPipeline failed building the mipmap pipeline for ${format}; the format may be unsupported by the device`,
          }),
        );
      }
    }
    return ok(undefined);
  }

  /**
   * Return the GpuTexture wrapper for a `Handle<TextureAsset>` if it has been
   * made resident, else `undefined`.
   *
   * @internal — test-only seam for cow-survivor / AC-02 integration tests; not
   * part of the engine's public API surface.
   */
  _getTextureGpuTexture(
    handle: AssetHandle<'texture'>,
    worldId: RenderResourceScope | number = 0,
  ): GpuTexture | undefined {
    return this.textureGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.texture;
  }

  /**
   * Return the GPU texture-view for a `Handle<TextureAsset>` if it has been
   * made resident, else `undefined`.
   */
  getTextureGpuView(
    handle: AssetHandle<'texture'>,
    worldId: RenderResourceScope | number = 0,
  ): TextureView | undefined {
    return this.textureGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.view;
  }

  /**
   * Lazily materialise and cache a sampler descriptor for a material texture.
   * Samplers are opaque, non-destroyable RHI handles, so disposal only drops
   * this store's cache and lets the device own their lifetime.
   */
  ensureSamplerResident(
    handle: AssetHandle<'sampler'>,
    pod: SamplerAsset,
    worldId: RenderResourceScope | number = 0,
  ): Result<Sampler, RhiError> {
    const key = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const existing = this.samplerGpuHandles.get(key, namespace);
    const revision = typeof worldId === 'number' ? undefined : renderAssetRevision(worldId, handle);
    if (existing?.source === pod && existing.revision === revision) return existing.result;
    const device = this.gpuDevice;
    if (device === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GPU device configured before SamplerAsset residency',
          hint: 'call gpuStore.configureGpuDevice before drawing a material with a sampler',
        }),
      );
    }
    const { kind: _kind, ...descriptor } = pod;
    const created = device.createSampler(descriptor);
    if (!created.ok) return created;
    const sampler = created.value;
    this.samplerGpuHandles.set(
      key,
      {
        source: pod,
        revision,
        sampler,
        result: Object.freeze(ok(sampler)),
      },
      namespace,
    );
    return created;
  }

  /**
   * Return the GpuTexture wrapper for the cubemap, or `undefined` if not
   * uploaded yet. Consumers that need the raw RHI Texture handle (e.g.
   * `device.createTextureView` arguments) read `.handle` on the wrapper;
   * `.destroy()` routes through the destroy chain (M-3 / w11).
   */
  getCubemapGpuTexture(
    handle: AssetHandle<'equirect'>,
    worldId: RenderResourceScope | number = 0,
  ): GpuTexture | undefined {
    // A 'failed' entry has texture:null; normalise to undefined (not resident).
    return (
      this.cubemapGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.texture ?? undefined
    );
  }

  /** Return the full-cube texture view, or `undefined` if not uploaded yet. */
  getCubemapGpuView(
    handle: AssetHandle<'equirect'>,
    worldId: RenderResourceScope | number = 0,
  ): TextureView | undefined {
    return this.cubemapGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.view;
  }

  /** Return per-face 2D views (6 faces), or `undefined` if not uploaded yet. */
  getCubemapFaceViews(
    handle: AssetHandle<'equirect'>,
    worldId: RenderResourceScope | number = 0,
  ): readonly TextureView[] | undefined {
    return this.cubemapGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.faceViews;
  }

  /**
   * Query the projection status for an equirect source handle (D-3 SSOT: the
   * store's CubemapGpuEntry is the single authority). Returns `undefined` when
   * no projection has been launched for this source yet (the record arm reads
   * this to decide whether to fire the lazy projection; feat-20260630 M3 / w18):
   *   - undefined -> no entry: caller may launch projection (fire-and-forget)
   *   - 'pending' -> projection launched, not complete: bind white-cube fallback
   *   - 'ready'   -> projected cube + IBL views live: bind real IBL
   *   - 'failed'  -> projection errored: bind white fallback, do NOT retry (R-2)
   */
  getCubemapStatus(
    handle: AssetHandle<'equirect'>,
    worldId: RenderResourceScope | number = 0,
  ): 'pending' | 'ready' | 'failed' | undefined {
    return this.cubemapGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.status;
  }

  /** The structured failure recorded with a `'failed'` projection status. */
  getCubemapFailure(
    handle: AssetHandle<'equirect'>,
    worldId: RenderResourceScope | number = 0,
  ): AssetError | RhiError | undefined {
    return this.cubemapGpuHandles.get(Number(handle), this.worldNamespace(worldId))?.failure;
  }

  /** Completed IBL belongs to the same source and generation as its raw cube. */
  getCubemapIbl(
    handle: number,
    worldId: RenderResourceScope | number,
  ): IblPrecomputeOutput | undefined {
    return this.cubemapGpuHandles.get(handle, this.worldNamespace(worldId))?.ibl;
  }

  /**
   * Return the GPU vertex / index buffer handles + index count for a
   * `Handle<MeshAsset>` if resident, else `undefined`. Consumers treat this
   * as the canonical "mesh asset has GPU residency" probe.
   */
  getMeshGpuHandles(
    handle: AssetHandle<'mesh'>,
    worldId: RenderResourceScope | number = 0,
  ): MeshGpuHandles | undefined {
    return this.meshGpuHandles.get(Number(handle), this.worldNamespace(worldId));
  }

  private nineSliceMesh: TypesMeshAsset | undefined;

  /** Renderer-owned sprite tessellation; this is derived geometry, not an asset identity. */
  ensureNineSliceGeometry(): Result<MeshGpuHandles, RhiError | AssetError> {
    const namespace = DERIVED_GEOMETRY;
    const key = 'derived:nine-slice';
    const existing = this.meshGpuHandles.get(key, namespace);
    if (existing !== undefined) return this.meshLifetime(existing).result;
    this.nineSliceMesh ??= createPrimitiveMesh('nine-slice-quad').unwrap();
    const mesh = this.nineSliceMesh;
    const projected = deriveRenderDataMesh(mesh);
    return projected.ok
      ? this.uploadMeshById(key, mesh, projected.value, EMPTY_LOD_MESHES, undefined, namespace)
      : projected;
  }

  private readonly generatedMeshes = new Map<TypesMeshAsset, string>();
  private readonly pendingGeneratedRetirement = new Map<string, MeshGpuHandles>();
  private nextGeneratedMesh = 0;

  getGeneratedMesh(mesh: TypesMeshAsset): MeshGpuHandles | undefined {
    const namespace = DERIVED_GEOMETRY;
    const key = this.generatedMeshes.get(mesh);
    return key === undefined ? undefined : this.meshGpuHandles.get(key, namespace);
  }

  /** Immutable view-derived geometry uses native residency without minting an AssetHandle. */
  ensureGeneratedMesh(mesh: TypesMeshAsset): Result<MeshGpuHandles, RhiError | AssetError> {
    this.meshChanges.assertIdle();
    const namespace = DERIVED_GEOMETRY;
    let key = this.generatedMeshes.get(mesh);
    const entry = key === undefined ? undefined : this.meshGpuHandles.get(key, namespace);
    if (entry !== undefined && key !== undefined) {
      this.generatedMeshes.delete(mesh);
      this.generatedMeshes.set(mesh, key);
      return this.meshLifetime(entry).result;
    }
    const projected = deriveRenderDataMesh(mesh);
    if (!projected.ok) return projected;
    key = `derived:layout:${++this.nextGeneratedMesh}`;
    const result = this.uploadMeshById(
      key,
      mesh,
      projected.value,
      EMPTY_LOD_MESHES,
      undefined,
      namespace,
    );
    if (!result.ok) return result;
    this.generatedMeshes.set(mesh, key);
    // Bounded current cache. A draw already encoded in this submission keeps
    // its allocation until that submission's fence, even after LRU eviction.
    if (this.generatedMeshes.size > 256) {
      const oldest = this.generatedMeshes.entries().next().value;
      if (oldest !== undefined) {
        this.generatedMeshes.delete(oldest[0]);
        const retired = this.meshGpuHandles.get(oldest[1], namespace);
        if (retired !== undefined) {
          try {
            if (retired.changeToken !== undefined) this.meshChanges.retire(retired.changeToken);
          } finally {
            this.meshGpuHandles.delete(oldest[1], namespace);
            this.pendingGeneratedRetirement.set(oldest[1], retired);
          }
        }
      }
    }
    return result;
  }

  /** Candidate leases retain the concrete allocation even after cache invalidation. */
  retainMeshResidency(
    handle: AssetHandle<'mesh'>,
    worldId: RenderResourceScope | number = 0,
  ): ResidencyLease | undefined {
    const key = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const entry = this.meshGpuHandles.get(key, namespace);
    return entry === undefined
      ? undefined
      : this.retainMeshEntry(entry, () => {
          if (this.meshGpuHandles.get(key, namespace) === entry)
            this.invalidateMesh(handle, worldId);
          else this.meshLifetime(entry).retire();
        });
  }

  /** Retain the concrete texture allocation across async preparation and GPU submission. */
  retainTextureResidency(
    handle: AssetHandle<'texture'>,
    worldId: RenderResourceScope | number = 0,
  ): ResidencyLease | undefined {
    const key = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const entry = this.textureGpuHandles.get(key, namespace);
    return entry === undefined
      ? undefined
      : this.textureLifetime(entry).retain(() => this.retireTextureEntry(key, entry, namespace));
  }

  /** In-place author changes immediately miss the cache; old submissions keep their allocation. */
  invalidateMesh(handle: number, worldId: RenderResourceScope | number = 0): void {
    const key = handle;
    const namespace = this.worldNamespace(worldId);
    const entry = this.meshGpuHandles.get(key, namespace);
    if (entry !== undefined) this.retireMeshEntry(key, entry, namespace);
  }

  /** A fixed candidate is physically prepared without replacing the currently drawn mesh. */
  prepareMeshResidency(
    handle: AssetHandle<'mesh'>,
    mesh: TypesMeshAsset,
    revision: number,
    scope: RenderResourceScope | number = 0,
    profilePhase?: RecordProfileRunner,
    capture?: (prepared: PreparedMeshResidency) => void,
  ): Result<PreparedMeshResidency, RhiError | AssetError> {
    const key = handle;
    const namespace = this.worldNamespace(scope);
    const candidateKey = `mesh-candidate:${key}:${revision}`;
    const current = this.meshGpuHandles.get(key, namespace);
    let entry =
      current !== undefined && this.meshSourceRevisions.get(current) === revision
        ? current
        : this.meshGpuHandles.get(candidateKey, namespace);
    if (entry === undefined) {
      const projected = runRecordProfilePhase(
        profilePhase,
        'record/validation/residency/project',
        () => deriveRenderDataMesh(mesh),
      );
      if (!projected.ok) return projected;
      const prepared = this.uploadMeshById(
        candidateKey,
        mesh,
        projected.value,
        EMPTY_LOD_MESHES,
        profilePhase,
        namespace,
      );
      if (!prepared.ok) return prepared;
      entry = this.meshGpuHandles.get(candidateKey, namespace);
      if (entry === undefined) throw new Error('prepared mesh has no GPU allocation');
      this.meshSourceRevisions.set(entry, revision);
    }
    const captured = entry;
    const epoch = this.deviceEpoch;
    let released = false;
    const valid = () => {
      const accepted = this.meshGpuHandles.get(key, namespace);
      return (
        !released &&
        this.deviceEpoch === epoch &&
        this.meshChanges.owns(captured.changeToken) &&
        (accepted === undefined ? 0 : (this.meshSourceRevisions.get(accepted) ?? 0)) <= revision &&
        (this.meshGpuHandles.get(candidateKey, namespace) === captured || accepted === captured)
      );
    };
    const retained = this.retainMeshEntry(captured, () => {
      if (this.meshGpuHandles.get(key, namespace) === captured) this.invalidateMesh(handle, scope);
      else this.retireMeshEntry(candidateKey, captured, namespace);
    });
    const prepared: PreparedMeshResidency = {
      entry: captured,
      current: valid,
      commit: () => {
        if (!valid()) return false;
        if (this.meshGpuHandles.get(key, namespace) !== captured) {
          const previous = this.meshGpuHandles.get(key, namespace);
          if (previous !== undefined) this.meshChanges.preflight();
          this.meshGpuHandles.set(key, captured, namespace);
          this.meshGpuHandles.delete(candidateKey, namespace);
          if (previous !== undefined) this.retireMeshEntry(key, previous, namespace);
        }
        return true;
      },
      lease: {
        track: (completed) => retained.track(completed),
        release: (evict) => {
          released = true;
          return retained.release(evict || this.meshGpuHandles.get(key, namespace) !== captured);
        },
      },
    };
    // Transfer exact cleanup ownership before a wrapper can fail to return its result.
    capture?.(prepared);
    return ok(prepared);
  }

  /** Adopt only this asset's explicit ranges; no mesh users participate in invalidation. */
  adoptMeshChange(
    change: AssetChange,
    mesh: TypesMeshAsset | undefined,
    world: RenderResourceScope | number = 0,
  ): Result<void, RhiError> {
    const key = change.handle;
    const namespace = this.worldNamespace(world);
    const entry = this.meshGpuHandles.get(key, namespace);
    if (entry === undefined) return ok(undefined);
    if (!change.removed && this.meshSourceRevisions.get(entry) === change.revision)
      return ok(undefined);
    // Full content/layout edits prepare a new allocation on its next actual use.
    if (
      change.removed ||
      mesh === undefined ||
      change.fields.some(
        (field) =>
          field !== 'aabb' &&
          field !== 'collision' &&
          field !== 'distanceField' &&
          field !== 'cardLayout',
      )
    ) {
      this.retireMeshEntry(key, entry, namespace);
      return ok(undefined);
    }
    const ranges = change.ranges.filter(
      (range) =>
        range.path.length === 1 && (range.path[0] === 'vertices' || range.path[0] === 'indices'),
    );
    if (ranges.length === 0) return ok(undefined);
    const device = this.gpuDevice;
    if (
      device === undefined ||
      this.meshLifetime(entry).owners !== 0 ||
      (entry.lodRanges?.length ?? 0) > 1 ||
      entry.vboBytes !== mesh.vertices.byteLength
    ) {
      this.retireMeshEntry(key, entry, namespace);
      return ok(undefined);
    }
    // Validate every touched physical allocation before writing any of them.
    const writes = [];
    for (const range of ranges) {
      const vertex = range.path[0] === 'vertices';
      const buffer = vertex ? entry.vertexBuffer : entry.indexBuffer;
      const source = vertex ? mesh.vertices : mesh.indices;
      const allocation = buffer == null ? undefined : this.meshBufferOwners.get(buffer);
      if (
        buffer == null ||
        source === undefined ||
        allocation === undefined ||
        allocation.owners !== 1
      ) {
        this.retireMeshEntry(key, entry, namespace);
        return ok(undefined);
      }
      writes.push({ range, buffer, source });
    }
    this.meshChanges.preflight();
    try {
      for (const { range, buffer, source } of writes) {
        this.unshareMeshBuffer(buffer);
        // WebGPU requires four-byte writes, including uint16 indices at an odd offset.
        const first = Math.floor(range.byteOffset / 4) * 4;
        const end = Math.ceil((range.byteOffset + range.byteLength) / 4) * 4;
        const available = new Uint8Array(
          source.buffer,
          source.byteOffset + first,
          Math.min(end, source.byteLength) - first,
        );
        const bytes =
          available.byteLength === end - first ? available : new Uint8Array(end - first);
        if (bytes !== available) bytes.set(available);
        const written = device.queue.writeBuffer(buffer.handle, first, bytes);
        if (!written.ok) {
          this.retireMeshEntry(key, entry, namespace);
          return written;
        }
      }
      // Already submitted work precedes these queue writes. Only unsubmitted leases require COW.
      const token = entry.changeToken;
      if (!this.meshChanges.owns(token)) throw new Error('Mesh range write lost its generation');
      Object.assign(entry, { contentEpoch: this.meshChanges.publish(token) });
      this.meshSourceRevisions.set(entry, change.revision);
      return ok(undefined);
    } catch (cause) {
      this.retireMeshEntry(key, entry, namespace);
      throw cause;
    }
  }

  /** Region evidence keeps narrow uploads independent of the full image width. */
  adoptTextureChange(
    change: AssetChange,
    texture: TextureAsset | undefined,
    world: RenderResourceScope | number = 0,
  ): Result<void, RhiError> {
    const key = change.handle;
    const namespace = this.worldNamespace(world);
    const entry = this.textureGpuHandles.get(key, namespace);
    const adopted =
      !change.removed &&
      entry?.receipt.sourceRevision !== undefined &&
      entry.receipt.sourceRevision >= change.revision;
    this.textureDerivations.remove(key, change.removed ? undefined : change.revision, namespace);
    if (texture?.encoding !== undefined && !change.removed && this.imagePages.has(key, namespace)) {
      this.pendingImageAdoptions.set(key, change, namespace);
      const target = texture.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
      this.prepareTextureData(change.handle, texture, world, target);
      void this.waitTextureData(change.handle, world).then(() => {
        if (this.pendingImageAdoptions.get(key, namespace) !== change) return;
        this.pendingImageAdoptions.delete(key, namespace);
        if (
          typeof world !== 'number' &&
          renderAssetRevision(world, change.handle) !== change.revision
        )
          return;
        const native = this.prepareTextureData(change.handle, texture, world, target);
        if (native.ok)
          this.imagePages.adopt(key, { ...change, fields: ['data'] }, native.value, namespace);
        else this.imagePages.fail(key, native.error, namespace);
      });
    } else {
      this.pendingImageAdoptions.delete(key, namespace);
      this.imagePages.adopt(key, change, texture, namespace);
    }
    // Image pages have their own accepted revision; current raster residency
    // must not hide a source update from that independent CPU projection.
    if (adopted) return ok(undefined);
    this.cancelTextureUpload(key, namespace);
    if (entry === undefined) return ok(undefined);
    if (
      change.removed ||
      texture === undefined ||
      change.fields.length !== 0 ||
      this.textureLifetime(entry).owners !== 0 ||
      this.gpuDevice === undefined
    ) {
      this.retireTextureEntry(key, entry, namespace);
      return ok(undefined);
    }
    const device = this.gpuDevice;
    const layout = deriveTextureLayout(texture);
    if (!layout.ok) {
      this.retireTextureEntry(key, entry, namespace);
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: layout.error.expected,
          hint: layout.error.hint,
        }),
      );
    }
    const block = textureFormatBlock(texture.format);
    for (const range of change.ranges) {
      const level = layout.value.levels.find(
        (level) =>
          range.byteOffset >= level.byteOffset &&
          range.byteOffset + range.byteLength <= level.byteOffset + level.byteLength,
      );
      if (
        range.path.length !== 1 ||
        range.path[0] !== 'data' ||
        level === undefined ||
        range.rowBytes === undefined ||
        range.byteStride !== level.bytesPerRow
      ) {
        this.retireTextureEntry(key, entry, namespace);
        return ok(undefined);
      }
      const local = range.byteOffset - level.byteOffset;
      const image = Math.floor(local / (level.bytesPerRow * level.rowsPerImage));
      const row = Math.floor(
        (local % (level.bytesPerRow * level.rowsPerImage)) / level.bytesPerRow,
      );
      const column = (local % level.bytesPerRow) / block.bytesPerBlock;
      const rows = (range.byteLength - range.rowBytes) / range.byteStride + 1;
      const rowBytes = range.rowBytes;
      const source = texture.data.subarray(range.byteOffset, range.byteOffset + range.byteLength);
      const packed =
        rowBytes === range.byteStride || rows === 1 ? source : new Uint8Array(rowBytes * rows);
      if (packed !== source)
        for (let row = 0; row < rows; row++)
          packed.set(
            source.subarray(row * range.byteStride, row * range.byteStride + rowBytes),
            row * rowBytes,
          );
      const result = device.queue.writeTexture(
        {
          texture: entry.texture.handle,
          mipLevel: level.level,
          origin: { x: column * block.blockWidth, y: row * block.blockHeight, z: image },
        },
        packed,
        { offset: 0, bytesPerRow: rowBytes, rowsPerImage: rows },
        {
          width: (rowBytes / block.bytesPerBlock) * block.blockWidth,
          height: rows * block.blockHeight,
          depthOrArrayLayers: 1,
        },
      );
      if (!result.ok) {
        this.retireTextureEntry(key, entry, namespace);
        return result;
      }
    }
    if (texture.mips.kind === 'generate' && layout.value.levels.length > 1) {
      this.pendingTextureMips.set(entry.texture.handle, {
        format: texture.format,
        width: texture.shape.extent.width,
        height: texture.shape.extent.height,
        arrayLayerCount: layout.value.levels[0]?.imagesPerMip ?? 1,
        levels: layout.value.levels.length,
      });
    }
    Object.assign(entry, {
      receipt: {
        ...entry.receipt,
        generation: ++this.textureGeneration,
        sourceRevision: change.revision,
      },
    });
    return ok(undefined);
  }

  /** Sampler creation stays lazy; invalidate only this logical sampler's device entry. */
  invalidateSampler(handle: number, world: RenderResourceScope | number = 0): void {
    this.samplerGpuHandles.delete(handle, this.worldNamespace(world));
  }

  /** Remove the current mapping immediately; borrowed/submitted allocations drain separately. */
  invalidateTexture(handle: number, worldId: RenderResourceScope | number = 0): void {
    const key = handle;
    const namespace = this.worldNamespace(worldId);
    this.cancelTextureUpload(key, namespace);
    const entry = this.textureGpuHandles.get(key, namespace);
    if (entry !== undefined) this.retireTextureEntry(key, entry, namespace);
  }

  /** Upload source levels only. The graph owner records generated mips, tracks
   * submission, rechecks all source fences, then commits the unique preparation
   * for each scope/handle. Releasing an unpublished candidate cancels it. */
  prepareTextureResidencyForGraph(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    worldId: RenderResourceScope | number = 0,
  ): Result<GraphTextureResidencyPreparation, RhiError | AssetError | ImageError> {
    const device = this.gpuDevice;
    if (device === undefined)
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'a configured device for graph texture residency',
          hint: 'Configure the Renderer residency store before preparing graph textures.',
        }),
      );
    const key = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const existing = this.textureGpuHandles.get(key, namespace);
    let entry = existing;
    let needsMipmaps = false;
    if (entry === undefined) {
      const sourceRevision = this.textureSourceRevision(handle, pod, worldId);
      const native = this.prepareTextureData(Number(handle), pod, worldId);
      if (!native.ok) return native;
      pod = native.value;
      const projected = deriveRenderDataTexture(pod);
      if (!projected.ok) return projected;
      const uploaded = this.prepareTextureUpload(
        handle,
        pod,
        decodedFromTexture(pod),
        projected.value,
      );
      if (!uploaded.ok) return uploaded;
      const raw = uploaded.value.gpuTexture;
      if (raw === undefined) throw new Error('configured graph texture upload lost its device');
      const view = device.createTextureView(raw, {
        label: `texture-view-${key}`,
        dimension: projected.value.shape.viewDimension,
      });
      if (!view.ok) {
        device.destroyTexture(raw);
        return view;
      }
      entry = {
        texture: this.wrapTex(raw),
        view: view.value,
        receipt: this.textureReceipt(pod, projected.value, sourceRevision),
      };
      needsMipmaps =
        !projected.value.compressed && pod.mips.kind === 'generate' && uploaded.value.levels > 1;
    }
    const captured = entry;
    const epoch = this.deviceEpoch;
    let published = existing !== undefined;
    let released = false;
    const retained = this.textureLifetime(captured).retain(() =>
      this.retireTextureEntry(key, captured, namespace),
    );
    const current = () =>
      !released &&
      !captured.texture.isDestroyed &&
      this.deviceEpoch === epoch &&
      this.textureGpuHandles.get(key, namespace) === (published ? captured : undefined);
    return ok({
      entry: captured,
      needsMipmaps,
      current,
      commit: () => {
        if (!current()) return false;
        if (!published) {
          this.cancelTextureUpload(key, namespace);
          this.textureGpuHandles.set(key, captured, namespace);
          published = true;
        }
        return true;
      },
      lease: {
        track: (completed) => retained.track(completed),
        release: (evict) => {
          if (!released && !published) this.retireTextureEntry(key, captured, namespace);
          released = true;
          return retained.release(evict);
        },
      },
    });
  }

  /**
   * Pull-model residency: build the GPU resource for `handle` from the
   * caller-provided POD on a miss, return the cached handles on a hit (D-2).
   *
   * - mesh POD -> synchronous vertex / index buffer upload (mirrors the
   *   pre-extraction `uploadMeshById`).
   * - texture POD -> synchronous texture upload + mipmap blit (D-9). The
   *   mipmap pipeline MUST have been prewarmed via `prewarmMipmapPipeline`;
   *   an un-prewarmed format returns a structured RhiError (never awaits).
   *
   * Cubemap is NOT routed here -- it is an eager user call
   * (`_uploadCubemapFromEquirect`). Builtin meshes are NOT routed here either
   * (createRenderer step-3 owns them; D-1).
   */
  ensureResident(
    handle: AssetHandle<'mesh'>,
    pod: TypesMeshAsset,
    worldId?: RenderResourceScope | number,
    lodMeshes?: readonly (TypesMeshAsset | undefined)[],
    profilePhase?: RecordProfileRunner,
  ): Result<MeshGpuHandles, RhiError | AssetError | ImageError>;
  ensureResident(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    worldId?: RenderResourceScope | number,
  ): Result<TextureGpuEntry, RhiError | AssetError | ImageError>;
  ensureResident(
    handle: AssetHandle<'mesh'> | AssetHandle<'texture'>,
    pod: TypesMeshAsset | TextureAsset,
    worldId: RenderResourceScope | number = 0,
    lodMeshes: readonly (TypesMeshAsset | undefined)[] = EMPTY_LOD_MESHES,
    profilePhase?: RecordProfileRunner,
  ): Result<TextureGpuEntry | MeshGpuHandles, RhiError | AssetError | ImageError> {
    const id = Number(handle);
    // Hit: O(1) cache lookup, never re-projects (AC-09 -- deriveRenderData*
    // runs only on a miss). The miss arms below dispatch on `pod.kind` with NO
    // default: only the two GPU-resource kinds reachable here (mesh / texture)
    // have arms, so a third reachable kind would surface as a `tsc -b`
    // exhaustiveness error at the switch rather than a silent fallthrough
    // (AC-06; the cube-texture kind is the eager `_uploadCubemapFromEquirect`
    // path, not routed here).
    switch (pod.kind) {
      case 'mesh': {
        // Recycled shared slots can coexist with an older GPU submission.
        // The generation is part of mesh residency identity, not only its slot.
        const key = Number(handle);
        const namespace = this.worldNamespace(worldId);
        const existing = this.meshGpuHandles.get(key, namespace);
        if (existing !== undefined) {
          // A root mesh can become resident before its lower-detail assets are
          // available. Publish each supplied level and retain previously
          // resident levels when another caller has no payload for them yet.
          if (lodMeshes.length === 0) return this.meshLifetime(existing).result;
          const previousLodAssets = this.meshLodAssets.get(existing);
          lodMeshes = lodMeshes.map((asset, index) => asset ?? previousLodAssets?.[index]);
          const sameLodChain =
            previousLodAssets !== undefined &&
            previousLodAssets.length === lodMeshes.length &&
            previousLodAssets.every((asset, index) => asset === lodMeshes[index]);
          if (sameLodChain) return this.meshLifetime(existing).result;

          const projected = runRecordProfilePhase(
            profilePhase,
            'record/validation/residency/project',
            () => deriveRenderDataMesh(pod),
          );
          if (!projected.ok) return projected;
          const upgraded = this.uploadMeshById(
            key,
            pod,
            projected.value,
            lodMeshes,
            profilePhase,
            namespace,
          );
          if (!upgraded.ok) return upgraded;
          // uploadMeshById publishes the new entry before this call so the
          // old allocation stays available to any already-recorded frame.
          this.retireMeshEntry(key, existing, namespace);
          return upgraded;
        }
        const projected = runRecordProfilePhase(
          profilePhase,
          'record/validation/residency/project',
          () => deriveRenderDataMesh(pod),
        );
        if (!projected.ok) return projected;
        return this.uploadMeshById(key, pod, projected.value, lodMeshes, profilePhase, namespace);
      }
      case 'texture': {
        const texKey = id;
        const namespace = this.worldNamespace(worldId);
        const existing = this.textureGpuHandles.get(texKey, namespace);
        if (existing !== undefined) return this.textureLifetime(existing).result;
        const sourceRevision = this.textureSourceRevision(handle, pod, worldId);
        const native = this.prepareTextureData(Number(handle), pod, worldId);
        if (!native.ok) return native;
        const texture = native.value;
        const projected = deriveRenderDataTexture(texture);
        if (!projected.ok) return projected;
        const decoded: DecodedImage = decodedFromTexture(texture);
        return this.uploadTextureSync(
          handle as AssetHandle<'texture'>,
          texture,
          decoded,
          projected.value,
          worldId,
          sourceRevision,
        );
      }
    }
  }

  /**
   * Prepare one candidate-visible resource without the normal draw-time mip
   * submission. Base writes and resource creation stay owned by this cache;
   * generated mip passes are returned to the recovery transaction for one
   * explicit finish/submit before publication.
   */
  prepareResidentForRecovery(
    handle: AssetHandle<'mesh'>,
    pod: TypesMeshAsset,
    worldId?: RenderResourceScope | number,
  ): Result<RecoveryResidencyPreparation, RhiError | AssetError | ImageError>;
  prepareResidentForRecovery(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    worldId?: RenderResourceScope | number,
  ): Result<RecoveryResidencyPreparation, RhiError | AssetError | ImageError>;
  prepareResidentForRecovery(
    handle: AssetHandle<'mesh'> | AssetHandle<'texture'>,
    pod: TypesMeshAsset | TextureAsset,
    worldId: RenderResourceScope | number = 0,
  ): Result<RecoveryResidencyPreparation, RhiError | AssetError | ImageError> {
    const id = Number(handle);
    if (pod.kind === 'mesh') {
      const key = Number(handle);
      const namespace = this.worldNamespace(worldId);
      if (this.meshGpuHandles.has(key, namespace)) return ok({});
      const projected = deriveRenderDataMesh(pod);
      if (!projected.ok) return projected;
      const uploaded = this.uploadMeshById(
        key,
        pod,
        projected.value,
        EMPTY_LOD_MESHES,
        undefined,
        namespace,
      );
      return uploaded.ok ? ok({}) : uploaded;
    }

    const cacheKey = id;
    const namespace = this.worldNamespace(worldId);
    if (this.textureGpuHandles.has(cacheKey, namespace)) return ok({});
    const sourceRevision = this.textureSourceRevision(handle, pod, worldId);
    const native = this.prepareTextureData(Number(handle), pod, worldId);
    if (!native.ok) return native;
    pod = native.value;
    const projected = deriveRenderDataTexture(pod);
    if (!projected.ok) return projected;
    const decoded = decodedFromTexture(pod);
    const prepared = this.prepareTextureUpload(
      handle as AssetHandle<'texture'>,
      pod,
      decoded,
      projected.value,
    );
    if (!prepared.ok) return prepared;
    const device = this.gpuDevice;
    const gpuTexture = prepared.value.gpuTexture;
    if (device === undefined || gpuTexture === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResidencyCache.configureGpuDevice wired before recovery residency',
          hint: 'configure the candidate store before preparing recovery resources',
        }),
      );
    }

    let mipmapWork: MipmapEncoderWork | undefined;
    if (!projected.value.compressed && pod.mips.kind === 'generate' && prepared.value.levels > 1) {
      const preparedMipmaps = prepareMipmaps(device, gpuTexture, {
        format: projected.value.format,
        width: pod.shape.extent.width,
        height: pod.shape.extent.height,
        arrayLayerCount: projected.value.depthOrArrayLayers,
        levels: prepared.value.levels,
      });
      if (!preparedMipmaps.ok) {
        new GpuTexture(device, gpuTexture).destroy();
        return preparedMipmaps;
      }
      mipmapWork = preparedMipmaps.value;
    }
    const viewRes = device.createTextureView(gpuTexture, {
      label: `texture-view-${cacheKey}`,
      dimension: projected.value.shape.viewDimension,
    });
    if (!viewRes.ok) {
      mipmapWork?.discard();
      new GpuTexture(device, gpuTexture).destroy();
      return viewRes;
    }
    const previous = this.textureGpuHandles.get(cacheKey, namespace);
    const entry: TextureGpuEntry = {
      texture: this.wrapTex(gpuTexture),
      view: viewRes.value,
      receipt: this.textureReceipt(pod, projected.value, sourceRevision),
    };
    this.cancelTextureUpload(cacheKey, namespace);
    this.textureGpuHandles.set(cacheKey, entry, namespace);
    if (previous !== undefined && previous.texture !== entry.texture)
      this.retireTextureEntry(cacheKey, previous, namespace);
    return ok(mipmapWork === undefined ? {} : { mipmapWork });
  }

  /**
   * Upload one complete TextureAsset and cache its GPU texture and view.
   * Pixel bytes, shape and color space are derived from that same source.
   * Async preparation permits codecs and mipmap pipeline construction.
   */
  async uploadTexture(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    worldId: RenderResourceScope | number = 0,
  ): Promise<Result<void, AssetError | ImageError | RhiError>> {
    const device = this.gpuDevice;
    if (device === undefined)
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'a configured texture upload device',
          hint: 'configure the Renderer before preparing textures',
        }),
      );
    const sourceRevision = this.textureSourceRevision(handle, pod, worldId);
    let native = this.prepareTextureData(Number(handle), pod, worldId);
    if (!native.ok && native.error.code === 'asset-not-ready') {
      await this.waitTextureData(Number(handle), worldId);
      native = this.prepareTextureData(Number(handle), pod, worldId);
    }
    if (!native.ok) return native;
    pod = native.value;
    const decoded = decodedFromTexture(pod);
    const projected = deriveRenderDataTexture(pod);
    if (!projected.ok) return projected;
    const prepared = this.prepareTextureUpload(handle, pod, decoded, projected.value);
    if (!prepared.ok) return prepared;
    const { levels, gpuTexture } = prepared.value;
    if (gpuTexture === undefined) throw new Error('configured texture upload lost its device');
    const cacheKey = Number(handle);
    const namespace = this.worldNamespace(worldId);
    const receipt = this.textureReceipt(pod, projected.value, sourceRevision);
    const mipmaps =
      !projected.value.compressed && pod.mips.kind === 'generate' && levels > 1
        ? {
            format: projected.value.format,
            width: pod.shape.extent.width,
            height: pod.shape.extent.height,
            arrayLayerCount: projected.value.depthOrArrayLayers,
            levels,
          }
        : undefined;
    let disposed = false;
    const token = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        device.destroyTexture(gpuTexture);
      },
    };
    this.cancelTextureUpload(cacheKey, namespace);
    this.textureUploads.set(cacheKey, token, namespace);
    const current = () =>
      this.gpuDevice === device &&
      receipt.deviceEpoch === this.deviceEpoch &&
      this.textureUploads.get(cacheKey, namespace) === token;
    let published = false;
    try {
      if (mipmaps !== undefined) {
        const factory = this.asyncCreateShaderModule;
        if (factory === undefined)
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'a mipmap shader-module factory',
              hint: 'configure the Renderer mipmap factory before preparing generated mips',
            }),
          );
        const pipeline = await getOrCreateMipmapPipeline(device, mipmaps.format, factory);
        if (current() && !pipeline.ok)
          return err(
            pipeline.error instanceof RhiError
              ? pipeline.error
              : new RhiError({
                  code: 'rhi-not-available',
                  expected: `mipmap pipeline for ${mipmaps.format} builds`,
                  hint: 'repair the reported shader pipeline failure before retrying texture preparation',
                }),
          );
      }
      if (!current())
        return err(
          new AssetError({
            code: 'asset-invalidated',
            expected: 'the same texture preparation and device remain current',
            hint: 'discard this superseded upload and use the current asset revision',
          }),
        );
      const view = device.createTextureView(gpuTexture, {
        label: `texture-view-${cacheKey}`,
        dimension: projected.value.shape.viewDimension,
      });
      if (!view.ok) return view;
      const previous = this.textureGpuHandles.get(cacheKey, namespace);
      const next: TextureGpuEntry = {
        texture: this.wrapTex(gpuTexture),
        view: view.value,
        receipt,
      };
      if (mipmaps !== undefined) this.pendingTextureMips.set(gpuTexture, mipmaps);
      this.textureGpuHandles.set(cacheKey, next, namespace);
      published = true;
      if (previous !== undefined) this.retireTextureEntry(cacheKey, previous, namespace);
      return ok(undefined);
    } finally {
      if (this.textureUploads.get(cacheKey, namespace) === token)
        this.textureUploads.delete(cacheKey, namespace);
      if (!published) token.dispose();
    }
  }

  /**
   * Synchronous texture upload used by `ensureResident` (D-9). Identical to
   * `uploadTexture` except the mipmap pipeline is read from the prewarmed
   * cache when the Renderer records pending mip work -- an un-prewarmed format
   * returns a structured RhiError instead of awaiting a build.
   */
  private uploadTextureSync(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    decoded: DecodedImage,
    renderData: TextureRenderData,
    worldId: RenderResourceScope | number = 0,
    sourceRevision?: number,
  ): Result<TextureGpuEntry, AssetError | ImageError | RhiError> {
    const device = this.gpuDevice;
    const prepared = this.prepareTextureUpload(handle, pod, decoded, renderData);
    if (!prepared.ok) return prepared;
    if (device === undefined || prepared.value.gpuTexture === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResidencyCache.configureGpuDevice wired before ensureResident',
          hint: 'a texture ensureResident ran before the GPU device was wired; call gpuStore.configureGpuDevice in createRenderer',
        }),
      );
    }
    const { tex, levels, gpuTexture } = prepared.value;
    const cacheKey = Number(handle);
    const namespace = this.worldNamespace(worldId);

    if (!renderData.compressed && tex.mips.kind === 'generate' && levels > 1) {
      this.pendingTextureMips.set(gpuTexture, {
        format: tex.format,
        width: tex.shape.extent.width,
        height: tex.shape.extent.height,
        arrayLayerCount: renderData.depthOrArrayLayers,
        levels,
      });
    }

    const viewRes = device.createTextureView(gpuTexture, {
      label: `texture-view-${cacheKey}`,
      dimension: renderData.shape.viewDimension,
    });
    if (!viewRes.ok) {
      this.pendingTextureMips.delete(gpuTexture);
      device.destroyTexture(gpuTexture);
      return viewRes;
    }
    const entry: TextureGpuEntry = {
      texture: this.wrapTex(gpuTexture),
      view: viewRes.value,
      receipt: this.textureReceipt(pod, renderData, sourceRevision),
    };
    const previous = this.textureGpuHandles.get(cacheKey, namespace);
    this.cancelTextureUpload(cacheKey, namespace);
    this.textureGpuHandles.set(cacheKey, entry, namespace);
    if (previous !== undefined && previous.texture !== entry.texture)
      this.retireTextureEntry(cacheKey, previous, namespace);
    return this.textureLifetime(entry).result;
  }

  private textureSourceRevision(
    handle: number,
    source: TextureAsset,
    scope: RenderResourceScope | number,
  ): number | undefined {
    if (typeof scope === 'number') return undefined;
    const current = scope.resolveAsset<TextureAsset>(handle);
    return current.ok && current.value === source ? renderAssetRevision(scope, handle) : undefined;
  }

  private textureReceipt(
    pod: TextureAsset,
    renderData: TextureRenderData,
    sourceRevision?: number,
  ): TextureResidencyReceipt {
    return {
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      shape: structuredClone(pod.shape),
      format: renderData.format,
      mipLevelCount: renderData.mipLevelCount,
      extent: {
        width: renderData.physicalExtent.width,
        height: renderData.physicalExtent.height,
        depthOrArrayLayers: renderData.depthOrArrayLayers,
      },
      bytes: pod.data.byteLength,
      view: renderData.shape.viewDimension,
      generation: ++this.textureGeneration,
      deviceEpoch: this.deviceEpoch,
    };
  }

  /**
   * Shared texture-upload prelude: format / colorSpace consistency assertion,
   * GPU texture allocation + writeTexture. Returns `gpuTexture: undefined`
   * (with ok) when no device is wired (deferred path).
   */
  private prepareTextureUpload(
    handle: AssetHandle<'texture'>,
    pod: TextureAsset,
    decoded: DecodedImage,
    renderData: TextureRenderData,
  ): Result<
    { id: number; tex: TextureAsset; levels: number; gpuTexture: Texture | undefined },
    AssetError | ImageError | RhiError
  > {
    const id = Number(handle);
    // The store does not hold the registry (D-2); the caller-provided POD is
    // the GPU-format SSOT and `renderData` is its projection (format / usage /
    // mipLevelCount). `decoded` supplies the pixel bytes + colorSpace; the
    // assertion below guards the actual upload-source colorSpace against the
    // projected format (the projection already checked the POD's own colorSpace).
    const tex = pod;
    const levels = renderData.mipLevelCount;

    const formatExpected: 'srgb' | 'linear' = renderData.format.endsWith('-srgb')
      ? 'srgb'
      : 'linear';
    if (decoded.colorSpace !== formatExpected) {
      const detail: ImageErrorDetailFor<'image-format-unsupported'> = {
        code: 'image-format-unsupported',
        actualMime: decoded.mime,
        formatColorSpaceConflict: {
          format: renderData.format,
          colorSpace: decoded.colorSpace,
          expected: formatExpected,
        },
      };
      return err(
        imageError(detail, "format ends in '-srgb' iff colorSpace is 'srgb' (linear otherwise)"),
      );
    }

    const device = this.gpuDevice;
    if (device === undefined) {
      return ok({ id, tex, levels, gpuTexture: undefined });
    }

    // WebGL2/wgpu exposes texture limits that are lower than many source
    // images (for example the 2085px LearnOpenGL Mars texture). Reject the
    // upload before allocating a handle; binding a texture that the backend
    // accepted syntactically but cannot use later surfaces only as a generic
    // invalid-bind-group submit error.
    const maxDimension =
      tex.shape.viewDimension === '3d'
        ? device.limits.maxTextureDimension3D
        : device.limits.maxTextureDimension2D;
    const width = tex.shape.extent.width;
    const height = tex.shape.extent.height;
    const layers = renderData.depthOrArrayLayers;
    const exceedsLayerLimit =
      tex.shape.viewDimension === '2d-array' && layers > device.limits.maxTextureArrayLayers;
    if (width > maxDimension || height > maxDimension || exceedsLayerLimit) {
      return err(
        imageError({
          code: 'image-dimension-out-of-bounds',
          requested: { width, height },
          limit: exceedsLayerLimit ? device.limits.maxTextureArrayLayers : maxDimension,
        }),
      );
    }

    const createTexRes = device.createTexture({
      label: `texture-${id}`,
      size: {
        width: renderData.physicalExtent.width,
        height: renderData.physicalExtent.height,
        depthOrArrayLayers: renderData.depthOrArrayLayers,
      },
      mipLevelCount: levels,
      sampleCount: 1,
      dimension: tex.shape.viewDimension === '3d' ? '3d' : '2d',
      format: renderData.format,
      usage: renderData.usage,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!createTexRes.ok) return createTexRes;
    const gpuTexture = createTexRes.value;
    let uploaded = false;
    try {
      const queue = device.queue;

      if (renderData.compressed || tex.mips.kind === 'packed') {
        // feat-20260707 M5 / w36 (AC-08): block-compressed textures carry their
        // mip chain in `data` (offline-baked -- the GPU cannot generate compressed
        // mips). Upload each level with its own block-padded bytesPerRow /
        // rowsPerImage and mip-major byte offset (deriveTextureLayout, SSOT
        // block math). Full-subresource copies retain their logical size, including
        // non-block-aligned dimensions. queue.writeTexture avoids the 256 B
        // copyBufferToTexture alignment trap.
        const written = writePackedTextureLevels(
          device,
          gpuTexture,
          tex,
          renderData.format,
          decoded.bytes,
        );
        if (!written.ok) return written;
        uploaded = true;
        return ok({ id, tex, levels, gpuTexture });
      }

      // Uncompressed base-mip write; higher mips (when mipmap) are GPU-generated by
      // the caller's blit pass. rowsPerImage is the pixel height for linear RGBA.
      const textureLayout = deriveTextureLayout({
        shape: tex.shape,
        format: renderData.format,
        mips: tex.mips,
      });
      if (!textureLayout.ok) {
        return err(
          new AssetError({
            code: 'invalid-source-format',
            expected: textureLayout.error.expected,
            hint: textureLayout.error.hint,
          }),
        );
      }
      const baseLevel = textureLayout.value.levels[0];
      if (baseLevel === undefined) {
        return err(
          new AssetError({
            code: 'invalid-source-format',
            expected: 'texture layout contains a base mip level',
            hint: ASSET_ERROR_HINTS['invalid-source-format'],
          }),
        );
      }
      const bytesPerRow = baseLevel.bytesPerRow;
      const writeTextureRes = queue.writeTexture(
        { texture: gpuTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        decoded.bytes,
        { offset: 0, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: renderData.depthOrArrayLayers },
      );
      if (!writeTextureRes.ok) return writeTextureRes;

      uploaded = true;
      return ok({ id, tex, levels, gpuTexture });
    } finally {
      if (!uploaded) device.destroyTexture(gpuTexture);
    }
  }

  /**
   * Project an equirectangular HDR `EquirectAsset` into a GPU cubemap + IBL
   * precompute. NOT part of the `ensureResident` pull path.
   *
   * @internal — feat-20260630 D-3 / F-9: the cubemap projection is engine
   * internals, not a user surface. AI users declare `Skylight{equirect}` and
   * the render-system record arm (same package) drives this method per-frame;
   * the `_` prefix + `@internal` mark it package-internal (lint:internal gate)
   * so it never appears as a user-facing call. (A cross-file `private` is not
   * reachable by the record arm; package-internal is the correct visibility.)
   *
   * Idempotent: a second call with the same source handle returns the cached
   * cubemap allocation (no second GPU texture). Projection retains the source
   * asset identity; derived device resources do not create runtime assets.
   *
   * Status (D-3): every entry written carries `status`. A failed projection
   * records `status:'failed'` EXPLICITLY (R-2 / AC-09) so the caller never
   * retries by inferring "no entry => try again".
   */
  async _uploadCubemapFromEquirect(
    world: RenderResourceScope,
    sourceHandle: AssetHandle<'equirect'>,
    sourcePod: EquirectAsset,
  ): Promise<Result<AssetHandle<'equirect'>, AssetError | RhiError>> {
    const sourceId = Number(sourceHandle);
    const namespace = this.worldNamespace(world);

    const existing = this.cubemapIdempotentMap.get(sourceId, namespace);
    if (existing !== undefined) {
      return ok(existing);
    }

    // R-2 / AC-09: a previously-failed projection is recorded EXPLICITLY as a
    // 'failed' entry. Short-circuit here so the record arm never retries the
    // upload every frame (the missing-key inference would loop forever).
    if (this.cubemapGpuHandles.get(sourceId, namespace)?.status === 'failed') {
      return err(
        new RhiError({
          code: 'feature-not-enabled',
          expected: 'a prior cubemap projection for this equirect source did not fail',
          hint: 'this equirect source already failed projection; the record arm must not retry (R-2). Inspect the original failure on the error channel',
        }),
      );
    }

    // feat-20260630 M3 / w18: a projection already in flight is marked
    // 'pending' synchronously below (before the first await). A re-entry while
    // pending short-circuits so the fire-and-forget record arm launches the
    // async projection exactly once per source (D-4 idempotent; the record arm
    // calls this every frame until status flips to ready/failed). The pending
    // entry holds no live GPU resources yet; the record arm binds the white
    // fallback while pending.
    if (this.cubemapGpuHandles.get(sourceId, namespace)?.status === 'pending') {
      return ok(sourceHandle);
    }

    const revision = renderAssetRevision(world, sourceHandle);
    const epoch = this.deviceEpoch;
    const entry: CubemapGpuEntry = {
      revision,
      status: 'pending',
      texture: null,
      view: undefined,
      faceViews: [],
    };
    this.cubemapGpuHandles.set(sourceId, entry, namespace);
    const current = () =>
      this.cubemapGpuHandles.get(sourceId, namespace) === entry &&
      this.deviceEpoch === epoch &&
      renderAssetRevision(world, sourceHandle) === revision &&
      (entry.scope?.isAlive() ?? true);
    const superseded = () => {
      if (this.cubemapGpuHandles.get(sourceId, namespace) === entry) {
        this.cubemapGpuHandles.delete(sourceId, namespace);
        this.cubemapIdempotentMap.delete(sourceId, namespace);
      }
      this.retireCubemap(entry);
      return ok(sourceHandle);
    };
    const recordFailed = <E extends AssetError | RhiError>(
      error: E,
    ): Result<AssetHandle<'equirect'>, E> => {
      if (!current()) return superseded();
      this.retireCubemap(entry);
      this.cubemapGpuHandles.set(
        sourceId,
        {
          revision,
          status: 'failed',
          texture: null,
          view: undefined,
          faceViews: [],
          failure: error,
        },
        namespace,
      );
      return err(error);
    };

    if (sourcePod.kind !== 'equirect') {
      return recordFailed(
        new AssetError({
          code: 'asset-not-found',
          expected: `source POD for handle id ${sourceId} is an EquirectAsset`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }

    // The cubemap projection + IBL precompute consume a 2D-image view of the
    // source. EquirectAsset mirrors the TextureAsset 2D surface (width / height
    // / format / data / colorSpace) but has no CPU mip chain, so the derived
    // texture view declares `mipmap:false` (the IBL prefilter mip chain is a
    // GPU-side pass, not a CPU-authored level set).
    const sourceData =
      sourcePod.data instanceof Uint8ClampedArray
        ? new Uint8Array(
            sourcePod.data.buffer,
            sourcePod.data.byteOffset,
            sourcePod.data.byteLength,
          )
        : sourcePod.data;
    const sourceTex: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: sourcePod.width, height: sourcePod.height } },
      format: sourcePod.format,
      data: sourceData,
      colorSpace: sourcePod.colorSpace,
      mips: { kind: 'none' },
    };

    // Project the equirect source POD into the cubemap descriptor (D-5): the
    // asset-semantic decisions (format / colorSpace validation, square cube
    // face size, rgba32f->rgba16f narrowing) live in the pure projection; the
    // resource build (texture / views / IBL precompute) + the byte conversion
    // stay here in the store.
    const projected: CubeRenderData | undefined = (() => {
      const p = deriveRenderDataCubemap(sourceTex);
      return p.ok ? p.value : undefined;
    })();
    if (projected === undefined) {
      return recordFailed(
        new AssetError({
          code: 'invalid-source-format',
          expected: "format 'rgba16float' or 'rgba32float' with colorSpace 'linear'",
          hint: ASSET_ERROR_HINTS['invalid-source-format'],
        }),
      );
    }

    const tex: TextureAsset = projected.needsHalfConversion
      ? {
          kind: 'texture',
          shape: sourceTex.shape,
          format: projected.outputFormat,
          data: halfFloat.f32ToF16Bytes(sourceTex.data),
          colorSpace: 'linear',
          mips: { kind: 'none' },
        }
      : sourceTex;

    const cubeFaceSize = projected.cubeFaceSize;
    // The source equirect stays float for filtering, but WebGL2 cannot render
    // rgba16float attachments. Downlevel only the precompute outputs to the
    // universally renderable rgba8 path; the same format is threaded through
    // the cubemap and all three IBL side textures by IblPipelineCache.
    const outputFormat = this.caps?.rgba16floatRenderable === false ? 'rgba8unorm' : tex.format;
    const sourceMipLevelCount = 1;

    // Lazy projection runs from the record arm, where the RHI device is always
    // wired (research R-5). The IBL path is deliberately independent from the
    // ordinary mipmap fixture seam: it accepts only the opaque RhiDevice and
    // its Result-returning shader factory, never a raw GPUDevice or unwrap
    // fallback.
    const device = this.iblDevice;
    const shaderModuleFactory = this.iblShaderModuleFactory;
    const pipelineScope = this.deviceScope;
    if (
      device === undefined ||
      shaderModuleFactory === undefined ||
      pipelineScope === undefined ||
      !pipelineScope.isAlive()
    ) {
      return recordFailed(
        new RhiError({
          code: 'rhi-not-available',
          expected:
            'GpuResidencyCache is configured with an RhiDevice, shader factory, and DeviceScope',
          hint: 'bind the renderer DeviceScope before a cubemap projection; raw GPU fallback is not supported',
        }),
      );
    }

    const scope = pipelineScope.createChild(`equirect-${sourceId}-${revision ?? 0}`);
    entry.scope = scope;

    // Usage flags for the small equirect helper texture (sampled source for the
    // IBL precompute pass); the cube texture's usage comes from the projection.
    const gpuTextureResult = device.createTexture({
      label: `cubemap-${sourceId}`,
      size: { width: cubeFaceSize, height: cubeFaceSize, depthOrArrayLayers: 6 },
      mipLevelCount: sourceMipLevelCount,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage: projected.cubeUsage,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!gpuTextureResult.ok) return recordFailed(gpuTextureResult.error);
    const gpuTexture = gpuTextureResult.value;
    const gpuTextureWrapper = new GpuTexture(device, gpuTexture, scope);

    const cubeViewResult = device.createTextureView(gpuTexture, {
      label: `cubemap-view-${sourceId}`,
      dimension: 'cube',
      arrayLayerCount: 6,
    });
    if (!cubeViewResult.ok) return recordFailed(cubeViewResult.error);
    const cubeView = cubeViewResult.value;

    const faceViews: TextureView[] = [];
    for (let face = 0; face < 6; face++) {
      const faceViewResult = device.createTextureView(gpuTexture, {
        label: `cubemap-face-${sourceId}-${face}`,
        dimension: '2d',
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });
      if (!faceViewResult.ok) return recordFailed(faceViewResult.error);
      faceViews.push(faceViewResult.value);
    }

    const equirectTextureResult = device.createTexture({
      label: `equirect-${sourceId}`,
      size: {
        width: tex.shape.extent.width,
        height: tex.shape.extent.height,
        depthOrArrayLayers: 1,
      },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: tex.format,
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!equirectTextureResult.ok) return recordFailed(equirectTextureResult.error);
    const equirectGpuTex = equirectTextureResult.value;
    scope._adopt('texture', equirectGpuTex, (texture) => {
      device.destroyTexture(texture);
    });

    const equirectViewResult = device.createTextureView(equirectGpuTex, {
      label: `equirect-view-${sourceId}`,
      dimension: '2d',
    });
    if (!equirectViewResult.ok) return recordFailed(equirectViewResult.error);
    const equirectView = equirectViewResult.value;

    const bytesPerPixel = textureFormatBlock(tex.format).bytesPerBlock;
    const equirectWriteResult = device.queue.writeTexture(
      { texture: equirectGpuTex },
      tex.data,
      {
        bytesPerRow: tex.shape.extent.width * bytesPerPixel,
        rowsPerImage: tex.shape.extent.height,
      },
      {
        width: tex.shape.extent.width,
        height: tex.shape.extent.height,
        depthOrArrayLayers: 1,
      },
    );
    if (!equirectWriteResult.ok) return recordFailed(equirectWriteResult.error);

    const faceBufferResult = createFaceUniformsBuffer(device);
    if (!faceBufferResult.ok) return recordFailed(faceBufferResult.error);
    const faceBuf = faceBufferResult.value;
    scope._adopt('buffer', faceBuf, (buffer) => {
      device.destroyBuffer(buffer);
    });
    const prefilterBufferResult = createPrefilterUniformsBuffer(device);
    if (!prefilterBufferResult.ok) return recordFailed(prefilterBufferResult.error);
    const prefBuf = prefilterBufferResult.value;
    scope._adopt('buffer', prefBuf, (buffer) => {
      device.destroyBuffer(buffer);
    });

    const cubeVertexResult = device.createBuffer({
      label: 'ibl-cube-verts',
      size: CUBEMAP_FACE_VERTICES.byteLength,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!cubeVertexResult.ok) return recordFailed(cubeVertexResult.error);
    const cubeVertex = cubeVertexResult.value;
    scope._adopt('buffer', cubeVertex, (buffer) => {
      device.destroyBuffer(buffer);
    });

    const cubeVertexWriteResult = device.queue.writeBuffer(cubeVertex, 0, CUBEMAP_FACE_VERTICES);
    if (!cubeVertexWriteResult.ok) return recordFailed(cubeVertexWriteResult.error);
    const faceUniformsResult = writeAllFaceUniforms(device, faceBuf);
    if (!faceUniformsResult.ok) return recordFailed(faceUniformsResult.error);
    const prefilterUniformsResult = writeAllPrefilterUniforms(device, prefBuf);
    if (!prefilterUniformsResult.ok) return recordFailed(prefilterUniformsResult.error);

    const pipelinesResult = await createIblPipelines(
      pipelineScope,
      device,
      shaderModuleFactory,
      outputFormat,
    );
    if (!pipelinesResult.ok) {
      return recordFailed(
        new AssetError({
          code: 'ibl-precompute-not-dispatched',
          expected: pipelinesResult.error.expected,
          hint: pipelinesResult.error.hint,
        }),
      );
    }

    if (!current()) return superseded();

    const runResult = await runIblPrecompute({
      scope,
      pipelineScope,
      device,
      equirectView,
      cubeView,
      cubeFaceViews: faceViews,
      faceUniformsBuffer: faceBuf,
      prefilterUniformsBuffer: prefBuf,
      cubeVertexBuffer: cubeVertex,
    });
    if (!current()) return superseded();
    if (!runResult.ok) {
      return recordFailed(
        new AssetError({
          code: 'ibl-precompute-not-dispatched',
          expected: runResult.error.expected,
          hint: runResult.error.hint,
        }),
      );
    }

    // Publish the source's cube and IBL together after their queue fence.
    // Derived device resources never register a second runtime asset.
    this.cubemapGpuHandles.set(
      sourceId,
      {
        revision,
        scope,
        status: 'ready',
        ibl: runResult.value,
        texture: gpuTextureWrapper,
        view: cubeView,
        faceViews,
      },
      namespace,
    );
    const cubeHandle = sourceHandle;
    this.cubemapIdempotentMap.set(sourceId, cubeHandle, namespace);

    return ok(cubeHandle);
  }

  /**
   * Upload `MeshAsset.vertices` + `MeshAsset.indices` to GPU buffers and cache
   * the handles under the asset id. Synchronous; mirrors the pre-extraction
   * `uploadMeshById` byte-for-byte. Returns the cached entry on success.
   */
  private uploadMeshById(
    id: string | number,
    mesh: TypesMeshAsset,
    renderData: MeshRenderData,
    lodMeshes: readonly (TypesMeshAsset | undefined)[] = EMPTY_LOD_MESHES,
    profilePhase: RecordProfileRunner | undefined = undefined,
    namespace: GpuResourceNamespace = 0,
  ): Result<MeshGpuHandles, RhiError> {
    const device = this.gpuDevice;
    if (device === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResidencyCache.configureGpuDevice wired before mesh ensureResident',
          hint: 'a mesh ensureResident ran before the GPU device was wired; call gpuStore.configureGpuDevice in createRenderer',
        }),
      );
    }

    const vertexCount = deriveVertexCount(mesh.vertices, renderData.layoutProjection);
    if (vertexCount === undefined) {
      return err(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'MeshAsset.vertices byteLength to be divisible by its layout projection stride',
          hint: 'reimport the mesh so the interleaved vertex bytes match attributes',
        }),
      );
    }
    const packed = runRecordProfilePhase(profilePhase, 'record/validation/residency/pack', () =>
      packMeshLodGeometry(mesh, renderData, lodMeshes),
    );
    if (!packed.ok) return packed;
    const { vertices, indices, lodRanges } = packed.value;
    this.meshChanges.preflight();
    const indexBytesUnpadded = indices === undefined ? 0 : indices.byteLength;
    const indexBytes = ((indexBytesUnpadded + 3) >> 2) << 2;
    const vertexWords = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);

    const vertexKey = runRecordProfilePhase(
      profilePhase,
      'record/validation/residency/vertex-key',
      () => this.meshBufferKey(vertexWords, renderData.vertexUsage),
    );
    const shared = runRecordProfilePhase(
      profilePhase,
      'record/validation/residency/vertex-equality',
      () => this.sharedMeshBuffer(vertexKey, vertexWords),
    );
    const indexWords =
      indices === undefined
        ? undefined
        : runRecordProfilePhase(profilePhase, 'record/validation/residency/index-pack', () => {
            const words = new Uint32Array(indexBytes / 4);
            new Uint8Array(words.buffer).set(
              new Uint8Array(indices.buffer, indices.byteOffset, indexBytesUnpadded),
            );
            return words;
          });
    const indexKey =
      indexWords === undefined || indices === undefined
        ? undefined
        : runRecordProfilePhase(
            profilePhase,
            'record/validation/residency/index-key',
            () =>
              // Recorders retain one index format per physical index buffer.
              `${indices instanceof Uint32Array ? 4 : 2}:${this.meshBufferKey(indexWords, renderData.indexUsage)}`,
          );
    const sharedIndex =
      indexWords === undefined || indexKey === undefined
        ? undefined
        : runRecordProfilePhase(profilePhase, 'record/validation/residency/index-equality', () =>
            this.sharedMeshBuffer(indexKey, indexWords),
          );
    const vboResult =
      shared === undefined
        ? runRecordProfilePhase(profilePhase, 'record/validation/residency/vertex-buffer', () =>
            device.createBuffer({
              label: `mesh-${id}-vbo`,
              size: vertices.byteLength,
              usage: renderData.vertexUsage,
              mappedAtCreation: false,
            }),
          )
        : ok(shared.buffer.handle);
    if (!vboResult.ok) return vboResult;
    const vbo = vboResult.value;
    let ibo: Buffer | null = sharedIndex?.buffer.handle ?? null;
    const cleanupUpload = (): void => {
      if (ibo !== null && sharedIndex === undefined) device.destroyBuffer(ibo);
      if (shared === undefined) device.destroyBuffer(vbo);
    };
    if (indices !== undefined && sharedIndex === undefined) {
      const iboResult = runRecordProfilePhase(
        profilePhase,
        'record/validation/residency/index-buffer',
        () =>
          device.createBuffer({
            label: `mesh-${id}-ibo`,
            size: indexBytes,
            usage: renderData.indexUsage,
            mappedAtCreation: false,
          }),
      );
      if (!iboResult.ok) {
        cleanupUpload();
        return iboResult;
      }
      ibo = iboResult.value;
    }

    const vboWriteResult =
      shared === undefined
        ? runRecordProfilePhase(profilePhase, 'record/validation/residency/vertex-write', () =>
            device.queue.writeBuffer(vbo, 0, vertices),
          )
        : ok(undefined);
    if (!vboWriteResult.ok) {
      cleanupUpload();
      return err(vboWriteResult.error);
    }

    if (indexWords !== undefined && sharedIndex === undefined) {
      if (ibo === null) {
        cleanupUpload();
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: `mesh-${id} index buffer to be allocated before its upload`,
            hint: 'the indexed mesh upload lost its RHI index-buffer owner',
          }),
        );
      }
      const iboWriteResult = runRecordProfilePhase(
        profilePhase,
        'record/validation/residency/index-write',
        () => device.queue.writeBuffer(ibo, 0, indexWords),
      );
      if (!iboWriteResult.ok) {
        cleanupUpload();
        return err(iboWriteResult.error);
      }
    }

    // The geometry projection already contains every packed attribute,
    // including skin and additional UV sets. Dividing by a second
    // attribute-derived count would double-count those fields and produce a
    // fractional vertex count for otherwise valid meshes.
    const extraUvSets = countExtraUvSets(mesh.attributes);
    const vertexBuffer = this.retainMeshBuffer(
      shared ?? {
        buffer: this.wrapBuf(vbo),
        bytes: runRecordProfilePhase(
          profilePhase,
          'record/validation/residency/ownership-copy',
          () => new Uint32Array(vertexWords),
        ),
        owners: 0,
        key: vertexKey,
      },
    );
    const indexBuffer =
      ibo === null || indexWords === undefined || indexKey === undefined
        ? null
        : this.retainMeshBuffer(
            sharedIndex ?? {
              buffer: this.wrapBuf(ibo),
              bytes: indexWords,
              owners: 0,
              key: indexKey,
            },
          );
    let changeToken: MeshChangeToken | undefined;
    let entry: MeshGpuHandles | undefined;
    const previous = this.meshGpuHandles.get(id, namespace);
    try {
      changeToken = this.meshChanges.create();
      entry = {
        contentEpoch: changeToken.epoch,
        changeToken,
        vertexBuffer,
        indexBuffer,
        vboBytes: vertices.byteLength,
        iboBytes: indices === undefined ? 0 : indexBytes,
        indexCount: mesh.indices === undefined ? 0 : mesh.indices.length,
        indexFormat: indices instanceof Uint32Array ? 'uint32' : 'uint16',
        layoutProjection: renderData.layoutProjection,
        uvSetCount: 1 + extraUvSets,
        vertexCount,
        indexed: mesh.indices !== undefined,
        topology: renderData.submeshes[0]?.topology ?? 'triangle-list',
        submeshes: renderData.submeshes,
        ...(lodRanges === undefined ? {} : { lodRanges }),
      };
      const result = this.meshLifetime(entry).result;
      this.meshLodAssets.set(entry, lodMeshes);
      this.meshGpuHandles.set(id, entry, namespace);
      return result;
    } catch (cause) {
      const failures: unknown[] = [];
      const cleanup = (action: () => void) => {
        try {
          action();
        } catch (failure) {
          failures.push(failure);
        }
      };
      cleanup(() => {
        if (entry !== undefined && this.meshGpuHandles.get(id, namespace) === entry) {
          this.meshGpuHandles.delete(id, namespace);
          if (previous !== undefined) {
            try {
              this.meshGpuHandles.set(id, previous, namespace);
            } catch (failure) {
              this.retireMeshEntry(id, previous, namespace);
              throw failure;
            }
          }
        }
      });
      cleanup(() => {
        if (changeToken !== undefined) this.meshChanges.retire(changeToken);
      });
      cleanup(() => this.releaseMeshBuffer(vertexBuffer));
      cleanup(() => {
        if (indexBuffer !== null) this.releaseMeshBuffer(indexBuffer);
      });
      if (failures.length !== 0)
        throw new AggregateError([cause, ...failures], 'Mesh admission and cleanup failed');
      throw cause;
    }
  }
}

/**
 * Synthesize the `DecodedImage` view the texture-upload prelude consumes from
 * a `TextureAsset` POD (the record-stage pull path holds only the POD). The
 * POD's `data` is the pixel bytes; `colorSpace` + `mips` drive the
 * consistency assertion + mip count.
 */
function decodedFromTexture(tex: TextureAsset): DecodedImage {
  return {
    bytes: tex.data,
    width: tex.shape.extent.width,
    height: tex.shape.extent.height,
    mime: 'image/png',
    colorSpace: tex.colorSpace,
    mipmap: tex.mips.kind === 'generate',
  };
}
