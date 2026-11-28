// Pure TypeScript RenderKernel implementation with bit-identical ABI semantics to Rust kernel-core.

import type { RhiCaps, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import {
  CMD_ACQUIRE_TEMP_TEX,
  CMD_BEGIN_COMPUTE_PASS,
  CMD_BEGIN_RENDER_PASS,
  CMD_COPY_BUFFER,
  CMD_COPY_TEXTURE,
  CMD_DEF_BINDING_SET,
  CMD_DISPATCH,
  CMD_DISPATCH_INDIRECT,
  CMD_DRAW_FULLSCREEN,
  CMD_DRAW_MESH,
  CMD_DRAW_RENDERERS,
  CMD_END_COMPUTE_PASS,
  CMD_END_RENDER_PASS,
  CMD_GENERATE_MIPS,
  CMD_REQUEST_READBACK,
  CMD_RHI_DRAW,
  CMD_RHI_DRAW_INDEXED,
  CMD_RHI_DRAW_INDIRECT,
  CMD_RHI_SET_BIND_GROUP,
  CMD_RHI_SET_IB,
  CMD_RHI_SET_PIPELINE,
  CMD_RHI_SET_VB,
  CMD_SET_SCISSOR,
  CMD_SET_SHADER_PIPELINE,
  CMD_SET_VIEWPORT,
  cmdHeader,
  DRAW_FLAG_GPU_DRIVEN,
  DRAW_FLAG_INSTANCING,
  DRAW_FLAG_SHADOW_CASTER_ONLY,
  FrameRecorder,
  PHYS_BEGIN_COMPUTE_PASS,
  PHYS_BEGIN_RENDER_PASS,
  PHYS_COPY_BUFFER,
  PHYS_COPY_TEXTURE,
  PHYS_DEF_BINDING_SET,
  PHYS_DISPATCH,
  PHYS_DISPATCH_INDIRECT,
  PHYS_DRAW,
  PHYS_DRAW_FULLSCREEN,
  PHYS_DRAW_INDEXED,
  PHYS_DRAW_INDIRECT,
  PHYS_END_COMPUTE_PASS,
  PHYS_END_RENDER_PASS,
  PHYS_ENSURE_POOL_TEX,
  PHYS_GENERATE_MIPS,
  PHYS_REQUEST_READBACK,
  PHYS_RETIRE_POOL_TEX,
  PHYS_SET_BIND_GROUP,
  PHYS_SET_IB,
  PHYS_SET_PSO,
  PHYS_SET_SCISSOR,
  PHYS_SET_VB,
  PHYS_SET_VIEWPORT,
  SORT_BACK_TO_FRONT,
  SORT_FRONT_TO_BACK,
  SORT_MATERIAL_PSO,
  SORT_NONE,
} from './command-stream.js';
import {
  CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
  CULL_FLAG_CULL_LIGHTS,
  CULL_FLAG_INCLUDE_SHADOW_ONLY,
  type FrameSubmitReceipt,
  type KernelAssetApi,
  type KernelBufferDesc,
  type KernelCreateShaderModuleImmediate,
  type KernelCullParams,
  type KernelCullSummary,
  type KernelMaterialDesc,
  type KernelMeshDesc,
  type KernelSamplerDesc,
  type KernelShaderProgramDesc,
  type KernelTextureDesc,
  type KernelVisibleLightSummary,
  type RenderKernel,
} from './contract.js';
import type { DynamicTextureDesc, DynamicTextureUploadSource } from './dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from './errors.js';
import {
  type BufferId,
  type CullId,
  type DynamicTextureId,
  GenerationalSlotTable,
  INVALID_HANDLE,
  type LightId,
  type MaterialId,
  type MeshId,
  type PipelineId,
  type RenderObjectId,
  type SamplerId,
  type ShaderProgramId,
  type SlotLookupError,
  type SurfaceId,
  TEMP_TEXTURE_TAG_BIT,
  type TextureId,
} from './handles.js';
import {
  BGL_SLOT_MATERIAL,
  BGL_SLOT_VIEW,
  IntegerPsoTable,
  LAYOUT_FAMILY_SCENE_4BGL,
  packPsoKeyInto,
} from './pso-key.js';
import { RhiPhysicalExecutor } from './rhi-replay.js';
import {
  DELTA_FLAG_BASELINE,
  DELTA_FLAG_CLEAR_SCENE,
  LIGHT_KIND_DIRECTIONAL,
  LIGHT_RECORD_WORDS,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_GPU_DRIVEN,
  OBJ_FLAG_MASKED,
  OBJ_FLAG_TRANSPARENT,
  OBJ_FLAG_VISIBLE,
  OP_REMOVE_OBJECTS,
  OP_SET_DRAW_PARAMS,
  OP_SET_ENVIRONMENT,
  OP_SET_INSTANCES,
  OP_SET_LIGHTS,
  OP_SET_SKIN_JOINTS,
  OP_SET_TRANSFORMS,
  OP_UPDATE_MATERIAL_BINDINGS,
  OP_UPDATE_MATERIAL_PARAMS,
  OP_UPSERT_OBJECTS,
  SCENE_DELTA_HEADER_BYTES,
  SCENE_DELTA_MAGIC,
  SCENE_DELTA_VERSION,
  SceneDeltaWriter,
  UPSERT_RECORD_WORDS,
} from './scene-delta.js';

interface TsMeshMeta {
  readonly vertexLayoutId: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly isUint32Index: boolean;
  readonly topology: number;
}

interface TsDynamicTexMeta {
  width: number;
  height: number;
  format: number;
  revision: number;
  viewGeneration: number;
  inPlaceUpdates: number;
  reallocations: number;
}

interface TsMaterialMeta {
  readonly shaderProgramId: number;
  readonly layoutFamilyId: number;
  readonly renderStateBits: number;
  readonly variantFlags: number;
  readonly queue: number;
  paramBytes: Uint8Array;
  paramDirty: boolean;
}

interface TsLightRecord {
  readonly lightId: number;
  readonly kind: 0 | 1 | 2;
  readonly castShadow: boolean;
  readonly cascadeCount: number;
  readonly layerMask: number;
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly range: number;
  readonly intensity: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  readonly outerConeCos: number;
  readonly colorR: number;
  readonly colorG: number;
  readonly colorB: number;
}

interface TsCullRecord {
  readonly cullId: number;
  readonly camX: number;
  readonly camY: number;
  readonly camZ: number;
  readonly rowsStart: number;
  readonly rowsLen: number;
}

interface PoolSlot {
  readonly slotId: number;
  readonly fsd: number;
  readonly width: number;
  readonly height: number;
  readonly layersMips: number;
  readonly usage: number;
  lastUsedFrame: number;
  inUseUntilPass: number;
  alive: boolean;
}

interface TempEntry {
  readonly tempId: number;
  readonly fsd: number;
  readonly width: number;
  readonly height: number;
  readonly layersMips: number;
  readonly usage: number;
  firstPass: number;
  lastPass: number;
  poolSlot: number;
}

interface Pass1ScanState {
  readonly temps: TempEntry[];
  readonly writtenTemps: number[];
  passIndex: number;
  inRenderPass: boolean;
}

interface FrameLowerState {
  readonly temps: readonly TempEntry[];
  submittedPassCount: number;
  mergedPassCount: number;
  submittedDrawCount: number;
  submittedIndirectCount: number;
  pendingPipelineCount: number;
  firstMissingObjectId: number;
  firstMissingSubmesh: number;
  lastEndPos: number;
  lastSig: number[] | undefined;
}

interface DrawRendererItem {
  readonly sortKey: bigint;
  readonly row: number;
  readonly psoSlot: number;
  readonly w0: number;
  readonly w1: number;
  readonly w2: number;
  readonly w3: number;
  readonly meshId: number;
  readonly materialId: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly isUint32Index: boolean;
}

interface DrawRendererBatchParams {
  readonly cull: TsCullRecord;
  readonly passTag: number;
  readonly sortMode: number;
  readonly drawFlags: number;
  readonly queueMin: number;
  readonly queueMax: number;
  readonly layerMask: number;
  readonly overrideShader: number;
  readonly passAttachmentId: number;
}

interface ObjectCullStats {
  readonly candidateCount: number;
  readonly visibleOpaqueCount: number;
  readonly visibleMaskedCount: number;
  readonly visibleTransparentCount: number;
  readonly visibleShadowCasterCount: number;
  readonly visibleBoundsMin: [number, number, number];
  readonly visibleBoundsMax: [number, number, number];
}

function expandVisibleBounds(
  min: [number, number, number],
  max: [number, number, number],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  if (minX < min[0]) min[0] = minX;
  if (minY < min[1]) min[1] = minY;
  if (minZ < min[2]) min[2] = minZ;
  if (maxX > max[0]) max[0] = maxX;
  if (maxY > max[1]) max[1] = maxY;
  if (maxZ > max[2]) max[2] = maxZ;
}

function findTempEntry(temps: readonly TempEntry[], handle: number): TempEntry | undefined {
  if ((handle & TEMP_TEXTURE_TAG_BIT) === 0) return undefined;
  for (let i = 0; i < temps.length; i++) {
    if ((temps[i] as TempEntry).tempId === handle) return temps[i];
  }
  return undefined;
}

function resolveTempTexture(
  temps: readonly TempEntry[],
  handle: number,
): Result<number, KernelError> {
  if ((handle & TEMP_TEXTURE_TAG_BIT) === 0) return ok(handle >>> 0);
  const t = findTempEntry(temps, handle);
  if (t === undefined) {
    return kernelErr(
      'kernel-temp-texture-out-of-scope',
      'TsRenderKernel',
      'declared TempTextureId',
      'undeclared temp texture',
      handle,
    );
  }
  return ok((TEMP_TEXTURE_TAG_BIT | t.poolSlot) >>> 0);
}

function touchTempLifetime(entry: TempEntry | undefined, passIndex: number): void {
  if (entry === undefined) return;
  if (passIndex < entry.firstPass) entry.firstPass = passIndex;
  if (passIndex > entry.lastPass) entry.lastPass = passIndex;
}

function computeDrawSortKey(
  sortMode: number,
  depthQ: number,
  psoSlot: number,
  layoutFamilyId: number,
  materialId: number,
  meshId: number,
  entityOrder: number,
  row: number,
): bigint {
  if (sortMode === SORT_BACK_TO_FRONT) {
    const invDepth = 0xffff - depthQ;
    return (
      (BigInt(invDepth) << 48n) |
      (BigInt(entityOrder) << 32n) |
      (BigInt(materialId & 0xffff) << 16n) |
      BigInt(row & 0xffff)
    );
  }
  if (sortMode === SORT_FRONT_TO_BACK) {
    return (
      (BigInt(psoSlot & 0xffff) << 48n) |
      (BigInt(materialId & 0xffff) << 32n) |
      (BigInt(depthQ) << 16n) |
      BigInt(row & 0xffff)
    );
  }
  if (sortMode === SORT_MATERIAL_PSO) {
    return (
      (BigInt(psoSlot & 0xffff) << 48n) |
      (BigInt(layoutFamilyId & 0xffff) << 32n) |
      (BigInt(materialId & 0xffff) << 16n) |
      BigInt(meshId & 0xffff)
    );
  }
  return BigInt(row);
}

function countInstancedRun(
  items: readonly DrawRendererItem[],
  startIndex: number,
  enableInstancing: boolean,
  sortMode: number,
): number {
  let instanceCount = 1;
  if (!enableInstancing || sortMode === SORT_BACK_TO_FRONT) return instanceCount;
  const base = items[startIndex] as DrawRendererItem;
  while (startIndex + instanceCount < items.length) {
    const next = items[startIndex + instanceCount] as DrawRendererItem;
    if (
      next.psoSlot === base.psoSlot &&
      next.materialId === base.materialId &&
      next.meshId === base.meshId
    ) {
      instanceCount += 1;
    } else {
      break;
    }
  }
  return instanceCount;
}

const F32_BITS_F = new Float32Array(1);
const F32_BITS_U = new Uint32Array(F32_BITS_F.buffer);

function quantizeDistSqU16(dx: number, dy: number, dz: number): number {
  F32_BITS_F[0] = dx * dx + dy * dy + dz * dz;
  return ((F32_BITS_U[0] as number) >>> 15) & 0xffff;
}

function mapSlotErr<T>(
  reason: SlotLookupError,
  owner: string,
  handle: number,
): Result<T, KernelError> {
  const code =
    reason === 'stale'
      ? 'kernel-handle-stale-generation'
      : reason === 'destroyed'
        ? 'kernel-handle-already-destroyed'
        : reason === 'capacity'
          ? 'kernel-budget-exceeded'
          : 'kernel-handle-invalid';
  return kernelErr(code, owner, 'valid live handle', `slot lookup failed (${reason})`, handle);
}

function extractFrustumPlanes(m: Float32Array, out: Float32Array): void {
  const r0x = m[0] as number,
    r0y = m[4] as number,
    r0z = m[8] as number,
    r0w = m[12] as number;
  const r1x = m[1] as number,
    r1y = m[5] as number,
    r1z = m[9] as number,
    r1w = m[13] as number;
  const r2x = m[2] as number,
    r2y = m[6] as number,
    r2z = m[10] as number,
    r2w = m[14] as number;
  const r3x = m[3] as number,
    r3y = m[7] as number,
    r3z = m[11] as number,
    r3w = m[15] as number;

  const setPlane = (i: number, x: number, y: number, z: number, w: number) => {
    const len = Math.hypot(x, y, z);
    const inv = len > 1e-12 ? 1 / len : 1;
    const b = i * 4;
    out[b] = x * inv;
    out[b + 1] = y * inv;
    out[b + 2] = z * inv;
    out[b + 3] = w * inv;
  };
  setPlane(0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
  setPlane(1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
  setPlane(2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
  setPlane(3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
  setPlane(4, r2x, r2y, r2z, r2w);
  setPlane(5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
}

function aabbIntersectsFrustum(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  planes: Float32Array,
): boolean {
  for (let i = 0; i < 6; i++) {
    const b = i * 4;
    const nx = planes[b] as number;
    const ny = planes[b + 1] as number;
    const nz = planes[b + 2] as number;
    const nw = planes[b + 3] as number;
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + nw < 0) return false;
  }
  return true;
}

function sphereIntersectsFrustum(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  planes: Float32Array,
): boolean {
  for (let i = 0; i < 6; i++) {
    const b = i * 4;
    if (
      (planes[b] as number) * cx +
        (planes[b + 1] as number) * cy +
        (planes[b + 2] as number) * cz +
        (planes[b + 3] as number) <
      -r
    ) {
      return false;
    }
  }
  return true;
}

function writeTransformedAabb(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  m: Float32Array,
  mOff: number,
  outMin: Float32Array,
  outMax: Float32Array,
  rowOff: number,
): void {
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const ex = (maxX - minX) * 0.5;
  const ey = (maxY - minY) * 0.5;
  const ez = (maxZ - minZ) * 0.5;

  const m0 = m[mOff] as number,
    m1 = m[mOff + 1] as number,
    m2 = m[mOff + 2] as number;
  const m4 = m[mOff + 4] as number,
    m5 = m[mOff + 5] as number,
    m6 = m[mOff + 6] as number;
  const m8 = m[mOff + 8] as number,
    m9 = m[mOff + 9] as number,
    m10 = m[mOff + 10] as number;
  const m12 = m[mOff + 12] as number,
    m13 = m[mOff + 13] as number,
    m14 = m[mOff + 14] as number;

  const wcx = m0 * cx + m4 * cy + m8 * cz + m12;
  const wcy = m1 * cx + m5 * cy + m9 * cz + m13;
  const wcz = m2 * cx + m6 * cy + m10 * cz + m14;

  const wex = Math.abs(m0) * ex + Math.abs(m4) * ey + Math.abs(m8) * ez;
  const wey = Math.abs(m1) * ex + Math.abs(m5) * ey + Math.abs(m9) * ez;
  const wez = Math.abs(m2) * ex + Math.abs(m6) * ey + Math.abs(m10) * ez;

  outMin[rowOff] = wcx - wex;
  outMin[rowOff + 1] = wcy - wey;
  outMin[rowOff + 2] = wcz - wez;
  outMax[rowOff] = wcx + wex;
  outMax[rowOff + 1] = wcy + wey;
  outMax[rowOff + 2] = wcz + wez;
}

export class TsRenderKernel implements RenderKernel {
  readonly backendKind = 'ts-rhi' as const;
  readonly mode = 'ts' as const;
  readonly caps: Readonly<RhiCaps>;
  readonly device: RhiDevice;
  readonly assets: KernelAssetApi;

  private readonly executor: RhiPhysicalExecutor;
  private readonly deltaWriter = new SceneDeltaWriter(64 * 1024);
  private readonly recorder = new FrameRecorder(8192, 64 * 1024);
  private readonly psoTable = new IntegerPsoTable();
  private readonly psoScratch = new Uint32Array(4);
  private readonly planesScratch = new Float32Array(24);

  // Asset metadata tables
  private readonly meshes = new GenerationalSlotTable<TsMeshMeta>();
  private readonly textures = new GenerationalSlotTable<number>();
  private readonly dynamicTextures = new GenerationalSlotTable<TsDynamicTexMeta>();
  private readonly buffers = new GenerationalSlotTable<number>();
  private readonly samplers = new GenerationalSlotTable<number>();
  private readonly shaders = new GenerationalSlotTable<number>();
  private readonly materials = new GenerationalSlotTable<TsMaterialMeta>();

  // Retained SoA scene columns
  private epoch = 0;
  private revision = 0;
  private objectCount = 0;
  private capacity = 256;
  private objectIds = new Uint32Array(256);
  private meshIds = new Uint32Array(256);
  private submeshStart = new Uint16Array(256);
  private submeshCount = new Uint16Array(256);
  private materialIds = new Uint32Array(256);
  private layerMasks = new Uint32Array(256);
  private objFlags = new Uint32Array(256);
  private skinSlots = new Uint32Array(256);
  private queues = new Uint16Array(256);
  private entityOrders = new Uint16Array(256);
  private localMin = new Float32Array(256 * 3);
  private localMax = new Float32Array(256 * 3);
  private transforms = new Float32Array(256 * 16);
  private worldMin = new Float32Array(256 * 3);
  private worldMax = new Float32Array(256 * 3);
  private readonly objectToRow = new Map<number, number>();
  private readonly lights: TsLightRecord[] = [];

  // Per-frame bump state & RT pool
  private activeFrameId: number | undefined;
  private surfaceWidth = 1;
  private surfaceHeight = 1;
  private nextCullId = 1;
  private readonly culls: TsCullRecord[] = [];
  private cullRowsArena = new Uint32Array(4096);
  private cullRowsCursor = 0;
  private readonly poolSlots: PoolSlot[] = [];
  private nextPoolSlotId = 1;
  private physCmds = new Uint32Array(8192);
  private physCursor = 0;
  private submittedBitmap = new Uint32Array(64);
  private disposed = false;

  constructor(device: RhiDevice, createShaderModuleImmediate?: KernelCreateShaderModuleImmediate) {
    this.device = device;
    this.caps = device.caps;
    this.executor = new RhiPhysicalExecutor(device, createShaderModuleImmediate);
    this.assets = this.createAssetApi();
  }

  private createAssetApi(): KernelAssetApi {
    return {
      createMesh: (desc: KernelMeshDesc, vertexBytes: Uint8Array, indexBytes?: Uint8Array) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'kernel disposed');
        const id = this.meshes.insert({
          vertexLayoutId: desc.vertexLayoutId,
          indexCount: desc.indexCount,
          vertexCount: desc.vertexCount,
          isUint32Index: desc.isUint32Index === true,
          topology: desc.topology ?? 0,
        });
        if (id === null)
          return kernelErr(
            'kernel-budget-exceeded',
            'TsRenderKernel',
            'mesh slot',
            'slot capacity reached',
          );
        const r = this.executor.createMesh(id, desc, vertexBytes, indexBytes);
        if (!r.ok) {
          this.meshes.remove(id);
          return r;
        }
        return ok(id as MeshId);
      },
      destroyMesh: (id: MeshId) => {
        const rem = this.meshes.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyMesh', id);
        this.executor.destroyMesh(id);
        return ok(undefined);
      },
      createTexture: (desc: KernelTextureDesc, initialBytes?: Uint8Array) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'kernel disposed');
        const id = this.textures.insert(desc.format);
        if (id === null)
          return kernelErr(
            'kernel-budget-exceeded',
            'TsRenderKernel',
            'texture slot',
            'capacity reached',
          );
        const r = this.executor.createTexture(id, desc, initialBytes);
        if (!r.ok) {
          this.textures.remove(id);
          return r;
        }
        return ok(id as TextureId);
      },
      destroyTexture: (id: TextureId) => {
        const rem = this.textures.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyTexture', id);
        this.executor.destroyTexture(id);
        return ok(undefined);
      },
      createDynamicTexture: (desc: DynamicTextureDesc) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'kernel disposed');
        const id = this.dynamicTextures.insert({
          width: desc.width,
          height: desc.height,
          format: desc.format,
          revision: 0,
          viewGeneration: 1,
          inPlaceUpdates: 0,
          reallocations: 0,
        });
        if (id === null)
          return kernelErr(
            'kernel-budget-exceeded',
            'TsRenderKernel',
            'dynamic texture slot',
            'capacity',
          );
        const r = this.executor.createDynamicTexture(id, desc);
        if (!r.ok) {
          this.dynamicTextures.remove(id);
          return r;
        }
        return ok(id as DynamicTextureId);
      },
      uploadDynamicTexture: (
        id: DynamicTextureId,
        revision: number,
        width: number,
        height: number,
        source: DynamicTextureUploadSource,
      ) => {
        const fault = this.dynamicTextures.check(id);
        if (fault !== undefined)
          return mapSlotErr(fault, 'TsRenderKernel.uploadDynamicTexture', id);
        const meta = this.dynamicTextures.get(id) as TsDynamicTexMeta;
        if (revision === meta.revision && width === meta.width && height === meta.height) {
          return ok(false);
        }
        meta.revision = revision;
        const reallocated = width !== meta.width || height !== meta.height;
        if (reallocated) {
          meta.width = width;
          meta.height = height;
          meta.viewGeneration = (meta.viewGeneration + 1) >>> 0;
          meta.reallocations += 1;
        } else {
          meta.inPlaceUpdates += 1;
        }
        const up = this.executor.uploadDynamicTexture(id, reallocated, width, height, source);
        if (!up.ok) return up;
        return ok(reallocated);
      },
      destroyDynamicTexture: (id: DynamicTextureId) => {
        const rem = this.dynamicTextures.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyDynamicTexture', id);
        this.executor.destroyDynamicTexture(id);
        return ok(undefined);
      },
      createBuffer: (desc: KernelBufferDesc, initialBytes?: Uint8Array) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'kernel disposed');
        const id = this.buffers.insert(desc.size);
        if (id === null)
          return kernelErr('kernel-budget-exceeded', 'TsRenderKernel', 'buffer slot', 'capacity');
        const r = this.executor.createBuffer(id, desc, initialBytes);
        if (!r.ok) {
          this.buffers.remove(id);
          return r;
        }
        return ok(id as BufferId);
      },
      writeBuffer: (id: BufferId, offset: number, bytes: Uint8Array) => {
        const fault = this.buffers.check(id);
        if (fault !== undefined) return mapSlotErr(fault, 'TsRenderKernel.writeBuffer', id);
        return this.executor.writeBuffer(id, offset, bytes);
      },
      destroyBuffer: (id: BufferId) => {
        const rem = this.buffers.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyBuffer', id);
        this.executor.destroyBuffer(id);
        return ok(undefined);
      },
      createSampler: (desc: KernelSamplerDesc) => {
        const id = this.samplers.insert(1);
        if (id === null)
          return kernelErr('kernel-budget-exceeded', 'TsRenderKernel', 'sampler slot', 'capacity');
        const r = this.executor.createSampler(id, desc);
        if (!r.ok) {
          this.samplers.remove(id);
          return r;
        }
        return ok(id as SamplerId);
      },
      destroySampler: (id: SamplerId) => {
        const rem = this.samplers.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroySampler', id);
        this.executor.destroySampler(id);
        return ok(undefined);
      },
      registerShaderProgram: (desc: KernelShaderProgramDesc) => {
        const id = this.shaders.insert(desc.layoutFamilyId);
        if (id === null)
          return kernelErr('kernel-budget-exceeded', 'TsRenderKernel', 'shader slot', 'capacity');
        const r = this.executor.registerShaderProgram(id, desc);
        if (!r.ok) {
          this.shaders.remove(id);
          return r;
        }
        return ok(id as ShaderProgramId);
      },
      destroyShaderProgram: (id: ShaderProgramId) => {
        const rem = this.shaders.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyShaderProgram', id);
        this.executor.destroyShaderProgram(id);
        return ok(undefined);
      },
      createMaterial: (desc: KernelMaterialDesc, initialParamBytes: Uint8Array) => {
        const id = this.materials.insert({
          shaderProgramId: desc.shaderProgramId,
          layoutFamilyId: desc.layoutFamilyId,
          renderStateBits: desc.renderStateBits,
          variantFlags: desc.variantFlags ?? 0,
          queue: desc.queue ?? 1000,
          paramBytes: new Uint8Array(initialParamBytes),
          paramDirty: false,
        });
        if (id === null)
          return kernelErr('kernel-budget-exceeded', 'TsRenderKernel', 'material slot', 'capacity');
        const r = this.executor.createMaterial(id, desc, initialParamBytes);
        if (!r.ok) {
          this.materials.remove(id);
          return r;
        }
        return ok(id as MaterialId);
      },
      updateMaterialParams: (id: MaterialId, paramBytes: Uint8Array) =>
        this.executor.updateMaterialParams(id, paramBytes),
      destroyMaterial: (id: MaterialId) => {
        const rem = this.materials.remove(id);
        if (!rem.ok) return mapSlotErr(rem.reason, 'TsRenderKernel.destroyMaterial', id);
        this.executor.destroyMaterial(id);
        return ok(undefined);
      },
      setSkinJoints: (slotOffset: number, jointMatrices: Float32Array) =>
        this.executor.uploadSkinJoints(slotOffset, jointMatrices),
      registerExternalSurface: (
        texture: Texture,
        view: TextureView,
        width: number,
        height: number,
      ) => this.executor.registerExternalSurface(texture, view, width, height) as SurfaceId,
      registerExternalPipeline: (pipeline) =>
        this.executor.registerExternalPipeline(pipeline) as PipelineId,
    };
  }

  private ensureSceneCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let cap = this.capacity;
    while (cap < needed) cap *= 2;
    const growU32 = (a: Uint32Array) => {
      const n = new Uint32Array(cap);
      n.set(a);
      return n;
    };
    const growU16 = (a: Uint16Array) => {
      const n = new Uint16Array(cap);
      n.set(a);
      return n;
    };
    const growF32 = (a: Float32Array, stride: number) => {
      const n = new Float32Array(cap * stride);
      n.set(a);
      return n;
    };
    this.objectIds = growU32(this.objectIds);
    this.meshIds = growU32(this.meshIds);
    this.submeshStart = growU16(this.submeshStart);
    this.submeshCount = growU16(this.submeshCount);
    this.materialIds = growU32(this.materialIds);
    this.layerMasks = growU32(this.layerMasks);
    this.objFlags = growU32(this.objFlags);
    this.skinSlots = growU32(this.skinSlots);
    this.queues = growU16(this.queues);
    this.entityOrders = growU16(this.entityOrders);
    this.localMin = growF32(this.localMin, 3);
    this.localMax = growF32(this.localMax, 3);
    this.transforms = growF32(this.transforms, 16);
    this.worldMin = growF32(this.worldMin, 3);
    this.worldMax = growF32(this.worldMax, 3);
    this.capacity = cap;
  }

  beginSceneDelta(_minBytes?: number): SceneDeltaWriter {
    return this.deltaWriter;
  }

  commitSceneDelta(writer: SceneDeltaWriter): Result<number, KernelError> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'disposed');
    const bytes = writer.finish();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = this.validateAndApplyDeltaHeader(bytes, dv);
    if (!header.ok) return header;

    let cursor = SCENE_DELTA_HEADER_BYTES;
    const { opCount, end } = header.value;
    for (let op = 0; op < opCount; op++) {
      if (cursor + 8 > end) {
        return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'op header', 'truncated op');
      }
      const opCode = dv.getUint32(cursor, true) & 0xffff;
      const countOrLen = dv.getUint32(cursor + 4, true);
      cursor += 8;

      const step = this.applySceneDeltaOp(dv, bytes, opCode, countOrLen, cursor, end);
      if (!step.ok) return step;
      cursor = step.value;
    }

    return ok(this.revision);
  }

  private validateAndApplyDeltaHeader(
    bytes: Uint8Array,
    dv: DataView,
  ): Result<{ opCount: number; end: number }, KernelError> {
    if (bytes.byteLength < SCENE_DELTA_HEADER_BYTES || (bytes.byteLength & 3) !== 0) {
      return kernelErr(
        'kernel-delta-malformed',
        'TsRenderKernel',
        '64-byte FXK1 header',
        'buffer too small or unaligned',
      );
    }
    if (dv.getUint32(0, true) !== SCENE_DELTA_MAGIC) {
      return kernelErr(
        'kernel-delta-malformed',
        'TsRenderKernel',
        'FXK1 magic',
        'invalid delta magic',
      );
    }
    if (dv.getUint32(4, true) !== SCENE_DELTA_VERSION) {
      return kernelErr(
        'kernel-protocol-version-mismatch',
        'TsRenderKernel',
        'FXK1 v1',
        'unsupported protocol version',
      );
    }
    const epoch = dv.getUint32(8, true);
    const revision = dv.getUint32(12, true);
    const baseRevision = dv.getUint32(16, true);
    const flags = dv.getUint32(20, true);
    const opCount = dv.getUint32(24, true);
    const payloadBytes = dv.getUint32(28, true);
    if (SCENE_DELTA_HEADER_BYTES + payloadBytes > bytes.byteLength || (payloadBytes & 3) !== 0) {
      return kernelErr(
        'kernel-delta-malformed',
        'TsRenderKernel',
        'valid payloadBytes',
        'payload out of range',
      );
    }
    const isBaseline = (flags & DELTA_FLAG_BASELINE) !== 0;
    if (!isBaseline && (epoch !== this.epoch || baseRevision !== this.revision)) {
      return kernelErr(
        'kernel-delta-base-mismatch',
        'TsRenderKernel',
        `base ${this.revision}`,
        `got ${baseRevision}`,
      );
    }
    if (isBaseline || (flags & DELTA_FLAG_CLEAR_SCENE) !== 0) {
      this.objectCount = 0;
      this.objectToRow.clear();
      this.lights.length = 0;
    }
    this.epoch = epoch;
    this.revision = revision;
    return ok({ opCount, end: SCENE_DELTA_HEADER_BYTES + payloadBytes });
  }

  private applySceneDeltaOp(
    dv: DataView,
    bytes: Uint8Array,
    opCode: number,
    countOrLen: number,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    switch (opCode) {
      case OP_UPSERT_OBJECTS:
        return this.applyUpsertObjectsOp(dv, countOrLen, cursor, end);
      case OP_REMOVE_OBJECTS:
        return this.applyRemoveObjectsOp(dv, countOrLen, cursor, end);
      case OP_SET_TRANSFORMS:
        return this.applySetTransformsOp(dv, countOrLen, cursor, end);
      case OP_SET_DRAW_PARAMS: {
        const needed = countOrLen * 36;
        if (cursor + needed > end) {
          return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'drawParams', 'truncated');
        }
        return ok(cursor + needed);
      }
      case OP_UPDATE_MATERIAL_PARAMS:
        return this.applyUpdateMaterialParamsOp(dv, bytes, cursor, end);
      case OP_SET_LIGHTS:
        return this.applySetLightsOp(dv, countOrLen, cursor, end);
      case OP_SET_ENVIRONMENT:
        if (cursor + 64 > end) {
          return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'environment', 'truncated');
        }
        return ok(cursor + 64);
      case OP_SET_SKIN_JOINTS:
      case OP_UPDATE_MATERIAL_BINDINGS:
      case OP_SET_INSTANCES: {
        const aligned = (countOrLen + 3) & ~3;
        if (cursor + aligned > end) {
          return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'ext op', 'truncated');
        }
        return ok(cursor + aligned);
      }
      default:
        return kernelErr(
          'kernel-delta-malformed',
          'TsRenderKernel',
          'known SceneDelta op',
          `unknown op ${opCode}`,
        );
    }
  }

  private applyUpsertObjectsOp(
    dv: DataView,
    count: number,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    const needed = count * UPSERT_RECORD_WORDS * 4;
    if (cursor + needed > end) {
      return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'upsert records', 'truncated');
    }
    for (let i = 0; i < count; i++) {
      const b = cursor + i * UPSERT_RECORD_WORDS * 4;
      const oid = dv.getUint32(b, true);
      if (oid === INVALID_HANDLE) continue;
      let row = this.objectToRow.get(oid);
      if (row === undefined) {
        row = this.objectCount++;
        this.ensureSceneCapacity(this.objectCount);
        this.objectToRow.set(oid, row);
        this.objectIds[row] = oid;
        const mOff = row * 16;
        this.transforms.fill(0, mOff, mOff + 16);
        this.transforms[mOff] = 1;
        this.transforms[mOff + 5] = 1;
        this.transforms[mOff + 10] = 1;
        this.transforms[mOff + 15] = 1;
      }
      this.meshIds[row] = dv.getUint32(b + 4, true);
      const sub = dv.getUint32(b + 8, true);
      this.submeshStart[row] = sub >>> 16;
      this.submeshCount[row] = sub & 0xffff;
      this.materialIds[row] = dv.getUint32(b + 12, true);
      this.layerMasks[row] = dv.getUint32(b + 16, true);
      this.objFlags[row] = dv.getUint32(b + 20, true);
      this.skinSlots[row] = dv.getUint32(b + 24, true);
      const qp = dv.getUint32(b + 28, true);
      this.queues[row] = qp >>> 16;
      this.entityOrders[row] = qp & 0xffff;
      const r3 = row * 3;
      const minX = dv.getFloat32(b + 32, true);
      const minY = dv.getFloat32(b + 36, true);
      const minZ = dv.getFloat32(b + 40, true);
      const maxX = dv.getFloat32(b + 44, true);
      const maxY = dv.getFloat32(b + 48, true);
      const maxZ = dv.getFloat32(b + 52, true);
      this.localMin[r3] = minX;
      this.localMin[r3 + 1] = minY;
      this.localMin[r3 + 2] = minZ;
      this.localMax[r3] = maxX;
      this.localMax[r3 + 1] = maxY;
      this.localMax[r3 + 2] = maxZ;
      writeTransformedAabb(
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ,
        this.transforms,
        row * 16,
        this.worldMin,
        this.worldMax,
        r3,
      );
    }
    return ok(cursor + needed);
  }

  private applyRemoveObjectsOp(
    dv: DataView,
    count: number,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    const needed = count * 4;
    if (cursor + needed > end) {
      return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'remove ids', 'truncated');
    }
    for (let i = 0; i < count; i++) {
      const oid = dv.getUint32(cursor + i * 4, true);
      const row = this.objectToRow.get(oid);
      if (row === undefined) continue;
      this.objectToRow.delete(oid);
      const last = this.objectCount - 1;
      this.objectCount = last;
      if (row !== last) {
        const movedId = this.objectIds[last] as number;
        this.objectIds[row] = movedId;
        this.meshIds[row] = this.meshIds[last] as number;
        this.submeshStart[row] = this.submeshStart[last] as number;
        this.submeshCount[row] = this.submeshCount[last] as number;
        this.materialIds[row] = this.materialIds[last] as number;
        this.layerMasks[row] = this.layerMasks[last] as number;
        this.objFlags[row] = this.objFlags[last] as number;
        this.skinSlots[row] = this.skinSlots[last] as number;
        this.queues[row] = this.queues[last] as number;
        this.entityOrders[row] = this.entityOrders[last] as number;
        const r3 = row * 3;
        const l3 = last * 3;
        this.localMin[r3] = this.localMin[l3] as number;
        this.localMin[r3 + 1] = this.localMin[l3 + 1] as number;
        this.localMin[r3 + 2] = this.localMin[l3 + 2] as number;
        this.localMax[r3] = this.localMax[l3] as number;
        this.localMax[r3 + 1] = this.localMax[l3 + 1] as number;
        this.localMax[r3 + 2] = this.localMax[l3 + 2] as number;
        this.worldMin[r3] = this.worldMin[l3] as number;
        this.worldMin[r3 + 1] = this.worldMin[l3 + 1] as number;
        this.worldMin[r3 + 2] = this.worldMin[l3 + 2] as number;
        this.worldMax[r3] = this.worldMax[l3] as number;
        this.worldMax[r3 + 1] = this.worldMax[l3 + 1] as number;
        this.worldMax[r3 + 2] = this.worldMax[l3 + 2] as number;
        const r16 = row * 16;
        const l16 = last * 16;
        for (let k = 0; k < 16; k++) {
          this.transforms[r16 + k] = this.transforms[l16 + k] as number;
        }
        this.objectToRow.set(movedId, row);
      }
    }
    return ok(cursor + needed);
  }

  private applySetTransformsOp(
    dv: DataView,
    count: number,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    const idBytes = count * 4;
    const matBytes = count * 64;
    if (cursor + idBytes + matBytes > end) {
      return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'transforms', 'truncated');
    }
    const matBase = cursor + idBytes;
    for (let i = 0; i < count; i++) {
      const oid = dv.getUint32(cursor + i * 4, true);
      const row = this.objectToRow.get(oid);
      if (row === undefined) continue;
      const mOff = row * 16;
      const srcOff = matBase + i * 64;
      for (let k = 0; k < 16; k++) {
        this.transforms[mOff + k] = dv.getFloat32(srcOff + k * 4, true);
      }
      const r3 = row * 3;
      writeTransformedAabb(
        this.localMin[r3] as number,
        this.localMin[r3 + 1] as number,
        this.localMin[r3 + 2] as number,
        this.localMax[r3] as number,
        this.localMax[r3 + 1] as number,
        this.localMax[r3 + 2] as number,
        this.transforms,
        mOff,
        this.worldMin,
        this.worldMax,
        r3,
      );
    }
    return ok(cursor + idBytes + matBytes);
  }

  private applyUpdateMaterialParamsOp(
    dv: DataView,
    bytes: Uint8Array,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    if (cursor + 8 > end) {
      return kernelErr(
        'kernel-delta-malformed',
        'TsRenderKernel',
        'mat params header',
        'truncated',
      );
    }
    const matId = dv.getUint32(cursor, true);
    const packed = dv.getUint32(cursor + 4, true);
    const byteOffset = packed & 0xffff;
    const byteLen = packed >>> 16;
    const aligned = (byteLen + 3) & ~3;
    const bodyStart = cursor + 8;
    if (bodyStart + aligned > end) {
      return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'mat params body', 'truncated');
    }
    const mat = this.materials.get(matId);
    if (mat === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'TsRenderKernel',
        'valid MaterialId',
        'unknown material',
        matId,
      );
    }
    if (byteOffset + byteLen > mat.paramBytes.byteLength) {
      const next = new Uint8Array(byteOffset + byteLen);
      next.set(mat.paramBytes);
      mat.paramBytes = next;
    }
    mat.paramBytes.set(bytes.subarray(bodyStart, bodyStart + byteLen), byteOffset);
    mat.paramDirty = true;
    return ok(bodyStart + aligned);
  }

  private applySetLightsOp(
    dv: DataView,
    count: number,
    cursor: number,
    end: number,
  ): Result<number, KernelError> {
    const needed = count * LIGHT_RECORD_WORDS * 4;
    if (cursor + needed > end) {
      return kernelErr('kernel-delta-malformed', 'TsRenderKernel', 'lights', 'truncated');
    }
    this.lights.length = 0;
    for (let i = 0; i < count; i++) {
      const b = cursor + i * LIGHT_RECORD_WORDS * 4;
      const meta = dv.getUint32(b + 4, true);
      this.lights.push({
        lightId: dv.getUint32(b, true),
        kind: (meta & 0xff) as 0 | 1 | 2,
        castShadow: ((meta >>> 8) & 1) !== 0,
        cascadeCount: (meta >>> 16) & 0xff,
        layerMask: dv.getUint32(b + 8, true),
        range: dv.getFloat32(b + 12, true),
        px: dv.getFloat32(b + 16, true),
        py: dv.getFloat32(b + 20, true),
        pz: dv.getFloat32(b + 24, true),
        intensity: dv.getFloat32(b + 28, true),
        dirX: dv.getFloat32(b + 32, true),
        dirY: dv.getFloat32(b + 36, true),
        dirZ: dv.getFloat32(b + 40, true),
        outerConeCos: dv.getFloat32(b + 44, true),
        colorR: dv.getFloat32(b + 48, true),
        colorG: dv.getFloat32(b + 52, true),
        colorB: dv.getFloat32(b + 56, true),
      });
    }
    return ok(cursor + needed);
  }

  beginFrame(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): Result<FrameRecorder, KernelError> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'TsRenderKernel', 'live kernel', 'disposed');
    if (this.activeFrameId !== undefined) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'TsRenderKernel',
        'idle frame state',
        'frame already active',
      );
    }
    this.activeFrameId = frameId;
    this.surfaceWidth = Math.max(1, surfaceWidth);
    this.surfaceHeight = Math.max(1, surfaceHeight);
    this.culls.length = 0;
    this.cullRowsCursor = 0;
    this.nextCullId = 1;
    this.recorder.reset();
    return ok(this.recorder);
  }

  private pushCullRow(row: number): void {
    if (this.cullRowsCursor >= this.cullRowsArena.length) {
      const next = new Uint32Array(this.cullRowsArena.length * 2);
      next.set(this.cullRowsArena);
      this.cullRowsArena = next;
    }
    this.cullRowsArena[this.cullRowsCursor++] = row;
  }

  cull(params: KernelCullParams): Result<KernelCullSummary, KernelError> {
    if (this.activeFrameId === undefined) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'TsRenderKernel.cull',
        'active frame',
        'call beginFrame first',
      );
    }
    extractFrustumPlanes(params.viewProj, this.planesScratch);
    const layerMask = (params.layerMask ?? 0xffff_ffff) >>> 0;
    const flags = (params.flags ?? CULL_FLAG_CULL_LIGHTS | CULL_FLAG_COMPUTE_VISIBLE_BOUNDS) >>> 0;
    const computeBounds = (flags & CULL_FLAG_COMPUTE_VISIBLE_BOUNDS) !== 0;
    const includeShadow = (flags & CULL_FLAG_INCLUDE_SHADOW_ONLY) !== 0;

    const rowsStart = this.cullRowsCursor;
    const stats = this.cullObjects(layerMask, includeShadow, computeBounds);
    const visibleLights = (flags & CULL_FLAG_CULL_LIGHTS) !== 0 ? this.cullLights(layerMask) : [];

    const cullId = this.nextCullId++ as CullId;
    this.culls.push({
      cullId,
      camX: params.cameraPos[0],
      camY: params.cameraPos[1],
      camZ: params.cameraPos[2],
      rowsStart,
      rowsLen: this.cullRowsCursor - rowsStart,
    });

    return ok({
      cullId,
      candidateCount: stats.candidateCount,
      visibleOpaqueCount: stats.visibleOpaqueCount,
      visibleMaskedCount: stats.visibleMaskedCount,
      visibleTransparentCount: stats.visibleTransparentCount,
      visibleShadowCasterCount: stats.visibleShadowCasterCount,
      visibleBoundsMin: stats.visibleBoundsMin,
      visibleBoundsMax: stats.visibleBoundsMax,
      visibleLights,
    });
  }

  private cullObjects(
    layerMask: number,
    includeShadow: boolean,
    computeBounds: boolean,
  ): ObjectCullStats {
    let candidateCount = 0;
    let visibleOpaqueCount = 0;
    let visibleMaskedCount = 0;
    let visibleTransparentCount = 0;
    let visibleShadowCasterCount = 0;
    const visibleBoundsMin: [number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    const visibleBoundsMax: [number, number, number] = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (let row = 0; row < this.objectCount; row++) {
      const f = this.objFlags[row] as number;
      if ((f & OBJ_FLAG_VISIBLE) === 0) continue;
      if (((this.layerMasks[row] as number) & layerMask) === 0) continue;
      if (includeShadow && (f & OBJ_FLAG_CAST_SHADOW) === 0) continue;
      candidateCount += 1;

      const r3 = row * 3;
      const minX = this.worldMin[r3] as number;
      const minY = this.worldMin[r3 + 1] as number;
      const minZ = this.worldMin[r3 + 2] as number;
      const maxX = this.worldMax[r3] as number;
      const maxY = this.worldMax[r3 + 1] as number;
      const maxZ = this.worldMax[r3 + 2] as number;
      if (
        (f & OBJ_FLAG_FRUSTUM_CULLED) !== 0 &&
        !aabbIntersectsFrustum(minX, minY, minZ, maxX, maxY, maxZ, this.planesScratch)
      ) {
        continue;
      }

      this.pushCullRow(row);
      if ((f & OBJ_FLAG_TRANSPARENT) !== 0) visibleTransparentCount += 1;
      else if ((f & OBJ_FLAG_MASKED) !== 0) visibleMaskedCount += 1;
      else visibleOpaqueCount += 1;
      if ((f & OBJ_FLAG_CAST_SHADOW) !== 0) visibleShadowCasterCount += 1;
      if (computeBounds) {
        expandVisibleBounds(visibleBoundsMin, visibleBoundsMax, minX, minY, minZ, maxX, maxY, maxZ);
      }
    }

    if (!computeBounds || !Number.isFinite(visibleBoundsMin[0])) {
      visibleBoundsMin[0] = 0;
      visibleBoundsMin[1] = 0;
      visibleBoundsMin[2] = 0;
      visibleBoundsMax[0] = 0;
      visibleBoundsMax[1] = 0;
      visibleBoundsMax[2] = 0;
    }

    return {
      candidateCount,
      visibleOpaqueCount,
      visibleMaskedCount,
      visibleTransparentCount,
      visibleShadowCasterCount,
      visibleBoundsMin,
      visibleBoundsMax,
    };
  }

  private cullLights(layerMask: number): KernelVisibleLightSummary[] {
    const visibleLights: KernelVisibleLightSummary[] = [];
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i] as TsLightRecord;
      if ((l.layerMask & layerMask) === 0) continue;
      const vis =
        l.kind === LIGHT_KIND_DIRECTIONAL || !Number.isFinite(l.range)
          ? true
          : sphereIntersectsFrustum(l.px, l.py, l.pz, l.range, this.planesScratch);
      if (vis) {
        visibleLights.push({
          lightId: l.lightId as LightId,
          kind: l.kind,
          castShadow: l.castShadow,
          cascadeCount: l.cascadeCount,
          screenCoverage: 1,
        });
      }
    }
    return visibleLights;
  }

  private pushPhys(word: number): void {
    if (this.physCursor >= this.physCmds.length) {
      const next = new Uint32Array(this.physCmds.length * 2);
      next.set(this.physCmds);
      this.physCmds = next;
    }
    this.physCmds[this.physCursor++] = word >>> 0;
  }

  private pushPhysWords(
    physOpcode: number,
    input: Uint32Array,
    cursor: number,
    wordLen: number,
  ): void {
    this.pushPhys(cmdHeader(physOpcode, wordLen));
    for (let k = 1; k < wordLen; k++) this.pushPhys(input[cursor + k] as number);
  }

  private readonly drawInstanceRows: number[] = [];

  get supportsScene4Bgl(): boolean {
    return this.executor.supportsScene4Bgl;
  }

  private sync4BglSceneBuffersToExecutor(): void {
    if (!this.executor.supportsScene4Bgl) return;
    if (this.objectCount > 0) {
      const objBuf = new ArrayBuffer(this.objectCount * 96);
      const objF32 = new Float32Array(objBuf);
      for (let row = 0; row < this.objectCount; row++) {
        const dst = row * 24;
        const tBase = row * 16;
        for (let k = 0; k < 16; k++) objF32[dst + k] = this.transforms[tBase + k] as number;
        const skinSlot = this.skinSlots[row] as number;
        objF32[dst + 23] = skinSlot;
      }
      this.executor.uploadSceneObjects(new Uint8Array(objBuf));
    }
    if (this.lights.length > 0) {
      const lgtBuf = new ArrayBuffer(this.lights.length * 64);
      const lgtF32 = new Float32Array(lgtBuf);
      const lgtU32 = new Uint32Array(lgtBuf);
      for (let i = 0; i < this.lights.length; i++) {
        const l = this.lights[i];
        if (l === undefined) continue;
        const b = i * 16;
        lgtF32[b] = l.px;
        lgtF32[b + 1] = l.py;
        lgtF32[b + 2] = l.pz;
        lgtF32[b + 3] = l.range;
        lgtF32[b + 4] = l.dirX;
        lgtF32[b + 5] = l.dirY;
        lgtF32[b + 6] = l.dirZ;
        lgtF32[b + 7] = l.intensity;
        lgtF32[b + 8] = l.colorR;
        lgtF32[b + 9] = l.colorG;
        lgtF32[b + 10] = l.colorB;
        lgtF32[b + 11] = l.outerConeCos;
        lgtU32[b + 12] = l.kind >>> 0;
        lgtU32[b + 13] = l.castShadow ? 1 : 0;
        lgtU32[b + 14] = l.cascadeCount >>> 0;
        lgtU32[b + 15] = l.layerMask >>> 0;
      }
      this.executor.uploadSceneLights(new Uint8Array(lgtBuf));
    }
  }

  submitFrame(recorder: FrameRecorder): Result<FrameSubmitReceipt, KernelError> {
    if (this.activeFrameId === undefined) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'TsRenderKernel.submitFrame',
        'active frame',
        'call beginFrame first',
      );
    }
    const frameId = this.activeFrameId;
    this.activeFrameId = undefined;

    const input = recorder.commandSlice;
    this.physCursor = 0;
    this.drawInstanceRows.length = 0;
    const bitmapWords = (this.objectCount + 31) >>> 5;
    if (this.submittedBitmap.length < bitmapWords) {
      this.submittedBitmap = new Uint32Array(Math.max(64, bitmapWords * 2));
    }
    this.submittedBitmap.fill(0, 0, bitmapWords);

    // --- PASS 1: Lifetime & conflict scan ---
    const scanRes = this.scanCommandStreamLifetimes(input);
    if (!scanRes.ok) return scanRes;

    // --- PASS 2: Transient RT pooling with lifetime aliasing ---
    const { poolAllocations, poolReuses } = this.allocateTransientPoolSlots(scanRes.value, frameId);

    // --- PASS 3: Emit resolved physical command stream (matches Rust planner.rs word-for-word) ---
    const lowerRes = this.lowerCommandStream(input, scanRes.value);
    if (!lowerRes.ok) return lowerRes;
    const state = lowerRes.value;

    // Retire idle transient textures (> 8 frames)
    this.retireIdlePoolSlots(frameId);

    if (this.executor.supportsScene4Bgl) {
      this.sync4BglSceneBuffersToExecutor();
      if (this.drawInstanceRows.length > 0) {
        this.executor.uploadInstanceRows(Uint32Array.from(this.drawInstanceRows));
      }
    }

    const physSlice = this.physCmds.subarray(0, this.physCursor);
    const execRes = this.executor.executePhysicalStream(physSlice, recorder.uniformDataSlice);
    if (!execRes.ok) return execRes;

    return ok({
      frameId,
      sceneRevision: this.revision,
      status: state.pendingPipelineCount > 0 ? 'pending-pipelines' : 'ready',
      submittedPassCount: state.submittedPassCount,
      mergedPassCount: state.mergedPassCount,
      submittedDrawCount: state.submittedDrawCount,
      submittedIndirectCount: state.submittedIndirectCount,
      pendingPipelineCount: state.pendingPipelineCount,
      firstMissingObjectId: state.firstMissingObjectId as RenderObjectId | 0,
      firstMissingSubmesh: state.firstMissingSubmesh,
      poolTextureCount: this.poolSlots.length,
      poolAllocations,
      poolReuses,
      resolvedPhysicalCommands: new Uint32Array(physSlice),
      submittedBitmap: new Uint32Array(this.submittedBitmap.subarray(0, bitmapWords)),
    });
  }

  private scanCommandStreamLifetimes(input: Uint32Array): Result<TempEntry[], KernelError> {
    const state: Pass1ScanState = {
      temps: [],
      writtenTemps: [],
      passIndex: 0,
      inRenderPass: false,
    };
    let cursor = 0;
    while (cursor < input.length) {
      const hdr = input[cursor] as number;
      const opcode = hdr & 0xffff;
      const wordLen = hdr >>> 16;
      if (wordLen === 0 || cursor + wordLen > input.length) {
        return kernelErr(
          'kernel-command-stream-malformed',
          'TsRenderKernel',
          'valid command wordLen',
          'truncated stream',
        );
      }
      switch (opcode) {
        case CMD_ACQUIRE_TEMP_TEX:
          this.scanAcquireTempTex(input, cursor, state.temps);
          break;
        case CMD_BEGIN_RENDER_PASS: {
          const res = this.scanBeginRenderPass(input, cursor, state);
          if (!res.ok) return res;
          break;
        }
        case CMD_END_RENDER_PASS:
          if (!state.inRenderPass) {
            return kernelErr(
              'kernel-command-stream-malformed',
              'TsRenderKernel',
              'matching beginRenderPass',
              'stray endRenderPass',
            );
          }
          state.inRenderPass = false;
          state.writtenTemps.length = 0;
          state.passIndex += 1;
          break;
        case CMD_END_COMPUTE_PASS:
          state.passIndex += 1;
          break;
        case CMD_DEF_BINDING_SET: {
          const res = this.scanDefBindingSet(input, cursor, state);
          if (!res.ok) return res;
          break;
        }
        case CMD_COPY_TEXTURE: {
          const res = this.scanCopyTexture(input, cursor, state);
          if (!res.ok) return res;
          break;
        }
        case CMD_GENERATE_MIPS:
        case CMD_REQUEST_READBACK:
          touchTempLifetime(
            findTempEntry(state.temps, input[cursor + 1] as number),
            state.passIndex,
          );
          state.passIndex += 1;
          break;
        default:
          break;
      }
      cursor += wordLen;
    }
    return ok(state.temps);
  }

  private scanAcquireTempTex(input: Uint32Array, cursor: number, temps: TempEntry[]): void {
    const w = input[cursor + 3] as number;
    const h = input[cursor + 4] as number;
    temps.push({
      tempId: input[cursor + 1] as number,
      fsd: input[cursor + 2] as number,
      width: w === 0 ? this.surfaceWidth : w,
      height: h === 0 ? this.surfaceHeight : h,
      layersMips: input[cursor + 5] as number,
      usage: input[cursor + 6] as number,
      firstPass: 0xffff_ffff,
      lastPass: 0,
      poolSlot: 0,
    });
  }

  private scanBeginRenderPass(
    input: Uint32Array,
    cursor: number,
    state: Pass1ScanState,
  ): Result<void, KernelError> {
    if (state.inRenderPass) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'TsRenderKernel',
        'balanced render passes',
        'nested beginRenderPass',
      );
    }
    state.inRenderPass = true;
    state.writtenTemps.length = 0;
    const meta = input[cursor + 2] as number;
    const colorCount = meta & 0xff;
    const hasDepth = ((meta >>> 8) & 1) !== 0;
    for (let c = 0; c < colorCount; c++) {
      const b = cursor + 3 + c * 8;
      const t1 = findTempEntry(state.temps, input[b] as number);
      if (t1 !== undefined) {
        touchTempLifetime(t1, state.passIndex);
        state.writtenTemps.push(t1.tempId);
      }
      const t2 = findTempEntry(state.temps, input[b + 1] as number);
      if (t2 !== undefined) {
        touchTempLifetime(t2, state.passIndex);
        state.writtenTemps.push(t2.tempId);
      }
    }
    if (hasDepth) {
      const b = cursor + 3 + colorCount * 8;
      const td = findTempEntry(state.temps, input[b] as number);
      const ro = (((input[b + 2] as number) >>> 16) & 1) !== 0;
      if (td !== undefined) {
        touchTempLifetime(td, state.passIndex);
        if (!ro) state.writtenTemps.push(td.tempId);
      }
    }
    return ok(undefined);
  }

  private scanDefBindingSet(
    input: Uint32Array,
    cursor: number,
    state: Pass1ScanState,
  ): Result<void, KernelError> {
    const count = input[cursor + 2] as number;
    for (let e = 0; e < count; e++) {
      const sk = input[cursor + 3 + e * 3] as number;
      const kind = sk >>> 16;
      if (kind !== 0 && kind !== 2) continue;
      const h = input[cursor + 3 + e * 3 + 1] as number;
      const t = findTempEntry(state.temps, h);
      if (t !== undefined) {
        if (state.inRenderPass && state.writtenTemps.includes(h)) {
          return kernelErr(
            'kernel-pass-resource-conflict',
            'TsRenderKernel',
            'disjoint read/write temp texture',
            'cannot sample an active render attachment in the same pass',
            h,
          );
        }
        touchTempLifetime(t, state.passIndex);
      }
    }
    return ok(undefined);
  }

  private scanCopyTexture(
    input: Uint32Array,
    cursor: number,
    state: Pass1ScanState,
  ): Result<void, KernelError> {
    const src = input[cursor + 1] as number;
    const dst = input[cursor + 3] as number;
    if (src === dst && (src & TEMP_TEXTURE_TAG_BIT) !== 0) {
      return kernelErr(
        'kernel-pass-resource-conflict',
        'TsRenderKernel',
        'distinct copy src/dst',
        'self-copy temp texture',
        src,
      );
    }
    touchTempLifetime(findTempEntry(state.temps, src), state.passIndex);
    touchTempLifetime(findTempEntry(state.temps, dst), state.passIndex);
    state.passIndex += 1;
    return ok(undefined);
  }

  private allocateTransientPoolSlots(
    temps: readonly TempEntry[],
    frameId: number,
  ): { poolAllocations: number; poolReuses: number } {
    for (let i = 0; i < this.poolSlots.length; i++) {
      (this.poolSlots[i] as PoolSlot).inUseUntilPass = -1;
    }
    let poolAllocations = 0;
    let poolReuses = 0;
    for (let i = 0; i < temps.length; i++) {
      const t = temps[i] as TempEntry;
      if (t.firstPass === 0xffff_ffff) {
        t.firstPass = 0;
        t.lastPass = 0;
      }
      const matched = this.findMatchingPoolSlot(t, frameId);
      if (matched !== undefined) {
        t.poolSlot = matched.slotId;
        poolReuses += 1;
      } else {
        const slotId = this.nextPoolSlotId++;
        this.poolSlots.push({
          slotId,
          fsd: t.fsd,
          width: t.width,
          height: t.height,
          layersMips: t.layersMips,
          usage: t.usage,
          lastUsedFrame: frameId,
          inUseUntilPass: t.lastPass,
          alive: true,
        });
        t.poolSlot = slotId;
        poolAllocations += 1;
      }
      this.pushPhys(cmdHeader(PHYS_ENSURE_POOL_TEX, 7));
      this.pushPhys(t.poolSlot);
      this.pushPhys(t.fsd);
      this.pushPhys(t.width);
      this.pushPhys(t.height);
      this.pushPhys(t.layersMips);
      this.pushPhys(t.usage);
    }
    return { poolAllocations, poolReuses };
  }

  private findMatchingPoolSlot(t: TempEntry, frameId: number): PoolSlot | undefined {
    for (let s = 0; s < this.poolSlots.length; s++) {
      const slot = this.poolSlots[s] as PoolSlot;
      if (
        slot.alive &&
        slot.fsd === t.fsd &&
        slot.width === t.width &&
        slot.height === t.height &&
        slot.layersMips === t.layersMips &&
        slot.usage === t.usage &&
        slot.inUseUntilPass < t.firstPass
      ) {
        slot.inUseUntilPass = t.lastPass;
        slot.lastUsedFrame = frameId;
        return slot;
      }
    }
    return undefined;
  }

  private retireIdlePoolSlots(frameId: number): void {
    for (let i = this.poolSlots.length - 1; i >= 0; i--) {
      const slot = this.poolSlots[i] as PoolSlot;
      if (slot.alive && frameId - slot.lastUsedFrame > 8) {
        slot.alive = false;
        this.pushPhys(cmdHeader(PHYS_RETIRE_POOL_TEX, 2));
        this.pushPhys(slot.slotId);
        this.poolSlots.splice(i, 1);
      }
    }
  }

  private lowerCommandStream(
    input: Uint32Array,
    temps: readonly TempEntry[],
  ): Result<FrameLowerState, KernelError> {
    const state: FrameLowerState = {
      temps,
      submittedPassCount: 0,
      mergedPassCount: 0,
      submittedDrawCount: 0,
      submittedIndirectCount: 0,
      pendingPipelineCount: 0,
      firstMissingObjectId: 0,
      firstMissingSubmesh: 0,
      lastEndPos: -1,
      lastSig: undefined,
    };
    let cursor = 0;
    while (cursor < input.length) {
      const hdr = input[cursor] as number;
      const opcode = hdr & 0xffff;
      const wordLen = hdr >>> 16;
      const step = this.lowerCommand(opcode, input, cursor, wordLen, state);
      if (!step.ok) return step;
      cursor += wordLen;
    }
    return ok(state);
  }

  private lowerCommand(
    opcode: number,
    input: Uint32Array,
    cursor: number,
    wordLen: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    const render = this.tryLowerResourceOrRenderCommand(opcode, input, cursor, wordLen, state);
    if (!render.ok) return render;
    if (render.value) return ok(undefined);

    const computeOrTransfer = this.tryLowerComputeOrTransferCommand(opcode, input, cursor, state);
    if (!computeOrTransfer.ok) return computeOrTransfer;
    if (computeOrTransfer.value) return ok(undefined);

    if (this.tryLowerRawRhiCommand(opcode, input, cursor, wordLen, state)) {
      return ok(undefined);
    }

    return kernelErr(
      'kernel-command-stream-malformed',
      'TsRenderKernel',
      'known command opcode',
      `unknown opcode ${opcode}`,
    );
  }

  private tryLowerResourceOrRenderCommand(
    opcode: number,
    input: Uint32Array,
    cursor: number,
    wordLen: number,
    state: FrameLowerState,
  ): Result<boolean, KernelError> {
    switch (opcode) {
      case CMD_ACQUIRE_TEMP_TEX:
        // Already lowered
        return ok(true);
      case CMD_DEF_BINDING_SET: {
        const res = this.lowerDefBindingSet(input, cursor, wordLen, state);
        return res.ok ? ok(true) : res;
      }
      case CMD_BEGIN_RENDER_PASS: {
        const res = this.lowerBeginRenderPass(input, cursor, wordLen, state);
        return res.ok ? ok(true) : res;
      }
      case CMD_DRAW_RENDERERS: {
        const res = this.lowerDrawRenderers(input, cursor, state);
        return res.ok ? ok(true) : res;
      }
      case CMD_DRAW_FULLSCREEN:
        this.pushPhysWords(PHYS_DRAW_FULLSCREEN, input, cursor, 5);
        state.submittedDrawCount += 1;
        return ok(true);
      case CMD_DRAW_MESH:
        this.lowerDrawMesh(input, cursor, state);
        return ok(true);
      case CMD_END_RENDER_PASS:
        state.lastEndPos = this.physCursor;
        this.pushPhys(cmdHeader(PHYS_END_RENDER_PASS, 1));
        return ok(true);
      case CMD_SET_VIEWPORT:
        this.pushPhysWords(PHYS_SET_VIEWPORT, input, cursor, 7);
        return ok(true);
      case CMD_SET_SCISSOR:
        this.pushPhysWords(PHYS_SET_SCISSOR, input, cursor, 5);
        return ok(true);
      default:
        return ok(false);
    }
  }

  private tryLowerComputeOrTransferCommand(
    opcode: number,
    input: Uint32Array,
    cursor: number,
    state: FrameLowerState,
  ): Result<boolean, KernelError> {
    switch (opcode) {
      case CMD_BEGIN_COMPUTE_PASS:
        state.lastSig = undefined;
        state.submittedPassCount += 1;
        this.pushPhys(cmdHeader(PHYS_BEGIN_COMPUTE_PASS, 2));
        this.pushPhys(input[cursor + 1] as number);
        return ok(true);
      case CMD_DISPATCH:
        this.pushPhysWords(PHYS_DISPATCH, input, cursor, 8);
        state.submittedDrawCount += 1;
        return ok(true);
      case CMD_DISPATCH_INDIRECT:
        this.pushPhysWords(PHYS_DISPATCH_INDIRECT, input, cursor, 5);
        state.submittedIndirectCount += 1;
        return ok(true);
      case CMD_END_COMPUTE_PASS:
        this.pushPhys(cmdHeader(PHYS_END_COMPUTE_PASS, 1));
        return ok(true);
      case CMD_COPY_TEXTURE: {
        const res = this.lowerCopyTexture(input, cursor, state);
        return res.ok ? ok(true) : res;
      }
      case CMD_COPY_BUFFER:
        state.lastSig = undefined;
        this.pushPhysWords(PHYS_COPY_BUFFER, input, cursor, 6);
        return ok(true);
      case CMD_GENERATE_MIPS: {
        const res = this.lowerGenerateMips(input, cursor, state);
        return res.ok ? ok(true) : res;
      }
      case CMD_REQUEST_READBACK: {
        const res = this.lowerRequestReadback(input, cursor, state);
        return res.ok ? ok(true) : res;
      }
      default:
        return ok(false);
    }
  }

  private tryLowerRawRhiCommand(
    opcode: number,
    input: Uint32Array,
    cursor: number,
    wordLen: number,
    state: FrameLowerState,
  ): boolean {
    switch (opcode) {
      case CMD_RHI_SET_PIPELINE:
        this.pushPhys(cmdHeader(PHYS_SET_PSO, 6));
        this.pushPhys(0);
        this.pushPhys(0);
        this.pushPhys(0);
        this.pushPhys(0);
        this.pushPhys(input[cursor + 1] as number);
        return true;
      case CMD_RHI_SET_BIND_GROUP:
        this.pushPhysWords(PHYS_SET_BIND_GROUP, input, cursor, wordLen);
        return true;
      case CMD_RHI_SET_VB:
        this.pushPhysWords(PHYS_SET_VB, input, cursor, 4);
        return true;
      case CMD_RHI_SET_IB:
        this.pushPhysWords(PHYS_SET_IB, input, cursor, 4);
        return true;
      case CMD_RHI_DRAW:
        this.pushPhysWords(PHYS_DRAW, input, cursor, 5);
        state.submittedDrawCount += 1;
        return true;
      case CMD_RHI_DRAW_INDEXED:
        this.pushPhysWords(PHYS_DRAW_INDEXED, input, cursor, 6);
        state.submittedDrawCount += 1;
        return true;
      case CMD_RHI_DRAW_INDIRECT:
        this.pushPhysWords(PHYS_DRAW_INDIRECT, input, cursor, 3);
        state.submittedIndirectCount += 1;
        return true;
      case CMD_SET_SHADER_PIPELINE: {
        const shaderId = input[cursor + 1] as number;
        const renderStateBits = input[cursor + 2] as number;
        const passAttId = (input[cursor + 3] as number) & 0xffff;
        const vertexLayoutId = (input[cursor + 4] as number) & 0xffff;
        packPsoKeyInto(
          this.psoScratch,
          0,
          shaderId,
          vertexLayoutId,
          passAttId,
          0,
          0,
          renderStateBits,
          0,
        );
        const pso = this.psoTable.getOrAdmit(
          this.psoScratch[0] as number,
          this.psoScratch[1] as number,
          this.psoScratch[2] as number,
          this.psoScratch[3] as number,
          'ready',
        );
        this.pushPhys(cmdHeader(PHYS_SET_PSO, 6));
        this.pushPhys(pso.w0);
        this.pushPhys(pso.w1);
        this.pushPhys(pso.w2);
        this.pushPhys(pso.w3);
        this.pushPhys(pso.slotId);
        return true;
      }
      default:
        return false;
    }
  }

  private lowerDefBindingSet(
    input: Uint32Array,
    cursor: number,
    wordLen: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    const count = input[cursor + 2] as number;
    this.pushPhys(cmdHeader(PHYS_DEF_BINDING_SET, wordLen));
    this.pushPhys(input[cursor + 1] as number);
    this.pushPhys(count);
    for (let e = 0; e < count; e++) {
      const b = cursor + 3 + e * 3;
      const sk = input[b] as number;
      const kind = sk >>> 16;
      this.pushPhys(sk);
      if (kind === 0 || kind === 2) {
        const resolved = resolveTempTexture(state.temps, input[b + 1] as number);
        if (!resolved.ok) return resolved;
        this.pushPhys(resolved.value);
      } else {
        this.pushPhys(input[b + 1] as number);
      }
      this.pushPhys(input[b + 2] as number);
    }
    return ok(undefined);
  }

  private canMergeRenderPass(
    state: FrameLowerState,
    sig: readonly number[],
    allLoad: boolean,
  ): boolean {
    if (
      !allLoad ||
      state.lastSig === undefined ||
      state.lastEndPos !== this.physCursor - 1 ||
      state.lastSig.length !== sig.length
    ) {
      return false;
    }
    for (let k = 0; k < sig.length; k++) {
      if (state.lastSig[k] !== sig[k]) return false;
    }
    return true;
  }

  private lowerBeginRenderPass(
    input: Uint32Array,
    cursor: number,
    wordLen: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    const meta = input[cursor + 2] as number;
    const colorCount = meta & 0xff;
    const hasDepth = ((meta >>> 8) & 1) !== 0;
    const sig: number[] = [];
    let allLoad = true;
    const resolvedColors: number[] = [];
    for (let c = 0; c < colorCount; c++) {
      const b = cursor + 3 + c * 8;
      const rTex = resolveTempTexture(state.temps, input[b] as number);
      if (!rTex.ok) return rTex;
      const rRes = resolveTempTexture(state.temps, input[b + 1] as number);
      if (!rRes.ok) return rRes;
      const mipLayer = input[b + 2] as number;
      const loadStore = input[b + 3] as number;
      if ((loadStore & 0xff) !== 1) allLoad = false;
      sig.push(rTex.value, rRes.value, mipLayer);
      resolvedColors.push(rTex.value, rRes.value);
    }
    let resolvedDepthTex = 0;
    if (hasDepth) {
      const b = cursor + 3 + colorCount * 8;
      const rDepth = resolveTempTexture(state.temps, input[b] as number);
      if (!rDepth.ok) return rDepth;
      resolvedDepthTex = rDepth.value;
      const mipLayer = input[b + 1] as number;
      const lsr = input[b + 2] as number;
      if ((lsr & 0xff) !== 1) allLoad = false;
      sig.push(resolvedDepthTex, mipLayer, (lsr & 0x00ff_0000) >>> 0);
    }

    if (this.canMergeRenderPass(state, sig, allLoad)) {
      this.physCursor -= 1;
      state.mergedPassCount += 1;
    } else {
      state.submittedPassCount += 1;
      this.pushPhys(cmdHeader(PHYS_BEGIN_RENDER_PASS, wordLen));
      this.pushPhys(input[cursor + 1] as number);
      this.pushPhys(meta);
      for (let c = 0; c < colorCount; c++) {
        const b = cursor + 3 + c * 8;
        this.pushPhys(resolvedColors[c * 2] as number);
        this.pushPhys(resolvedColors[c * 2 + 1] as number);
        this.pushPhys(input[b + 2] as number);
        this.pushPhys(input[b + 3] as number);
        this.pushPhys(input[b + 4] as number);
        this.pushPhys(input[b + 5] as number);
        this.pushPhys(input[b + 6] as number);
        this.pushPhys(input[b + 7] as number);
      }
      if (hasDepth) {
        const b = cursor + 3 + colorCount * 8;
        this.pushPhys(resolvedDepthTex);
        this.pushPhys(input[b + 1] as number);
        this.pushPhys(input[b + 2] as number);
        this.pushPhys(input[b + 3] as number);
      }
    }
    state.lastSig = sig;
    state.lastEndPos = -1;
    return ok(undefined);
  }

  private lowerDrawRenderers(
    input: Uint32Array,
    cursor: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    const cullId = input[cursor + 1] as number;
    const cull = this.culls.find((c) => c.cullId === cullId);
    if (cull === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'TsRenderKernel',
        'valid CullId',
        'unknown cull handle',
        cullId,
      );
    }
    const pMeta = input[cursor + 2] as number;
    const qMeta = input[cursor + 3] as number;
    const sortMode = (pMeta >>> 8) & 0xff;
    const drawFlags = pMeta >>> 16;
    const items = this.collectDrawRendererItems(
      {
        cull,
        passTag: pMeta & 0xff,
        sortMode,
        drawFlags,
        queueMin: qMeta & 0xffff,
        queueMax: qMeta >>> 16,
        layerMask: input[cursor + 4] as number,
        overrideShader: input[cursor + 8] as number,
        passAttachmentId: (input[cursor + 10] as number) & 0xffff,
      },
      state,
    );
    this.emitDrawRendererItems(
      items,
      sortMode,
      (drawFlags & DRAW_FLAG_INSTANCING) !== 0,
      input[cursor + 7] as number,
      input[cursor + 5] as number,
      input[cursor + 9] as number,
      state,
    );
    return ok(undefined);
  }

  private collectDrawRendererItems(
    batch: DrawRendererBatchParams,
    state: FrameLowerState,
  ): DrawRendererItem[] {
    const { cull, passTag, sortMode, drawFlags, queueMin, queueMax, layerMask } = batch;
    const shadowOnly = (drawFlags & DRAW_FLAG_SHADOW_CASTER_ONLY) !== 0;
    const items: DrawRendererItem[] = [];
    const rowsEnd = cull.rowsStart + cull.rowsLen;
    for (let idx = cull.rowsStart; idx < rowsEnd; idx++) {
      const row = this.cullRowsArena[idx] as number;
      if (((this.layerMasks[row] as number) & layerMask) === 0) continue;
      const queue = this.queues[row] as number;
      if (queue < queueMin || queue > queueMax) continue;
      const f = this.objFlags[row] as number;
      if (shadowOnly && (f & OBJ_FLAG_CAST_SHADOW) === 0) continue;
      const meshId = this.meshIds[row] as number;
      const materialId = this.materialIds[row] as number;
      const mesh = this.meshes.get(meshId);
      const mat = this.materials.get(materialId);
      if (mesh === undefined || mat === undefined) {
        if (state.firstMissingObjectId === 0) {
          state.firstMissingObjectId = this.objectIds[row] as number;
          state.firstMissingSubmesh = this.submeshStart[row] as number;
        }
        continue;
      }
      const shaderId =
        batch.overrideShader !== INVALID_HANDLE ? batch.overrideShader : mat.shaderProgramId;
      const variantFlags =
        mat.variantFlags |
        ((f & OBJ_FLAG_GPU_DRIVEN) !== 0 && (drawFlags & DRAW_FLAG_GPU_DRIVEN) !== 0 ? 1 : 0);
      packPsoKeyInto(
        this.psoScratch,
        0,
        shaderId,
        mesh.vertexLayoutId,
        batch.passAttachmentId,
        passTag,
        mat.layoutFamilyId,
        mat.renderStateBits,
        variantFlags,
      );
      const pso = this.psoTable.getOrAdmit(
        this.psoScratch[0] as number,
        this.psoScratch[1] as number,
        this.psoScratch[2] as number,
        this.psoScratch[3] as number,
        'ready',
      );
      if (pso.status !== 'ready') {
        state.pendingPipelineCount += 1;
        if (state.firstMissingObjectId === 0) {
          state.firstMissingObjectId = this.objectIds[row] as number;
          state.firstMissingSubmesh = this.submeshStart[row] as number;
        }
        continue;
      }

      const mOff = row * 16;
      const depthQ = quantizeDistSqU16(
        (this.transforms[mOff + 12] as number) - cull.camX,
        (this.transforms[mOff + 13] as number) - cull.camY,
        (this.transforms[mOff + 14] as number) - cull.camZ,
      );
      const sortKey = computeDrawSortKey(
        sortMode,
        depthQ,
        pso.slotId,
        mat.layoutFamilyId,
        materialId,
        meshId,
        this.entityOrders[row] as number,
        row,
      );
      items.push({
        sortKey,
        row,
        psoSlot: pso.slotId,
        w0: pso.w0,
        w1: pso.w1,
        w2: pso.w2,
        w3: pso.w3,
        meshId,
        materialId,
        indexCount: mesh.indexCount,
        vertexCount: mesh.vertexCount,
        isUint32Index: mesh.isUint32Index,
      });
      (this.submittedBitmap[row >>> 5] as number) |= 1 << (row & 31);
    }
    return items;
  }

  private emitDrawRendererItems(
    items: DrawRendererItem[],
    sortMode: number,
    enableInstancing: boolean,
    extraBindings: number,
    viewUniformOff: number,
    viewSlotMode: number,
    state: FrameLowerState,
  ): void {
    if (items.length === 0) return;
    if (sortMode !== SORT_NONE) {
      items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    }
    this.pushPhys(cmdHeader(PHYS_SET_BIND_GROUP, 6));
    this.pushPhys(BGL_SLOT_VIEW);
    this.pushPhys(extraBindings);
    this.pushPhys(2);
    this.pushPhys(viewUniformOff);
    this.pushPhys(viewSlotMode);

    let curPso = -1;
    let curMat = -1;
    let curMesh = -1;
    let i = 0;
    while (i < items.length) {
      const it = items[i] as DrawRendererItem;
      const instanceCount = countInstancedRun(items, i, enableInstancing, sortMode);
      if (it.psoSlot !== curPso) {
        curPso = it.psoSlot;
        this.pushPhys(cmdHeader(PHYS_SET_PSO, 6));
        this.pushPhys(it.w0);
        this.pushPhys(it.w1);
        this.pushPhys(it.w2);
        this.pushPhys(it.w3);
        this.pushPhys(it.psoSlot);
      }
      if (it.materialId !== curMat) {
        curMat = it.materialId;
        this.pushPhys(cmdHeader(PHYS_SET_BIND_GROUP, 4));
        this.pushPhys(BGL_SLOT_MATERIAL);
        this.pushPhys(it.materialId);
        this.pushPhys(0);
      }
      if (it.meshId !== curMesh) {
        curMesh = it.meshId;
        this.pushPhys(cmdHeader(PHYS_SET_VB, 4));
        this.pushPhys(0);
        this.pushPhys(it.meshId);
        this.pushPhys(0);
        if (it.indexCount > 0) {
          this.pushPhys(cmdHeader(PHYS_SET_IB, 4));
          this.pushPhys(it.meshId);
          this.pushPhys(it.isUint32Index ? 1 : 0);
          this.pushPhys(0);
        }
      }
      let firstInstance = it.row;
      if (((it.w3 >>> 16) & 0xffff) === LAYOUT_FAMILY_SCENE_4BGL) {
        firstInstance = this.drawInstanceRows.length;
        for (let k = 0; k < instanceCount; k++) {
          this.drawInstanceRows.push((items[i + k] as DrawRendererItem).row);
        }
      }
      if (it.indexCount > 0) {
        this.pushPhys(cmdHeader(PHYS_DRAW_INDEXED, 6));
        this.pushPhys(it.indexCount);
        this.pushPhys(instanceCount);
        this.pushPhys(0);
        this.pushPhys(0);
        this.pushPhys(firstInstance);
      } else {
        this.pushPhys(cmdHeader(PHYS_DRAW, 5));
        this.pushPhys(it.vertexCount);
        this.pushPhys(instanceCount);
        this.pushPhys(0);
        this.pushPhys(firstInstance);
      }
      state.submittedDrawCount += 1;
      i += instanceCount;
    }
  }

  private lowerDrawMesh(input: Uint32Array, cursor: number, state: FrameLowerState): void {
    const meshId = input[cursor + 1] as number;
    const matId = input[cursor + 2] as number;
    const passTag = (input[cursor + 4] as number) & 0xff;
    const passAttId = (input[cursor + 5] as number) & 0xffff;
    const mesh = this.meshes.get(meshId);
    const mat = this.materials.get(matId);
    if (mesh === undefined || mat === undefined) return;

    packPsoKeyInto(
      this.psoScratch,
      0,
      mat.shaderProgramId,
      mesh.vertexLayoutId,
      passAttId,
      passTag,
      mat.layoutFamilyId,
      mat.renderStateBits,
      mat.variantFlags,
    );
    const pso = this.psoTable.getOrAdmit(
      this.psoScratch[0] as number,
      this.psoScratch[1] as number,
      this.psoScratch[2] as number,
      this.psoScratch[3] as number,
      'ready',
    );
    this.pushPhys(cmdHeader(PHYS_SET_PSO, 6));
    this.pushPhys(pso.w0);
    this.pushPhys(pso.w1);
    this.pushPhys(pso.w2);
    this.pushPhys(pso.w3);
    this.pushPhys(pso.slotId);
    this.pushPhys(cmdHeader(PHYS_SET_BIND_GROUP, 4));
    this.pushPhys(BGL_SLOT_MATERIAL);
    this.pushPhys(matId);
    this.pushPhys(0);
    this.pushPhys(cmdHeader(PHYS_SET_VB, 4));
    this.pushPhys(0);
    this.pushPhys(meshId);
    this.pushPhys(0);
    if (mesh.indexCount > 0) {
      this.pushPhys(cmdHeader(PHYS_SET_IB, 4));
      this.pushPhys(meshId);
      this.pushPhys(mesh.isUint32Index ? 1 : 0);
      this.pushPhys(0);
      this.pushPhys(cmdHeader(PHYS_DRAW_INDEXED, 6));
      this.pushPhys(mesh.indexCount);
      this.pushPhys(1);
      this.pushPhys(0);
      this.pushPhys(0);
      this.pushPhys(0);
    } else {
      this.pushPhys(cmdHeader(PHYS_DRAW, 5));
      this.pushPhys(mesh.vertexCount);
      this.pushPhys(1);
      this.pushPhys(0);
      this.pushPhys(0);
    }
    state.submittedDrawCount += 1;
  }

  private lowerCopyTexture(
    input: Uint32Array,
    cursor: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    state.lastSig = undefined;
    const rs = resolveTempTexture(state.temps, input[cursor + 1] as number);
    if (!rs.ok) return rs;
    const rd = resolveTempTexture(state.temps, input[cursor + 3] as number);
    if (!rd.ok) return rd;
    this.pushPhys(cmdHeader(PHYS_COPY_TEXTURE, 8));
    this.pushPhys(rs.value);
    this.pushPhys(input[cursor + 2] as number);
    this.pushPhys(rd.value);
    for (let k = 4; k < 8; k++) this.pushPhys(input[cursor + k] as number);
    return ok(undefined);
  }

  private lowerGenerateMips(
    input: Uint32Array,
    cursor: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    state.lastSig = undefined;
    const rt = resolveTempTexture(state.temps, input[cursor + 1] as number);
    if (!rt.ok) return rt;
    this.pushPhys(cmdHeader(PHYS_GENERATE_MIPS, 2));
    this.pushPhys(rt.value);
    return ok(undefined);
  }

  private lowerRequestReadback(
    input: Uint32Array,
    cursor: number,
    state: FrameLowerState,
  ): Result<void, KernelError> {
    state.lastSig = undefined;
    const rt = resolveTempTexture(state.temps, input[cursor + 1] as number);
    if (!rt.ok) return rt;
    this.pushPhys(cmdHeader(PHYS_REQUEST_READBACK, 4));
    this.pushPhys(rt.value);
    this.pushPhys(input[cursor + 2] as number);
    this.pushPhys(input[cursor + 3] as number);
    return ok(undefined);
  }

  getPoolTexture(poolSlotId: number): Texture | undefined {
    return this.executor.getPoolTexture(poolSlotId);
  }

  readbackTicket(
    ticketId: number,
  ): Promise<Result<import('./contract.js').KernelReadbackResult, KernelError>> {
    return this.executor.readbackTicket(ticketId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.executor.dispose();
    this.meshes.clear();
    this.textures.clear();
    this.dynamicTextures.clear();
    this.buffers.clear();
    this.samplers.clear();
    this.shaders.clear();
    this.materials.clear();
    this.psoTable.clear();
    this.objectToRow.clear();
    this.poolSlots.length = 0;
  }
}
