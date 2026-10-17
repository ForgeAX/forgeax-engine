import { deriveVertexBufferLayoutFromProjection } from '@forgeax/engine-geometry';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  Result,
  RhiDevice,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  type MaterialShaderArtifact,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '@forgeax/engine-shader';
import type { MaterialDynamicInputLayout, MaterialRenderState } from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { materialColorTarget, materialDepthStencil } from '../material-render-state';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import { packInstanceStorageBuffer } from '../record/mesh-ssbo';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { GpuDrivenStandardPbrFrameResources } from '../render-pipeline';
import { PROBE_BLEND_RECORD_BYTE_SIZE } from '../scene/probe-blend-record';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type {
  DynamicInputRange,
  DynamicInputUploadReceipt,
  ReadonlyDynamicInputPage,
  SurfaceDynamicInputFrame,
} from '../surface/dynamic-input';
import type { GpuDrivenBatch } from './batch-topology';
import type { GpuDrivenPbrProgram } from './pbr-program';
import { resolveStandardPbrProgram } from './pbr-program';
import type { FilteredProductionPlan } from './production-raster-prepare';
import { gpuDrivenReflectionFallbackRenderState } from './reflection-fallback-output';
import {
  GpuResourceAllocationLedger,
  type GpuResourceAllocationToken,
} from './resource-allocation';

/** Bind the whole GPU Scene transform table at group(2) binding(0) for every scene-index draw. */
export function resolveGpuDrivenMeshGroup(input: {
  readonly clustered: boolean;
  readonly deformation: 'rigid' | 'skin';
  readonly meshBindGroup: BindGroup;
  readonly sceneTransformBuffer: Buffer;
  readonly sceneTransformBytes: number;
  readonly frameResources: Pick<
    GpuDrivenStandardPbrFrameResources,
    'clusterBindGroup' | 'clusterBindGroupForMesh' | 'clusterBindGroupForSkin'
  >;
  readonly skinPaletteBinding?:
    | { readonly buffer: Buffer; readonly bindingWindowBytes: number }
    | undefined;
}): BindGroup | undefined {
  if (!input.clustered) return input.meshBindGroup;
  if (input.deformation === 'skin') {
    const palette = input.skinPaletteBinding;
    return palette === undefined
      ? undefined
      : input.frameResources.clusterBindGroupForSkin?.(
          input.sceneTransformBuffer,
          input.sceneTransformBytes,
          palette.buffer,
          palette.bindingWindowBytes,
        );
  }
  return input.frameResources.clusterBindGroupForMesh?.(
    input.sceneTransformBuffer,
    input.sceneTransformBytes,
  );
}

const SURFACE_FRAME_RECORD_BYTES = 48;
const SURFACE_SHARED_FRAME_BYTES = 16;
const SURFACE_DIRECT_ADDRESS_STRIDE = 256;

interface SurfaceFrameRange {
  readonly frameIndex: number;
  readonly range?: DynamicInputRange;
  readonly directMember?: {
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

interface SurfaceFrameRow {
  readonly eventRangeStart: number;
  readonly eventRangeCount: number;
  readonly instanceIndex: number;
  readonly backgroundAvailable: boolean;
}

interface SurfaceSharedFrameState {
  readonly buffer: Buffer;
  frameTime: number;
  writes: number;
}

function sameSurfaceFrameRow(left: SurfaceFrameRow, right: SurfaceFrameRow): boolean {
  return (
    left.eventRangeStart === right.eventRangeStart &&
    left.eventRangeCount === right.eventRangeCount &&
    left.instanceIndex === right.instanceIndex &&
    left.backgroundAvailable === right.backgroundAvailable
  );
}

function bufferBinding(buffer: Buffer, offset?: number, size?: number) {
  return {
    kind: 'buffer' as const,
    value: {
      buffer,
      ...(offset === undefined ? {} : { offset }),
      ...(size === undefined ? {} : { size }),
    },
  };
}

function writeSurfaceFrameRecord(
  view: DataView,
  offset: number,
  frameTime: number,
  eventRangeStart: number,
  eventRangeCount: number,
  instanceIndex = 0,
  backgroundAvailable = false,
): void {
  view.setFloat32(offset, frameTime, true);
  view.setUint32(offset + 4, eventRangeStart, true);
  view.setUint32(offset + 8, eventRangeCount, true);
  view.setUint32(offset + 12, instanceIndex, true);
  for (let lane = 0; lane < 4; lane += 1) view.setFloat32(offset + 16 + lane * 4, 0, true);
  view.setFloat32(offset + 32, 0, true);
  view.setUint32(offset + 36, 0, true);
  view.setUint32(offset + 40, 0, true);
  view.setUint32(offset + 44, backgroundAvailable ? 1 : 0, true);
}

function surfaceDynamicInputError(expected: string, hint: string): RhiError {
  return new RhiError({ code: 'rhi-descriptor-invalid', expected, hint });
}

function sameDynamicInputLayout(
  actual: MaterialDynamicInputLayout,
  expected: MaterialDynamicInputLayout,
): boolean {
  return (
    actual.identity === expected.identity &&
    actual.name === expected.name &&
    actual.stride === expected.stride &&
    actual.maxRecords === expected.maxRecords &&
    actual.maxDomains === expected.maxDomains &&
    actual.maxPageBytes === expected.maxPageBytes &&
    actual.maxBindings === expected.maxBindings &&
    actual.maxEventsPerSample === expected.maxEventsPerSample &&
    actual.fields.length === expected.fields.length &&
    actual.fields.every((field, index) => {
      const candidate = expected.fields[index];
      return (
        candidate !== undefined &&
        field.name === candidate.name &&
        field.type === candidate.type &&
        field.offset === candidate.offset &&
        field.size === candidate.size &&
        field.alignment === candidate.alignment
      );
    })
  );
}

function invalidSurfaceDynamicRange(
  page: ReadonlyDynamicInputPage,
  range: DynamicInputRange,
  expectedDeviceGeneration: number | undefined,
): string | undefined {
  if (range.sourceId !== page.sourceId || range.pageId !== page.pageId) {
    return 'each Surface dynamic range belongs to the submitted page source and page id';
  }
  if (
    expectedDeviceGeneration !== undefined &&
    range.deviceGeneration !== expectedDeviceGeneration
  ) {
    return 'each Surface dynamic range belongs to the current renderer device generation';
  }
  if (
    range.bufferGeneration !== page.bufferGeneration ||
    range.deviceGeneration !== page.deviceGeneration
  ) {
    return 'each Surface dynamic range belongs to the current page buffer and device generation';
  }
  if (
    !Number.isSafeInteger(range.instanceIndex) ||
    range.instanceIndex < 0 ||
    range.instanceIndex > 0xffffffff
  ) {
    return 'each Surface dynamic range uses an exact unsigned 32-bit instance index';
  }
  if (
    !Number.isSafeInteger(range.recordStart) ||
    !Number.isSafeInteger(range.recordCount) ||
    range.recordStart < 0 ||
    range.recordCount <= 0 ||
    range.recordStart + range.recordCount > page.schema.maxRecords ||
    range.recordCount > page.schema.maxEventsPerSample
  ) {
    return 'each Surface dynamic range stays within the published record and per-sample budgets';
  }
  if (range.byteOffset !== range.recordStart * page.layout.stride) {
    return 'each Surface dynamic range byte offset is derived from the published record stride';
  }
  if (
    !Number.isSafeInteger(range.contentRevision) ||
    range.contentRevision <= 0 ||
    range.contentRevision > page.contentRevision
  ) {
    return 'each Surface dynamic range names a published page content revision';
  }
  return undefined;
}

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

export interface MaterialAbiRasterPipelineInput {
  readonly artifact: MaterialShaderArtifact;
  readonly deformation: 'rigid' | 'skin';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly layoutProjection: MeshGpuHandles['layoutProjection'];
  readonly shaderUvSetCount: number;
  readonly topology: GpuDrivenBatch['key']['topology'];
  readonly stripIndexFormat: 'uint16' | 'uint32' | undefined;
  readonly renderState: MaterialRenderState | undefined;
  readonly additionalColorFormats: readonly TextureFormat[];
  readonly standardTextureMask?: number | undefined;
  readonly forwardColorPass: boolean;
}

/** One request specification for real raster and hidden preparation. */
export function requestMaterialAbiRasterPipeline(
  factory: MaterialPipelineFactory,
  input: MaterialAbiRasterPipelineInput,
) {
  const artifact = input.artifact,
    receipt = artifact.receipt;
  const sceneEntry =
    artifact.fragmentEntry === 'fs_temporal' ? 'vs_temporal' : receipt?.sceneIndexEntry;
  if (sceneEntry === undefined) return null;
  const clustered =
    artifact.program.group2 === 'cluster' || artifact.program.group2 === 'skin-cluster';
  const layoutKind = clustered
    ? input.deformation === 'skin'
      ? 'gpu-driven-cluster-skin'
      : 'gpu-driven-cluster-pbr'
    : input.deformation === 'skin'
      ? 'gpu-driven-skin'
      : 'gpu-driven-pbr';
  return factory(
    artifact.specializationKey ?? artifact.material,
    false,
    gpuDrivenReflectionFallbackRenderState({
      renderState: input.renderState,
      colorFormat: input.format,
      additionalColorFormats: input.additionalColorFormats,
      forwardColorPass: input.forwardColorPass,
      reflectionFallbackOutputAvailable: artifact.reflectionFallbackOutputAvailable === true,
    }),
    input.topology,
    input.stripIndexFormat,
    artifact.variantSet,
    'forward',
    undefined,
    input.sampleCount,
    input.format,
    isCanonicalStandardPbrMaterialShader(artifact.material)
      ? input.shaderUvSetCount
      : (artifact.uvSetCount ?? input.shaderUvSetCount),
    'depth32float-stencil8',
    undefined,
    input.layoutProjection,
    'immediate',
    layoutKind,
    sceneEntry,
    input.additionalColorFormats,
    artifact.vertexEntry,
    artifact.fragmentEntry,
    undefined,
    input.standardTextureMask === undefined
      ? undefined
      : { [STANDARD_TEXTURE_MASK_OVERRIDE]: input.standardTextureMask },
  );
}

export class MaterialAbiRasterAdapter {
  /** Effective fixed entry of this adapter, including its retained factory lane. */
  diagnosticGBufferVertexEntry(artifact: MaterialShaderArtifact): string | undefined {
    return this.pipelineFactory === undefined
      ? (artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry)
      : artifact.receipt?.sceneIndexEntry;
  }

  private readonly pipelines = new Map<string, RenderPipeline>();
  private sceneMeshBinding:
    | {
        readonly transformBuffer: Buffer;
        readonly transformBytes: number;
        readonly paletteBuffer: Buffer | undefined;
        readonly bindGroup: BindGroup;
      }
    | undefined;
  private readonly pendingRetirements = new Set<Buffer>();
  private readonly destroyedBuffers = new WeakSet<Buffer>();
  private disposed = false;
  private visibleWindowBindGroups = new WeakMap<Buffer, Map<string, BindGroup>>();
  readonly visibleWindowCounters = { creates: 0, hits: 0, resets: 0 };

  private resetVisibleWindows(): void {
    this.visibleWindowCounters.resets += 1;
    this.visibleWindowBindGroups = new WeakMap();
  }
  private sceneTables:
    | {
        readonly instanceBuffer: Buffer;
        readonly instanceBytes: number;
        readonly primitiveBuffer: Buffer;
        readonly primitiveBytes: number;
        readonly visibleSurfaceRows: Buffer | undefined;
      }
    | undefined;
  private readonly surfaceInputBuffers = new Set<Buffer>();
  /**
   * Material-raster-owned buffers only. Visible, probe, palette and mesh
   * buffers are supplied by their respective owners and are deliberately not
   * registered here, so the production projection cannot double-count them.
   */
  private readonly allocationTokens = new WeakMap<Buffer, GpuResourceAllocationToken>();
  private readonly allocationLedger: GpuResourceAllocationLedger;
  private dynamicInputPage: ReadonlyDynamicInputPage | undefined;
  private dynamicInputPageGeneration = 0;
  private dynamicInputBuffer: Buffer;
  private dynamicInputBufferSize: number;
  private dynamicFrameBuffer: Buffer;
  private dynamicFrameBufferSize: number;
  private readonly dynamicSharedFrame: SurfaceSharedFrameState;
  private directAddressBuffer: Buffer;
  private directAddressBufferSize: number;
  private readonly directAddresses = new Map<
    string,
    { readonly frameBase: number; readonly instanceCount: number; readonly byteOffset: number }
  >();
  private readonly directBindGroups = new Map<
    string,
    {
      readonly instanceBuffer: Buffer;
      readonly probeBuffer: Buffer;
      readonly addressBuffer: Buffer;
      readonly bindGroup: BindGroup;
    }
  >();
  /** Last successfully queued frame rows, keyed by visible member identity. */
  private readonly dynamicFrameRows = new Map<number, SurfaceFrameRow>();
  private dynamicFrameRangeSource: readonly SurfaceFrameRange[] | undefined;
  private dynamicInputRangeSource: readonly DynamicInputRange[] | undefined;
  private dynamicInputFrameRanges: readonly SurfaceFrameRange[] | undefined;
  private dynamicFrameRangeCapacity = 0;
  private dynamicFrameMemberScans = 0;
  private dynamicFrameRowAllocations = 0;
  private pendingDynamicInputUpload:
    | { readonly page: ReadonlyDynamicInputPage; readonly receipt: DynamicInputUploadReceipt }
    | undefined;

  private constructor(
    private readonly device: RhiDevice,
    private readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout,
    private readonly meshLayout: BindGroupLayout,
    private readonly instancesBindGroupLayout: BindGroupLayout,
    private readonly surfaceDirectInstancesBindGroupLayout: BindGroupLayout | null,
    private readonly programs: ReadonlyMap<string, GpuDrivenPbrProgram> | undefined,
    private instancesBindGroup: BindGroup,
    private readonly instanceBuffer: Buffer,
    private readonly instanceBufferSize: number,
    private visibleBuffer: Buffer,
    private probeBlendRecordBuffer: Buffer | undefined,
    private readonly artifact: MaterialShaderArtifact,
    private readonly deformation: 'rigid' | 'skin',
    private readonly pipelineFactory: MaterialPipelineFactory | undefined,
    private paletteBuffer: Buffer | undefined,
    private paletteBindingWindowBytes: number | undefined,
    dynamicInputBuffer: Buffer,
    dynamicInputFrameBuffer: Buffer,
    dynamicSharedFrame: SurfaceSharedFrameState,
    directAddressBuffer: Buffer,
    ownsDynamicSharedFrame: boolean,
    allocationLedger: GpuResourceAllocationLedger,
  ) {
    this.allocationLedger = allocationLedger;
    this.dynamicInputBuffer = dynamicInputBuffer;
    this.dynamicInputBufferSize = 16;
    this.dynamicFrameBuffer = dynamicInputFrameBuffer;
    this.dynamicFrameBufferSize = SURFACE_FRAME_RECORD_BYTES;
    this.dynamicSharedFrame = dynamicSharedFrame;
    this.directAddressBuffer = directAddressBuffer;
    this.directAddressBufferSize = SURFACE_DIRECT_ADDRESS_STRIDE;
    this.surfaceInputBuffers.add(dynamicInputBuffer);
    this.surfaceInputBuffers.add(dynamicInputFrameBuffer);
    this.surfaceInputBuffers.add(directAddressBuffer);
    if (ownsDynamicSharedFrame) this.surfaceInputBuffers.add(dynamicSharedFrame.buffer);
    this.trackOwnedBuffer(instanceBuffer, instanceBufferSize);
    this.trackOwnedBuffer(dynamicInputBuffer, 16);
    this.trackOwnedBuffer(dynamicInputFrameBuffer, SURFACE_FRAME_RECORD_BYTES);
    this.trackOwnedBuffer(directAddressBuffer, SURFACE_DIRECT_ADDRESS_STRIDE);
    if (ownsDynamicSharedFrame) {
      this.trackOwnedBuffer(dynamicSharedFrame.buffer, SURFACE_SHARED_FRAME_BYTES);
    }
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly pipelineState: PipelineState;
    readonly artifact: MaterialShaderArtifact;
    readonly visibleBuffer: Buffer;
    readonly deformation?: 'rigid' | 'skin';
    readonly paletteBuffer?: Buffer;
    readonly paletteBindingWindowBytes?: number;
    readonly sharedSurfaceFrame?: SurfaceSharedFrameState;
    readonly probeBlendRecordBuffer?: Buffer;
    /** Renderer-owned factory for the selected artifact's actual PSO. */
    readonly pipelineFactory?: MaterialPipelineFactory;
  }): Result<MaterialAbiRasterAdapter, RhiError | GpuDrivenPreparationError> {
    const deformation = input.deformation ?? 'rigid';
    const receipt = input.artifact.receipt;
    if (receipt === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'published MaterialProgramAbi receipt for the selected material artifact',
          hint: 'recook and publish the material before creating a GPU-driven raster owner',
        }),
      );
    }
    const probeBlendRequested = requiresProbeBlendRecord(input.artifact);
    if (probeBlendRequested && input.probeBlendRecordBuffer === undefined) {
      return err(
        new GpuDrivenPreparationError('resource-not-ready', {
          reason: 'material-resource-missing',
          owner: 'material',
          expected: 'the retained ProbeBlend record page for this scene-index program',
          actual: 'no ProbeBlend record page was published for the prepared frame',
          recovery: 'retry-same-draw',
        }),
      );
    }
    const materialRowMatchesSceneTable =
      receipt.materialRow.addressUnitBytes === 16 &&
      receipt.materialRow.byteLength >= 16 &&
      receipt.materialRow.byteLength <= GPU_SCENE_LAYOUTS.material.stride &&
      receipt.materialRow.byteLength % 16 === 0 &&
      new Set(receipt.materialRow.fields).size === receipt.materialRow.fields.length;
    if (!materialRowMatchesSceneTable) {
      return err(
        new GpuDrivenPreparationError('material-abi-not-executable', {
          reason: 'material-abi-not-executable',
          owner: 'material',
          expected: `aligned scene-index material row within ${GPU_SCENE_LAYOUTS.material.stride} bytes with unique producer fields`,
          actual: `row ${receipt.materialRow.byteLength} bytes with fields ${receipt.materialRow.fields.join(',')}`,
        }),
      );
    }
    if (
      receipt.reflection.layoutIdentity !== input.artifact.layoutIdentity ||
      receipt.directEntry.length === 0 ||
      !receipt.sceneIndexEntry ||
      receipt.resourceSlots.some((slot) => slot.group !== 1)
    ) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: `complete selected MaterialProgramAbi reflection, scene row stride ${GPU_SCENE_LAYOUTS.material.stride}, and resource slots`,
          hint: 'repair the producer publication or use the owner for its non-scene material layout',
        }),
      );
    }
    // Scene-index shaders declare the dedicated slot-3 ABI. Keep the legacy
    // fields as a compatibility fallback for synthetic fixtures; the real
    // factory publishes the dedicated handles whenever the capable storage
    // lane is enabled, so production draws never bind the direct-draw BGL.
    const pipelineLayout =
      deformation === 'skin'
        ? input.pipelineState.gpuDrivenPbrSkinPipelineLayout
        : input.pipelineState.gpuDrivenPbrPipelineLayout;
    const instancesBindGroupLayout = input.pipelineState.gpuDrivenInstancesBindGroupLayout;
    if (pipelineLayout == null || instancesBindGroupLayout == null) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `${deformation === 'skin' ? 'skinned ' : ''}published material pipeline layout`,
          hint: 'initialize the producer material pipeline before enabling GPU-driven raster',
        }),
      );
    }
    const programs = input.pipelineState.gpuDrivenPbrPrograms;
    if (
      input.pipelineFactory === undefined &&
      (programs === undefined ||
        resolveStandardPbrProgram(
          programs,
          input.artifact.material,
          input.artifact.receipt?.vertexInputs.some((attribute) => attribute.semantic === 'color'),
        ) === undefined)
    ) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `producer-owned ${deformation === 'skin' ? 'skinned ' : ''}material shader module for the current device generation`,
          hint: 'publish the selected material module from buildReadyWebGPU before enabling GPU-driven raster',
        }),
      );
    }
    const meshLayout =
      deformation === 'skin'
        ? input.pipelineState.pbrSkinMeshBindGroupLayout
        : input.pipelineState.meshBindGroupLayout;
    if (meshLayout === null) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `${deformation === 'skin' ? 'skinned ' : ''}material mesh bind-group layout`,
          hint: 'publish the exact mesh-array layout selected by the material receipt',
        }),
      );
    }
    if (
      deformation === 'skin' &&
      (input.paletteBuffer === undefined || input.paletteBindingWindowBytes === undefined)
    ) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'persistent skin palette buffer and binding window',
          hint: 'keep the palette receipt and the GPU-driven skinned projection on one frame identity',
        }),
      );
    }
    const identity = new Float32Array(16);
    identity[0] = 1;
    identity[5] = 1;
    identity[10] = 1;
    identity[15] = 1;
    const instancePayload = packInstanceStorageBuffer(identity);
    const createdBuffers: Buffer[] = [];
    const cleanupCreatedBuffers = (): void => {
      for (const buffer of createdBuffers) input.device.destroyBuffer(buffer);
      createdBuffers.length = 0;
    };
    const instanceBuffer = input.device.createBuffer({
      label: 'standard-pbr-gpu-driven-instance-data',
      size: instancePayload.byteLength,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!instanceBuffer.ok) return instanceBuffer;
    createdBuffers.push(instanceBuffer.value);
    const instanceWrite = input.device.queue.writeBuffer(instanceBuffer.value, 0, instancePayload);
    if (!instanceWrite.ok) {
      cleanupCreatedBuffers();
      return instanceWrite;
    }
    const dynamicInputBuffer = input.device.createBuffer({
      label: 'surface-dynamic-input-page',
      size: 16,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!dynamicInputBuffer.ok) {
      cleanupCreatedBuffers();
      return dynamicInputBuffer;
    }
    createdBuffers.push(dynamicInputBuffer.value);
    const dynamicInputWrite = input.device.queue.writeBuffer(
      dynamicInputBuffer.value,
      0,
      new Uint32Array(4),
    );
    if (!dynamicInputWrite.ok) {
      cleanupCreatedBuffers();
      return dynamicInputWrite;
    }
    const dynamicFrameBuffer = input.device.createBuffer({
      label: 'surface-dynamic-frame-input',
      size: SURFACE_FRAME_RECORD_BYTES,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!dynamicFrameBuffer.ok) {
      cleanupCreatedBuffers();
      return dynamicFrameBuffer;
    }
    createdBuffers.push(dynamicFrameBuffer.value);
    const dynamicFramePayload = new Uint8Array(SURFACE_FRAME_RECORD_BYTES);
    writeSurfaceFrameRecord(new DataView(dynamicFramePayload.buffer), 0, 0, 0, 0);
    const dynamicFrameWrite = input.device.queue.writeBuffer(
      dynamicFrameBuffer.value,
      0,
      dynamicFramePayload,
    );
    if (!dynamicFrameWrite.ok) {
      cleanupCreatedBuffers();
      return dynamicFrameWrite;
    }
    const directAddressBuffer = input.device.createBuffer({
      label: 'surface-direct-addresses',
      size: SURFACE_DIRECT_ADDRESS_STRIDE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!directAddressBuffer.ok) {
      cleanupCreatedBuffers();
      return directAddressBuffer;
    }
    createdBuffers.push(directAddressBuffer.value);
    const directAddressWrite = input.device.queue.writeBuffer(
      directAddressBuffer.value,
      0,
      new Uint32Array(4),
    );
    if (!directAddressWrite.ok) {
      cleanupCreatedBuffers();
      return directAddressWrite;
    }
    let ownsDynamicSharedFrame = false;
    let dynamicSharedFrame = input.sharedSurfaceFrame;
    if (dynamicSharedFrame === undefined) {
      const created = input.device.createBuffer({
        label: 'surface-dynamic-shared-frame-input',
        size: SURFACE_SHARED_FRAME_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      });
      if (!created.ok) {
        cleanupCreatedBuffers();
        return created;
      }
      createdBuffers.push(created.value);
      const initialized = input.device.queue.writeBuffer(created.value, 0, new Float32Array(4));
      if (!initialized.ok) {
        cleanupCreatedBuffers();
        return initialized;
      }
      dynamicSharedFrame = { buffer: created.value, frameTime: 0, writes: 0 };
      ownsDynamicSharedFrame = true;
    }
    const instancesBindGroup = input.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-visible-instances-bg',
      layout: instancesBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: bufferBinding(instanceBuffer.value, 0, instancePayload.byteLength),
        },
        {
          binding: 1,
          resource: bufferBinding(input.probeBlendRecordBuffer ?? input.visibleBuffer),
        },
        {
          binding: 2,
          resource: bufferBinding(input.visibleBuffer),
        },
        { binding: 3, resource: bufferBinding(dynamicInputBuffer.value) },
        { binding: 4, resource: bufferBinding(dynamicFrameBuffer.value) },
        { binding: 5, resource: bufferBinding(dynamicSharedFrame.buffer) },
        // Frame-level placeholder; scene-index draws bind visible windows.
        {
          binding: 6,
          resource: bufferBinding(instanceBuffer.value, 0, instancePayload.byteLength),
        },
        { binding: 7, resource: bufferBinding(input.visibleBuffer) },
      ],
    });
    if (!instancesBindGroup.ok) {
      cleanupCreatedBuffers();
      return instancesBindGroup;
    }
    const allocationLedger = new GpuResourceAllocationLedger();
    return ok(
      new MaterialAbiRasterAdapter(
        input.device,
        pipelineLayout,
        meshLayout,
        instancesBindGroupLayout,
        input.pipelineState.surfaceDirectInstancesBindGroupLayout ?? null,
        programs,
        instancesBindGroup.value,
        instanceBuffer.value,
        instancePayload.byteLength,
        input.visibleBuffer,
        input.probeBlendRecordBuffer,
        input.artifact,
        deformation,
        input.pipelineFactory,
        input.paletteBuffer,
        input.paletteBindingWindowBytes,
        dynamicInputBuffer.value,
        dynamicFrameBuffer.value,
        dynamicSharedFrame,
        directAddressBuffer.value,
        ownsDynamicSharedFrame,
        allocationLedger,
      ),
    );
  }

  ensurePaletteBuffer(
    paletteBuffer: Buffer | undefined,
    paletteBindingWindowBytes: number | undefined,
  ): Result<void, RhiError> {
    if (this.deformation !== 'skin') return ok(undefined);
    if (paletteBuffer === undefined || paletteBindingWindowBytes === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'persistent skin palette buffer and binding window',
          hint: 'publish a storage-backed SkinPaletteReceipt before the GPU-driven skinned lane',
        }),
      );
    }
    this.paletteBuffer = paletteBuffer;
    this.paletteBindingWindowBytes = paletteBindingWindowBytes;
    return ok(undefined);
  }

  skinPaletteBinding():
    | { readonly buffer: Buffer; readonly bindingWindowBytes: number }
    | undefined {
    return this.deformation === 'skin' &&
      this.paletteBuffer !== undefined &&
      this.paletteBindingWindowBytes !== undefined
      ? { buffer: this.paletteBuffer, bindingWindowBytes: this.paletteBindingWindowBytes }
      : undefined;
  }

  ensureVisibleBuffer(visibleBuffer: Buffer): Result<void, RhiError> {
    if (this.visibleBuffer === visibleBuffer) return ok(undefined);
    const created = this.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-visible-instances-bg',
      layout: this.instancesBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize),
        },
        { binding: 1, resource: bufferBinding(this.probeBlendRecordBuffer ?? visibleBuffer) },
        { binding: 2, resource: bufferBinding(visibleBuffer) },
        { binding: 3, resource: bufferBinding(this.dynamicInputBuffer) },
        { binding: 4, resource: bufferBinding(this.dynamicFrameBuffer) },
        { binding: 5, resource: bufferBinding(this.dynamicSharedFrame.buffer) },
        { binding: 6, resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize) },
        {
          binding: 7,
          resource: bufferBinding(this.sceneTables?.visibleSurfaceRows ?? this.visibleBuffer),
        },
      ],
    });
    if (!created.ok) return created;
    this.instancesBindGroup = created.value;
    this.visibleBuffer = visibleBuffer;
    return ok(undefined);
  }

  ensureProbeBlendRecordBuffer(buffer: Buffer | undefined): Result<void, RhiError> {
    if (buffer === undefined || buffer === this.probeBlendRecordBuffer) return ok(undefined);
    this.probeBlendRecordBuffer = buffer;
    const rebound = this.rebuildInstancesBindGroup();
    if (!rebound.ok) return rebound;
    this.resetVisibleWindows();
    this.directBindGroups.clear();
    return ok(undefined);
  }

  /**
   * Bind the GPU Scene instance and primitive tables that scene-index vertex
   * stages resolve `visibleItems.x` against. Cached visible windows are
   * rebuilt only when either table buffer is replaced.
   */
  ensureSceneTables(
    instanceBuffer: Buffer,
    instanceBytes: number,
    primitiveBuffer: Buffer,
    primitiveBytes: number,
    visibleSurfaceRows?: Buffer,
  ): void {
    const current = this.sceneTables;
    if (
      current?.instanceBuffer === instanceBuffer &&
      current.instanceBytes === instanceBytes &&
      current.primitiveBuffer === primitiveBuffer &&
      current.primitiveBytes === primitiveBytes &&
      current.visibleSurfaceRows === visibleSurfaceRows
    ) {
      return;
    }
    this.sceneTables = {
      instanceBuffer,
      instanceBytes,
      primitiveBuffer,
      primitiveBytes,
      visibleSurfaceRows,
    };
    this.resetVisibleWindows();
  }

  /** Identity of the physical resources behind every visible-window binding. */
  get visibleBindingIdentity(): object {
    return this.visibleWindowBindGroups;
  }

  visibleWindowBindGroup(
    visibleBase: number,
    visibleCapacity: number,
  ): Result<BindGroup, RhiError> {
    return this.visibleWindowBindGroupForBuffer(this.visibleBuffer, visibleBase, visibleCapacity);
  }

  visibleWindowBindGroupForBuffer(
    visibleBuffer: Buffer,
    visibleBase: number,
    visibleCapacity: number,
    shadowVisibleAlias = false,
  ): Result<BindGroup, RhiError> {
    const offset = visibleBase * 16;
    const size = visibleCapacity * 16;
    if (offset % 256 !== 0 || size <= 0) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: '256-byte-aligned non-empty visible window',
          hint: `allocate each GPU-driven batch visible window on the portable storage-buffer boundary (base=${visibleBase}, capacity=${visibleCapacity}, offset=${offset}, size=${size})`,
        }),
      );
    }
    const sceneTables = this.sceneTables;
    if (sceneTables === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GPU Scene instance and primitive tables before a scene-index visible window',
          hint: 'call ensureSceneTables with the frame GPU Scene before binding visible windows',
        }),
      );
    }
    let groups = this.visibleWindowBindGroups.get(visibleBuffer);
    if (groups === undefined) {
      groups = new Map();
      this.visibleWindowBindGroups.set(visibleBuffer, groups);
    }
    // The view finalizer writes the absolute visible row into firstInstance
    // on capable devices, so all batches share this physical binding.
    const wholeVisibleBuffer = this.device.caps.firstInstanceIndirect;
    const key = wholeVisibleBuffer
      ? shadowVisibleAlias
        ? 'shadow'
        : 'main'
      : `${visibleBase}:${visibleCapacity}:${shadowVisibleAlias ? 'shadow' : 'main'}`;
    const cached = groups.get(key);
    if (cached !== undefined) {
      this.visibleWindowCounters.hits += 1;
      return ok(cached);
    }
    const created = this.device.createBindGroup({
      label: `standard-pbr-gpu-driven-visible-window-${visibleBase}`,
      layout: this.instancesBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: bufferBinding(sceneTables.instanceBuffer, 0, sceneTables.instanceBytes),
        },
        {
          binding: 1,
          resource:
            shadowVisibleAlias || this.probeBlendRecordBuffer === undefined
              ? wholeVisibleBuffer
                ? bufferBinding(visibleBuffer)
                : bufferBinding(visibleBuffer, offset, size)
              : bufferBinding(this.probeBlendRecordBuffer),
        },
        {
          binding: 2,
          resource: wholeVisibleBuffer
            ? bufferBinding(visibleBuffer)
            : bufferBinding(visibleBuffer, offset, size),
        },
        { binding: 3, resource: bufferBinding(this.dynamicInputBuffer) },
        // Surface frame rows are keyed by view candidate row: bind whole.
        { binding: 4, resource: bufferBinding(this.dynamicFrameBuffer) },
        { binding: 5, resource: bufferBinding(this.dynamicSharedFrame.buffer) },
        {
          binding: 6,
          resource: bufferBinding(sceneTables.primitiveBuffer, 0, sceneTables.primitiveBytes),
        },
        { binding: 7, resource: bufferBinding(sceneTables.visibleSurfaceRows ?? visibleBuffer) },
      ],
    });
    if (!created.ok) return created;
    this.visibleWindowCounters.creates += 1;
    groups.set(key, created.value);
    return ok(created.value);
  }

  shadowVisibleWindowBindGroupForBuffer(
    visibleBuffer: Buffer,
    visibleBase: number,
    visibleCapacity: number,
  ): Result<BindGroup, RhiError> {
    return this.visibleWindowBindGroupForBuffer(visibleBuffer, visibleBase, visibleCapacity, true);
  }

  private ensureDirectSurfaceAddresses(
    frameRanges: readonly SurfaceFrameRange[],
  ): Result<void, RhiError> {
    const members = new Map<string, SurfaceFrameRange[]>();
    for (const entry of frameRanges) {
      const member = entry.directMember;
      if (member === undefined) continue;
      const key = JSON.stringify([member.worldId, member.entityKey, member.drawItemIndex]);
      const group = members.get(key);
      if (group === undefined) members.set(key, [entry]);
      else group.push(entry);
    }
    const addresses = new Map<
      string,
      { readonly frameBase: number; readonly instanceCount: number; readonly byteOffset: number }
    >();
    const memberCount = [...members.values()].reduce((count, group) => count + group.length, 0);
    const payload = new Uint8Array(Math.max(1, memberCount) * SURFACE_DIRECT_ADDRESS_STRIDE);
    const view = new DataView(payload.buffer);
    let addressIndex = 0;
    for (const [key, group] of members) {
      group.sort(
        (left, right) =>
          (left.directMember?.instanceOrdinal ?? 0) - (right.directMember?.instanceOrdinal ?? 0),
      );
      const first = group[0];
      const firstMember = first?.directMember;
      if (first === undefined || firstMember === undefined) continue;
      const frameBase = first.frameIndex - firstMember.instanceOrdinal;
      if (
        frameBase < 0 ||
        group.some(
          (entry, ordinal) =>
            entry.directMember?.instanceOrdinal !== ordinal ||
            entry.frameIndex !== frameBase + ordinal,
        )
      ) {
        return err(
          surfaceDynamicInputError(
            'each direct Surface draw has contiguous local instance ordinals and one frame-row base',
            `rebuild the retained member projection for draw ${key}`,
          ),
        );
      }
      for (let ordinal = 0; ordinal < group.length; ordinal += 1) {
        const byteOffset = addressIndex * SURFACE_DIRECT_ADDRESS_STRIDE;
        view.setUint32(byteOffset, frameBase + ordinal, true);
        view.setUint32(byteOffset + 4, group.length - ordinal, true);
        addresses.set(`${key}:${ordinal}`, {
          frameBase: frameBase + ordinal,
          instanceCount: group.length - ordinal,
          byteOffset,
        });
        addressIndex += 1;
      }
    }
    const replacementSize = Math.max(this.directAddressBufferSize, payload.byteLength);
    const replacement = this.device.createBuffer({
      label: 'surface-direct-addresses',
      size: replacementSize,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!replacement.ok) return replacement;
    this.trackOwnedBuffer(replacement.value, replacementSize);
    const write = this.device.queue.writeBuffer(replacement.value, 0, payload);
    if (!write.ok) {
      this.rollbackOwnedBuffer(replacement.value);
      return write;
    }
    const previous = this.directAddressBuffer;
    this.directAddressBuffer = replacement.value;
    this.directAddressBufferSize = replacementSize;
    this.directAddresses.clear();
    for (const [key, address] of addresses) this.directAddresses.set(key, address);
    this.directBindGroups.clear();
    this.surfaceInputBuffers.add(replacement.value);
    this.surfaceInputBuffers.delete(previous);
    this.retireOwnedBuffer(previous);
    return ok(undefined);
  }

  directSurfaceInstances(input: {
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceCount: number;
    readonly firstInstanceOrdinal?: number;
    readonly instanceBuffer: Buffer;
    readonly probeBuffer?: Buffer;
    readonly probeOffset?: number;
  }): Result<
    {
      readonly bindGroup: BindGroup;
      readonly dynamicOffsets: readonly number[];
      readonly frameBase: number;
    },
    RhiError
  > {
    const layout = this.surfaceDirectInstancesBindGroupLayout;
    if (layout === null) {
      return err(
        surfaceDynamicInputError(
          'the current device publishes the direct Surface slot-3 layout',
          'keep the draw on recovery until the storage-backed Surface ABI is ready',
        ),
      );
    }
    const drawKey = JSON.stringify([input.worldId, input.entityKey, input.drawItemIndex]);
    const firstInstanceOrdinal = input.firstInstanceOrdinal ?? 0;
    const key = `${drawKey}:${firstInstanceOrdinal}`;
    const address = this.directAddresses.get(key);
    if (address === undefined || address.instanceCount < input.instanceCount) {
      return err(
        surfaceDynamicInputError(
          'the direct Surface draw resolves one retained frame base with the same instance count',
          `rebuild the producer projection for draw ${drawKey} at ordinal ${firstInstanceOrdinal} (instances=${input.instanceCount})`,
        ),
      );
    }
    const probeOffset = input.probeOffset ?? 0;
    if (!Number.isSafeInteger(probeOffset) || probeOffset < 0) {
      return err(
        surfaceDynamicInputError(
          'the direct Surface Probe offset is a non-negative safe integer',
          'discard the draw and rebuild its producer-owned Probe binding before retrying',
        ),
      );
    }
    const retainedProbeBuffer = input.probeBuffer ?? this.probeBlendRecordBuffer;
    if (probeOffset !== 0 && retainedProbeBuffer === undefined) {
      return err(
        surfaceDynamicInputError(
          'a non-zero direct Surface Probe offset has its matched producer Probe buffer',
          'forward the producer Probe buffer with the direct draw or use a zero Probe offset',
        ),
      );
    }
    const probeBuffer = retainedProbeBuffer ?? this.dynamicInputBuffer;
    const cached = this.directBindGroups.get(key);
    if (
      cached !== undefined &&
      cached.instanceBuffer === input.instanceBuffer &&
      cached.probeBuffer === probeBuffer &&
      cached.addressBuffer === this.directAddressBuffer
    ) {
      return ok({
        bindGroup: cached.bindGroup,
        dynamicOffsets: [probeOffset],
        frameBase: address.frameBase,
      });
    }
    const created = this.device.createBindGroup({
      label: `surface-direct-instances-${input.worldId}-${input.entityKey}-${input.drawItemIndex}`,
      layout,
      entries: [
        { binding: 0, resource: bufferBinding(input.instanceBuffer) },
        {
          binding: 1,
          resource: bufferBinding(
            probeBuffer,
            0,
            retainedProbeBuffer === undefined ? 16 : PROBE_BLEND_RECORD_BYTE_SIZE,
          ),
        },
        { binding: 3, resource: bufferBinding(this.dynamicInputBuffer) },
        { binding: 4, resource: bufferBinding(this.dynamicFrameBuffer) },
        { binding: 5, resource: bufferBinding(this.dynamicSharedFrame.buffer) },
        {
          binding: 6,
          resource: bufferBinding(
            this.directAddressBuffer,
            address.byteOffset,
            SURFACE_SHARED_FRAME_BYTES,
          ),
        },
      ],
    });
    if (!created.ok) return created;
    this.directBindGroups.set(key, {
      instanceBuffer: input.instanceBuffer,
      probeBuffer,
      addressBuffer: this.directAddressBuffer,
      bindGroup: created.value,
    });
    return ok({
      bindGroup: created.value,
      dynamicOffsets: [probeOffset],
      frameBase: address.frameBase,
    });
  }

  /**
   * Upload the generic Surface page and frame/range records through the same
   * prepared GPU-driven owner that binds instances and visible rows.
   */
  ensureSurfaceDynamicInput(
    frame: SurfaceDynamicInputFrame | undefined,
    recordCapacity: number,
    frameTime = frame?.frameTime ?? 0,
    expectedLayout?: MaterialDynamicInputLayout,
    expectedDeviceGeneration?: number,
    frameRanges?: readonly SurfaceFrameRange[],
  ): Result<void, RhiError> {
    this.pendingDynamicInputUpload = undefined;
    if (!Number.isFinite(frameTime)) {
      return err(
        surfaceDynamicInputError(
          'the frame-time snapshot is finite',
          'pass the World/App time snapshot to the Render owner',
        ),
      );
    }
    if (!Number.isSafeInteger(recordCapacity) || recordCapacity <= 0) {
      return err(
        surfaceDynamicInputError(
          'the GPU-driven Surface frame capacity is a positive safe integer',
          'prepare the frame from the bounded RenderScene batch capacity',
        ),
      );
    }
    const page = frame?.page;
    if (expectedLayout === undefined && page !== undefined) {
      return err(
        surfaceDynamicInputError(
          'a dynamic input page is supplied only when the published Surface ABI declares one',
          'remove the page or recook the material with its dynamicInput declaration',
        ),
      );
    }
    if (expectedLayout !== undefined && page === undefined) {
      return err(
        surfaceDynamicInputError(
          'the published Surface ABI dynamicInput page is present for this draw',
          'publish the renderer-owned page before preparing the Surface draw',
        ),
      );
    }
    const ranges = frame?.ranges ?? [];
    let compactFrameRanges = frameRanges;
    if (compactFrameRanges === undefined) {
      if (ranges === this.dynamicInputRangeSource && this.dynamicInputFrameRanges !== undefined) {
        compactFrameRanges = this.dynamicInputFrameRanges;
      } else {
        compactFrameRanges = Object.freeze(
          ranges.map(
            (range) => ({ frameIndex: range.instanceIndex, range }) satisfies SurfaceFrameRange,
          ),
        );
        this.dynamicInputRangeSource = ranges;
        this.dynamicInputFrameRanges = compactFrameRanges;
      }
    }
    const frameRangesChanged = compactFrameRanges !== this.dynamicFrameRangeSource;
    if (frameRangesChanged) {
      const frameIndices = new Set<number>();
      for (const entry of compactFrameRanges) {
        if (!Number.isSafeInteger(entry.frameIndex) || entry.frameIndex < 0) {
          return err(
            surfaceDynamicInputError(
              'every renderer-owned Surface frame index is a non-negative safe integer',
              'derive the visible-member row from the retained GPU Scene window',
            ),
          );
        }
        if (frameIndices.has(entry.frameIndex)) {
          return err(
            surfaceDynamicInputError(
              'each Surface frame row has one renderer-owned visible member',
              'repair the filtered scene-index membership before encoding the frame',
            ),
          );
        }
        frameIndices.add(entry.frameIndex);
        if (entry.range !== undefined && !ranges.includes(entry.range)) {
          return err(
            surfaceDynamicInputError(
              'each Surface row references a range from the submitted frame',
              'derive the visible-member mapping from the same SurfaceDynamicInputFrame instance',
            ),
          );
        }
      }
    }
    let uploaded: DynamicInputUploadReceipt | undefined;
    if (page !== undefined) {
      if (!sameDynamicInputLayout(page.layout, expectedLayout ?? page.layout)) {
        return err(
          surfaceDynamicInputError(
            'the submitted Surface dynamic page matches the cooked MaterialProgramAbi layout',
            'recreate the page from the published dynamicInput layout before drawing',
          ),
        );
      }
      if (
        expectedDeviceGeneration !== undefined &&
        page.deviceGeneration !== expectedDeviceGeneration
      ) {
        return err(
          surfaceDynamicInputError(
            'the submitted Surface dynamic page belongs to the current renderer device generation',
            'reconfigure the page and retry after device recovery',
          ),
        );
      }
      if (
        page.bytes.byteLength !== page.schema.maxPageBytes ||
        page.layout.stride * page.schema.maxRecords > page.bytes.byteLength
      ) {
        return err(
          surfaceDynamicInputError(
            'the dynamic page byte length covers its derived bounded record layout',
            'recreate the page through ReadonlyDynamicInputPage.create()',
          ),
        );
      }
      const begun = page.beginUpload();
      if (!begun.ok) {
        return err(
          surfaceDynamicInputError(
            'a live Surface dynamic input page can produce an upload receipt',
            begun.error.hint,
          ),
        );
      }
      uploaded = begun.value;
    }
    if (frameRangesChanged) {
      const rangeAddresses = new Set<number>();
      for (const range of ranges) {
        if (page === undefined) {
          return err(
            surfaceDynamicInputError(
              'Surface dynamic ranges are paired with their renderer-owned page',
              'provide the page that owns the submitted ranges',
            ),
          );
        }
        const invalidRange = invalidSurfaceDynamicRange(page, range, expectedDeviceGeneration);
        if (invalidRange !== undefined) {
          return err(
            surfaceDynamicInputError(
              'every Surface dynamic range matches the published page schema and generation',
              invalidRange,
            ),
          );
        }
        if (rangeAddresses.has(range.instanceIndex)) {
          return err(
            surfaceDynamicInputError(
              'each Surface dynamic instance address has one unambiguous record range',
              'merge duplicate ranges before publishing the frame projection',
            ),
          );
        }
        rangeAddresses.add(range.instanceIndex);
      }
      const directAddresses = this.ensureDirectSurfaceAddresses(compactFrameRanges);
      if (!directAddresses.ok) return directAddresses;
    }
    const pageChanged = page !== undefined && page !== this.dynamicInputPage;
    const pageGenerationChanged =
      page !== undefined && page.bufferGeneration !== this.dynamicInputPageGeneration;
    if (page !== undefined) {
      const requiredBytes = Math.max(16, page.bytes.byteLength);
      const maxStorageBufferBindingSize = this.device.limits.maxStorageBufferBindingSize;
      if (
        Number.isFinite(maxStorageBufferBindingSize) &&
        requiredBytes > maxStorageBufferBindingSize
      ) {
        return err(
          new RhiError({
            code: 'limit-exceeded',
            expected: 'the Surface dynamic page fits maxStorageBufferBindingSize',
            hint: 'reduce the published dynamic page budget before entering the GPU lane',
            detail: { maxStorageBufferBindingSize, requestedBytes: requiredBytes },
          }),
        );
      }
      if (requiredBytes > this.dynamicInputBufferSize || pageChanged || pageGenerationChanged) {
        const replacement = this.device.createBuffer({
          label: 'surface-dynamic-input-page',
          size: requiredBytes,
          usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
        });
        if (!replacement.ok) return replacement;
        this.trackOwnedBuffer(replacement.value, requiredBytes);
        const initialWrite = this.device.queue.writeBuffer(replacement.value, 0, page.bytes);
        if (!initialWrite.ok) {
          this.rollbackOwnedBuffer(replacement.value);
          return initialWrite;
        }
        const previous = this.dynamicInputBuffer;
        const previousSize = this.dynamicInputBufferSize;
        const previousPage = this.dynamicInputPage;
        const previousGeneration = this.dynamicInputPageGeneration;
        this.dynamicInputBuffer = replacement.value;
        this.dynamicInputBufferSize = requiredBytes;
        this.dynamicInputPage = page;
        this.dynamicInputPageGeneration = page.bufferGeneration;
        this.surfaceInputBuffers.add(replacement.value);
        const rebound = this.rebuildInstancesBindGroup();
        if (!rebound.ok) {
          this.dynamicInputBuffer = previous;
          this.dynamicInputBufferSize = previousSize;
          this.dynamicInputPage = previousPage;
          this.dynamicInputPageGeneration = previousGeneration;
          this.surfaceInputBuffers.delete(replacement.value);
          this.rollbackOwnedBuffer(replacement.value);
          return rebound;
        }
        this.resetVisibleWindows();
        this.directBindGroups.clear();
        this.retireOwnedBuffer(previous);
      } else {
        for (const range of uploaded?.ranges ?? []) {
          const write = this.device.queue.writeBuffer(
            this.dynamicInputBuffer,
            range.byteStart,
            page.bytes.slice(range.byteStart, range.byteEnd),
          );
          if (!write.ok) return write;
        }
        this.dynamicInputPage = page;
        this.dynamicInputPageGeneration = page.bufferGeneration;
      }
      this.pendingDynamicInputUpload =
        uploaded === undefined ? undefined : { page, receipt: uploaded };
    }

    const compactRangeCapacity = frameRangesChanged
      ? compactFrameRanges.reduce((capacity, entry) => Math.max(capacity, entry.frameIndex + 1), 0)
      : this.dynamicFrameRangeCapacity;
    const capacity = Math.max(1, recordCapacity, compactRangeCapacity);
    if (capacity > Number.MAX_SAFE_INTEGER / SURFACE_FRAME_RECORD_BYTES) {
      return err(
        surfaceDynamicInputError(
          'the Surface frame record allocation fits the JavaScript safe integer range',
          'reduce the explicit instance address range before preparing the frame',
        ),
      );
    }
    const requiredFrameBytes = capacity * SURFACE_FRAME_RECORD_BYTES;
    const maxStorageBufferBindingSize = this.device.limits.maxStorageBufferBindingSize;
    if (
      Number.isFinite(maxStorageBufferBindingSize) &&
      requiredFrameBytes > maxStorageBufferBindingSize
    ) {
      return err(
        new RhiError({
          code: 'limit-exceeded',
          expected: 'the Surface frame records fit maxStorageBufferBindingSize',
          hint: 'reduce the explicit instance address range or the batch capacity',
          detail: { maxStorageBufferBindingSize, requestedBytes: requiredFrameBytes },
        }),
      );
    }
    let frameBufferReplaced = false;
    if (requiredFrameBytes > this.dynamicFrameBufferSize) {
      const replacement = this.device.createBuffer({
        label: 'surface-dynamic-frame-input',
        size: requiredFrameBytes,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      });
      if (!replacement.ok) return replacement;
      this.trackOwnedBuffer(replacement.value, requiredFrameBytes);
      const previous = this.dynamicFrameBuffer;
      const previousSize = this.dynamicFrameBufferSize;
      this.dynamicFrameBuffer = replacement.value;
      this.dynamicFrameBufferSize = requiredFrameBytes;
      this.surfaceInputBuffers.add(replacement.value);
      const rebound = this.rebuildInstancesBindGroup();
      if (!rebound.ok) {
        this.dynamicFrameBuffer = previous;
        this.dynamicFrameBufferSize = previousSize;
        this.surfaceInputBuffers.delete(replacement.value);
        this.rollbackOwnedBuffer(replacement.value);
        return rebound;
      }
      this.resetVisibleWindows();
      this.directBindGroups.clear();
      this.retireOwnedBuffer(previous);
      this.dynamicFrameRows.clear();
      this.dynamicFrameRangeSource = undefined;
      frameBufferReplaced = true;
    }

    if (frameTime !== this.dynamicSharedFrame.frameTime) {
      const payload = new Float32Array(4);
      payload[0] = frameTime;
      const write = this.device.queue.writeBuffer(this.dynamicSharedFrame.buffer, 0, payload);
      if (!write.ok) return write;
      this.dynamicSharedFrame.frameTime = frameTime;
      this.dynamicSharedFrame.writes += 1;
    }

    if (!frameBufferReplaced && !frameRangesChanged) {
      return ok(undefined);
    }

    const desiredFrameRows = new Map<number, SurfaceFrameRow>();
    for (const entry of compactFrameRanges) {
      this.dynamicFrameMemberScans += 1;
      desiredFrameRows.set(entry.frameIndex, {
        eventRangeStart: entry.range?.recordStart ?? 0,
        eventRangeCount: entry.range?.recordCount ?? 0,
        instanceIndex: entry.range?.instanceIndex ?? 0,
        // A Surface submission is prepared only for the typed medium graph,
        // whose Standard producer has already published the sampled raw-depth
        // pair. Keep this bit in the frame ABI so the shader consumes the
        // graph-paired resources rather than interpreting zero facts as a
        // zero optical path.
        backgroundAvailable: true,
      });
    }
    // A compact index can disappear when visibility or LOD changes. Clear
    // the old row while its buffer still exists so a reused visible window
    // cannot observe the prior event range. The zero row is retained in the
    // CPU cache and therefore costs one write only at retirement.
    for (const [frameIndex] of this.dynamicFrameRows) {
      if (desiredFrameRows.has(frameIndex)) continue;
      if ((frameIndex + 1) * SURFACE_FRAME_RECORD_BYTES > this.dynamicFrameBufferSize) {
        continue;
      }
      desiredFrameRows.set(frameIndex, {
        eventRangeStart: 0,
        eventRangeCount: 0,
        instanceIndex: 0,
        backgroundAvailable: false,
      });
    }
    for (const [frameIndex, row] of desiredFrameRows) {
      const previous = this.dynamicFrameRows.get(frameIndex);
      if (!frameBufferReplaced && previous !== undefined && sameSurfaceFrameRow(previous, row))
        continue;
      const payload = new Uint8Array(SURFACE_FRAME_RECORD_BYTES);
      this.dynamicFrameRowAllocations += 1;
      writeSurfaceFrameRecord(
        new DataView(payload.buffer),
        0,
        0,
        row.eventRangeStart,
        row.eventRangeCount,
        row.instanceIndex,
        row.backgroundAvailable,
      );
      const frameWrite = this.device.queue.writeBuffer(
        this.dynamicFrameBuffer,
        frameIndex * SURFACE_FRAME_RECORD_BYTES,
        payload,
      );
      if (!frameWrite.ok) return frameWrite;
      this.dynamicFrameRows.set(frameIndex, row);
    }
    this.dynamicFrameRangeSource = compactFrameRanges;
    this.dynamicFrameRangeCapacity = compactRangeCapacity;
    return ok(undefined);
  }

  commitSurfaceDynamicInput(): Result<void, RhiError> {
    if (this.pendingDynamicInputUpload === undefined) return ok(undefined);
    const { page, receipt } = this.pendingDynamicInputUpload;
    const committed = page.commitUpload(receipt);
    if (!committed.ok) {
      return err(
        surfaceDynamicInputError(
          'the Surface dynamic page upload remains current through every queue write',
          committed.error.hint,
        ),
      );
    }
    this.pendingDynamicInputUpload = undefined;
    return ok(undefined);
  }

  abortSurfaceDynamicInput(): void {
    this.pendingDynamicInputUpload = undefined;
  }

  private rebuildInstancesBindGroup(): Result<void, RhiError> {
    const created = this.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-visible-instances-bg',
      layout: this.instancesBindGroupLayout,
      entries: [
        { binding: 0, resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize) },
        {
          binding: 1,
          resource: bufferBinding(this.probeBlendRecordBuffer ?? this.visibleBuffer),
        },
        { binding: 2, resource: bufferBinding(this.visibleBuffer) },
        { binding: 3, resource: bufferBinding(this.dynamicInputBuffer) },
        { binding: 4, resource: bufferBinding(this.dynamicFrameBuffer) },
        { binding: 5, resource: bufferBinding(this.dynamicSharedFrame.buffer) },
        { binding: 6, resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize) },
        {
          binding: 7,
          resource: bufferBinding(this.sceneTables?.visibleSurfaceRows ?? this.visibleBuffer),
        },
      ],
    });
    if (!created.ok) return created;
    this.instancesBindGroup = created.value;
    return ok(undefined);
  }

  pipeline(
    format: TextureFormat,
    sampleCount: 1 | 4,
    layoutProjection: MeshGpuHandles['layoutProjection'],
    shaderUvSetCount: number,
    topology: GpuDrivenBatch['key']['topology'],
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    renderState: MaterialRenderState | undefined,
    selectedArtifact: MaterialShaderArtifact = this.artifact,
    additionalColorFormats: readonly TextureFormat[] = [],
    standardTextureMask?: number,
    forwardColorPass = false,
    preparationFactory?: MaterialPipelineFactory,
  ): Result<RenderPipeline, RhiError> {
    const pipelineRenderState = gpuDrivenReflectionFallbackRenderState({
      renderState,
      colorFormat: format,
      additionalColorFormats,
      forwardColorPass,
      reflectionFallbackOutputAvailable:
        selectedArtifact.reflectionFallbackOutputAvailable === true,
    });
    const constants =
      standardTextureMask === undefined
        ? undefined
        : { [STANDARD_TEXTURE_MASK_OVERRIDE]: standardTextureMask };
    const pipelineUvSetCount = isCanonicalStandardPbrMaterialShader(selectedArtifact.material)
      ? shaderUvSetCount
      : (selectedArtifact.uvSetCount ?? shaderUvSetCount);
    if (layoutProjection.attributes.length === 0) {
      return err(
        new RhiError({
          code: 'shader-compile-failed',
          expected: 'non-empty geometry VertexLayoutProjection',
          hint: 'prepare a receipt-compatible mesh projection before Standard PBR raster',
        }),
      );
    }
    const receipt = selectedArtifact.receipt;
    if (receipt === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'selected MaterialProgramAbi receipt for GPU-driven raster',
          hint: 'keep the draw on the producer recovery path until its ABI is published',
        }),
      );
    }
    const program =
      this.programs === undefined
        ? undefined
        : resolveStandardPbrProgram(
            this.programs,
            this.artifact.material,
            layoutProjection.attributes.some((attribute) => attribute.key === 'color'),
          );
    if (this.pipelineFactory === undefined && program === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'producer-owned Standard PBR program matching the geometry vertex layout',
          hint: 'publish both vertex-color variants for the current device generation',
        }),
      );
    }
    // Projection identity and shader UV count already determine the aliased
    // layout. Do not build a temporary GPU descriptor just to look up its PSO.
    const key = `${format}:${additionalColorFormats.join(',')}|${sampleCount}|${layoutProjection.arrayStride}|${topology}|${stripIndexFormat ?? ''}|${JSON.stringify(pipelineRenderState ?? null)}|${selectedArtifact.material}|${selectedArtifact.layoutIdentity}|${receipt.receiptIdentity}|${receipt.generation}|${selectedArtifact.variantSet ?? ''}|${materialArtifactProgramIdentity(selectedArtifact)}|${selectedArtifact.vertexEntry ?? receipt.sceneIndexEntry}|${selectedArtifact.fragmentEntry ?? ''}|${layoutProjection.digest}|uv${pipelineUvSetCount}|textures=${standardTextureMask ?? ''}`;
    const sceneEntry =
      selectedArtifact.fragmentEntry === 'fs_temporal' ? 'vs_temporal' : receipt.sceneIndexEntry;
    if (sceneEntry === undefined)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a published scene-index vertex entry',
          hint: 'keep this material on the direct lane',
        }),
      );
    const cached = this.pipelines.get(key);
    if (cached !== undefined) return ok(cached);
    if (this.pipelineFactory !== undefined) {
      const group2Contract = selectedArtifact.program.group2;
      const expectsClusteredGroup =
        group2Contract === 'cluster' || group2Contract === 'skin-cluster';
      const pipelineEntry = requestMaterialAbiRasterPipeline(
        preparationFactory ?? this.pipelineFactory,
        {
          artifact: selectedArtifact,
          deformation: this.deformation,
          format,
          sampleCount,
          layoutProjection,
          shaderUvSetCount,
          topology,
          stripIndexFormat,
          renderState,
          additionalColorFormats,
          standardTextureMask,
          forwardColorPass,
        },
      );
      if (pipelineEntry === null) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: `producer-owned scene-index pipeline for material '${selectedArtifact.material}'`,
            hint: 'publish a matching program, entry, layout and resource contract before GPU admission',
          }),
        );
      }
      const expectedGroup2Contract = expectsClusteredGroup
        ? this.deformation === 'skin'
          ? 'skin-cluster'
          : 'cluster'
        : this.deformation === 'skin'
          ? 'skin'
          : 'mesh';
      if (pipelineEntry.group2Contract !== expectedGroup2Contract) {
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: `GPU-driven ${this.deformation === 'skin' ? 'skinned ' : ''}material pipeline group(2) ${expectedGroup2Contract} contract`,
            hint: 'custom attachment or incompatible group(2) layouts remain on their specialized lane',
          }),
        );
      }
      this.pipelines.set(key, pipelineEntry.pipeline);
      return ok(pipelineEntry.pipeline);
    }
    if (
      program === undefined ||
      selectedArtifact.material !== this.artifact.material ||
      selectedArtifact.layoutIdentity !== this.artifact.layoutIdentity ||
      selectedArtifact.receipt?.receiptIdentity !== this.artifact.receipt?.receiptIdentity
    ) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'selected material pipeline factory for the requested ABI artifact',
          hint: 'do not pair a receipt-backed custom or color variant with the legacy fixed module',
        }),
      );
    }
    // The factory above consumes the original projection; only this legacy
    // cache miss needs the geometry-owned descriptor (including UV aliases).
    // biome-ignore lint/style/noNonNullAssertion: a non-empty projection emits one layout, checked before cache lookup
    const vertexLayout = deriveVertexBufferLayoutFromProjection(layoutProjection, {
      shaderUvSetCount: pipelineUvSetCount,
    })[0]!;
    const pipeline = this.device.createRenderPipeline({
      label: `standard-pbr-gpu-driven.${key}`,
      layout: this.pipelineLayout,
      vertex: {
        module: program.module,
        entryPoint: selectedArtifact.vertexEntry ?? sceneEntry,
        ...(constants === undefined ? {} : { constants }),
        buffers: [
          {
            arrayStride: vertexLayout.arrayStride,
            stepMode: 'vertex',
            attributes: vertexLayout.attributes.map(({ shaderLocation, offset, format }) => ({
              shaderLocation,
              offset,
              format: format as GPUVertexFormat,
            })),
          },
        ],
      },
      fragment: {
        module: program.module,
        // The fixed legacy module predates fs_opaque; fs_main is output-equivalent.
        entryPoint:
          selectedArtifact.fragmentEntry === undefined ||
          selectedArtifact.fragmentEntry === STANDARD_OPAQUE_FRAGMENT_ENTRY
            ? 'fs_main'
            : selectedArtifact.fragmentEntry,
        ...(constants === undefined ? {} : { constants }),
        targets: [format, ...additionalColorFormats].map((targetFormat, index) =>
          materialColorTarget(targetFormat, pipelineRenderState, index),
        ),
      },
      primitive: {
        topology,
        cullMode: pipelineRenderState?.cullMode ?? 'back',
        frontFace: pipelineRenderState?.frontFace ?? 'ccw',
        ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
      },
      depthStencil: materialDepthStencil('depth32float-stencil8', pipelineRenderState),
      ...(sampleCount === 4 ? { multisample: { count: 4 } } : {}),
    });
    if (!pipeline.ok) return pipeline;
    this.pipelines.set(key, pipeline.value);
    return pipeline;
  }

  /**
   * Drop only program-derived caches when a publication switches. Resource
   * buffers stay alive until their normal fence retirement, while the next
   * draw must obtain a PSO for the new artifact rather than reuse the old one.
   */
  invalidatePipelineCache(): void {
    this.pipelines.clear();
  }

  /**
   * Scene-index group(2): binding 0 is the GPU Scene transform table (the
   * vertex stage composes root * instance transforms from it), and skin
   * batches add the palette arena. One group serves every batch of this
   * adapter; it is rebuilt only when the scene or palette buffer changes.
   */
  sceneMeshBindGroup(transformBuffer: Buffer, transformBytes: number): Result<BindGroup, RhiError> {
    const cached = this.sceneMeshBinding;
    if (
      cached !== undefined &&
      cached.transformBuffer === transformBuffer &&
      cached.transformBytes === transformBytes &&
      cached.paletteBuffer === this.paletteBuffer
    ) {
      return ok(cached.bindGroup);
    }
    const entries = [
      { binding: 0, resource: bufferBinding(transformBuffer, 0, transformBytes) },
      ...(this.deformation === 'skin' &&
      this.paletteBuffer !== undefined &&
      this.paletteBindingWindowBytes !== undefined
        ? [
            {
              binding: 1,
              // The scene-index palette lane is a global palette row. Bind the
              // complete arena so rows beyond the legacy 255-joint window
              // remain addressable; the shader performs the row selection.
              resource: bufferBinding(this.paletteBuffer),
            },
            {
              binding: 2,
              // The dedicated GPU-driven skin layout keeps the current /
              // previous palette pair used by the direct skin layout. The
              // scene-index shader currently reads the current arena, but
              // the shared layout still requires a complete binding shape.
              resource: bufferBinding(this.paletteBuffer),
            },
          ]
        : []),
    ];
    const bindGroup = this.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-scene-mesh-bg',
      layout: this.meshLayout,
      entries,
    });
    if (!bindGroup.ok) return bindGroup;
    this.sceneMeshBinding = {
      transformBuffer,
      transformBytes,
      paletteBuffer: this.paletteBuffer,
      bindGroup: bindGroup.value,
    };
    return ok(bindGroup.value);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.pendingRetirements) this.destroyOwnedBuffer(buffer);
    this.pendingRetirements.clear();
    this.sceneMeshBinding = undefined;
    this.dynamicFrameRows.clear();
    this.dynamicFrameRangeSource = undefined;
    this.dynamicInputRangeSource = undefined;
    this.dynamicInputFrameRanges = undefined;
    this.dynamicFrameRangeCapacity = 0;
    this.destroyOwnedBuffer(this.instanceBuffer);
    for (const buffer of this.surfaceInputBuffers) this.destroyOwnedBuffer(buffer);
    this.surfaceInputBuffers.clear();
  }

  private retireOwnedBuffer(buffer: Buffer): void {
    if (this.destroyedBuffers.has(buffer)) return;
    if (this.disposed) {
      this.destroyOwnedBuffer(buffer);
      return;
    }
    if (!this.pendingRetirements.add(buffer)) return;
    const token = this.allocationTokens.get(buffer);
    if (token !== undefined) this.allocationLedger.retire(token);
    void this.device.queue.onSubmittedWorkDone().then(
      () => {
        this.pendingRetirements.delete(buffer);
        this.destroyOwnedBuffer(buffer);
      },
      () => {
        this.pendingRetirements.delete(buffer);
        this.destroyOwnedBuffer(buffer);
      },
    );
  }

  private destroyOwnedBuffer(buffer: Buffer): void {
    if (this.destroyedBuffers.has(buffer)) return;
    this.destroyedBuffers.add(buffer);
    this.surfaceInputBuffers.delete(buffer);
    const token = this.allocationTokens.get(buffer);
    if (token !== undefined) this.allocationLedger.release(token);
    this.device.destroyBuffer(buffer);
  }

  private trackOwnedBuffer(buffer: Buffer, bytes: number): void {
    if (this.allocationTokens.has(buffer)) return;
    this.allocationTokens.set(buffer, this.allocationLedger.allocate(bytes));
  }

  private rollbackOwnedBuffer(buffer: Buffer): void {
    if (this.destroyedBuffers.has(buffer)) return;
    this.destroyedBuffers.add(buffer);
    this.surfaceInputBuffers.delete(buffer);
    this.pendingRetirements.delete(buffer);
    const token = this.allocationTokens.get(buffer);
    if (token !== undefined) this.allocationLedger.rollback(token);
    this.device.destroyBuffer(buffer);
  }

  get instancesFrameGroup(): BindGroup {
    return this.instancesBindGroup;
  }

  get surfaceDynamicInputBuffer(): Buffer {
    return this.dynamicInputBuffer;
  }

  get surfaceDynamicFrameBuffer(): Buffer {
    return this.dynamicFrameBuffer;
  }

  get surfaceDynamicSharedFrameBuffer(): Buffer {
    return this.dynamicSharedFrame.buffer;
  }

  get surfaceDynamicInputBufferSize(): number {
    return this.dynamicInputBufferSize;
  }

  get surfaceDynamicFrameBufferSize(): number {
    return this.dynamicFrameBufferSize;
  }

  get surfaceDynamicSharedFrameBufferSize(): number {
    return SURFACE_SHARED_FRAME_BYTES;
  }

  get surfaceDynamicFrameRowAllocations(): number {
    return this.dynamicFrameRowAllocations;
  }

  get surfaceDynamicFrameMemberScans(): number {
    return this.dynamicFrameMemberScans;
  }

  /** Logical bytes owned by this adapter; external scene buffers are excluded. */
  get resourceAllocation(): import('../inspection-types').GpuResourceAllocationInspection {
    return this.allocationLedger.inspect();
  }

  get surfaceDynamicFrameTimeWrites(): number {
    return this.dynamicSharedFrame.writes;
  }

  get surfaceDynamicSharedFrameState(): SurfaceSharedFrameState {
    return this.dynamicSharedFrame;
  }

  get kind(): 'rigid' | 'skin' {
    return this.deformation;
  }
}

/**
 * Renderer-owned join between the scene-index candidate rows and a Surface
 * producer range. The user-facing range keeps its formal instance address;
 * the frame row is assigned after the RenderScene plan has been filtered and
 * its visible bases are known.
 */
interface ProjectedSurfaceFrameRange {
  readonly frameIndex: number;
  readonly range?: DynamicInputRange;
  readonly directMember: {
    readonly worldIdentity: string;
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

interface SurfaceFrameProjection {
  readonly ranges: readonly ProjectedSurfaceFrameRange[];
  readonly consumptionRanges: readonly DynamicInputRange[];
  readonly capacity: number;
}

/**
 * Join Surface ranges to the renderer-owned candidate rows in the visible
 * stream. The GPU culler may assign atomic compact slots in any order, but
 * each rigid member carries its view candidate row in `visibleItems.z`; frame
 * rows are keyed by that row rather than by the compact slot or the GPU Scene
 * instance row, which submeshes of one instance share. The producer's
 * `instanceIndex` remains in the range and is copied into the frame record
 * for the Surface ABI.
 */
function buildProjectedSurfaceFrameRanges(
  filtered: FilteredProductionPlan,
  ranges: readonly DynamicInputRange[],
  scene: PersistentGpuDrivenState,
): Result<readonly ProjectedSurfaceFrameRange[], RhiError> {
  const surfaceMembers: Array<{
    readonly frameIndex: number;
    readonly identity: string;
    readonly directMember: ProjectedSurfaceFrameRange['directMember'];
  }> = [];
  // Candidate rows follow the encoded plan: batches in order, then candidates.
  let candidateRow = 0;
  for (const prepared of filtered.batches) {
    const firstRow = candidateRow;
    candidateRow += prepared.batch.candidates.length;
    if (prepared.artifact.receipt?.surface?.model !== 'single-layer-medium') continue;
    for (const [index, candidate] of prepared.batch.candidates.entries()) {
      const slot = scene.slotAt(candidate.primitiveIndex);
      const worldIdentity = slot === undefined ? undefined : scene.worldIdentities?.[slot.worldId];
      const frameIndex = firstRow + index;
      if (slot === undefined || worldIdentity === undefined) {
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected:
              'every admitted medium draw member has a renderer slot and public World identity',
            hint: `rebuild the persistent scene projection before publishing Surface ranges (primitive=${candidate.primitiveIndex})`,
          }),
        );
      }
      surfaceMembers.push({
        frameIndex,
        directMember: {
          worldIdentity,
          worldId: slot.worldId,
          entityKey: slot.entityKey,
          drawItemIndex: candidate.drawItemIndex,
          instanceOrdinal: candidate.instanceOrdinal,
        },
        identity: JSON.stringify([
          worldIdentity,
          slot.entityKey,
          candidate.drawItemIndex,
          candidate.instanceOrdinal,
        ]),
      });
    }
  }
  if (ranges.length === 0) {
    return ok(
      Object.freeze(
        surfaceMembers.map(({ frameIndex, directMember }) => ({ frameIndex, directMember })),
      ),
    );
  }
  const rangeByIdentity = new Map<string, DynamicInputRange>();
  for (const range of ranges) {
    const identity = JSON.stringify([
      range.member.worldIdentity,
      range.member.entityKey,
      range.member.drawItemIndex,
      range.member.instanceOrdinal,
    ]);
    if (rangeByIdentity.has(identity)) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'at most one Surface dynamic range for each stable draw member',
          hint: `remove the duplicate producer range for member ${identity}`,
        }),
      );
    }
    rangeByIdentity.set(identity, range);
  }
  if (ranges.length !== surfaceMembers.length) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'one stable-identity Surface dynamic range for every admitted medium draw member',
        hint: `publish one range per admitted Surface member (ranges=${ranges.length}, members=${surfaceMembers.length})`,
      }),
    );
  }
  const frameRanges: ProjectedSurfaceFrameRange[] = [];
  for (const member of surfaceMembers) {
    const range = rangeByIdentity.get(member.identity);
    if (range === undefined) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'every admitted medium draw member resolves one stable-identity Surface range',
          hint: `publish the missing producer range for member ${member.identity}`,
        }),
      );
    }
    rangeByIdentity.delete(member.identity);
    frameRanges.push({ frameIndex: member.frameIndex, range, directMember: member.directMember });
  }
  if (rangeByIdentity.size !== 0) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'every Surface range identifies an admitted medium draw member',
        hint: `remove ranges for non-admitted members: ${[...rangeByIdentity.keys()].join(', ')}`,
      }),
    );
  }
  return ok(Object.freeze(frameRanges));
}

/** Retained Surface member rows and their producer upload acknowledgment. */
export class SurfaceFrameProjectionOwner {
  private surfaceFrameRangeCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly slots: PersistentGpuDrivenState['slots'];
        readonly allocationRevision: number;
        readonly page: ReadonlyDynamicInputPage | undefined;
        readonly projectionRevision: number;
        readonly value: SurfaceFrameProjection;
      }
    | undefined;
  private consumedSurfaceInput:
    | {
        readonly page: ReadonlyDynamicInputPage;
        readonly projectionRevision: number;
        readonly contentRevision: number;
        readonly bufferGeneration: number;
        readonly deviceGeneration: number;
      }
    | undefined;
  surfaceFrameRangeBuilds = 0;
  surfaceFrameRangeMemberScans = 0;

  resolve(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
  ): Result<SurfaceFrameProjection, RhiError> {
    const ranges = frame?.ranges ?? [];
    const projectionRevision = frame?.projectionRevision ?? 0;
    if (!Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return err(
        surfaceDynamicInputError(
          'the Surface projection revision is a non-negative safe integer',
          'advance the producer-owned projection revision only when membership or addresses change',
        ),
      );
    }
    const cached = this.surfaceFrameRangeCache;
    if (
      cached?.filtered === filtered &&
      cached.slots === scene.slots &&
      cached.allocationRevision === scene.scene.allocationRevision &&
      cached.page === frame?.page &&
      cached.projectionRevision === projectionRevision
    ) {
      return ok(cached.value);
    }
    this.surfaceFrameRangeBuilds += 1;
    for (const prepared of filtered.batches) {
      if (prepared.artifact.receipt?.surface?.model !== 'single-layer-medium') continue;
      this.surfaceFrameRangeMemberScans += prepared.batch.candidates.length;
    }
    const built = buildProjectedSurfaceFrameRanges(filtered, ranges, scene);
    if (!built.ok) return built;
    let capacity = 1;
    const consumptionRanges: DynamicInputRange[] = [];
    for (const entry of built.value) {
      capacity = Math.max(capacity, entry.frameIndex + 1);
      if (entry.range !== undefined) consumptionRanges.push(entry.range);
    }
    const value = {
      ranges: built.value,
      consumptionRanges: Object.freeze(consumptionRanges),
      capacity,
    };
    return ok(value);
  }

  remember(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
    value: SurfaceFrameProjection,
  ): void {
    this.surfaceFrameRangeCache = {
      filtered,
      slots: scene.slots,
      allocationRevision: scene.scene.allocationRevision,
      page: frame?.page,
      projectionRevision: frame?.projectionRevision ?? 0,
      value,
    };
  }

  private consumeSurfaceDynamicInput(
    page: ReadonlyDynamicInputPage,
    ranges: readonly DynamicInputRange[],
    projectionRevision: number,
    frameNumber: number,
  ): Result<void, RhiError> {
    const consumed = this.consumedSurfaceInput;
    if (
      consumed?.page === page &&
      consumed.projectionRevision === projectionRevision &&
      consumed.contentRevision === page.contentRevision &&
      consumed.bufferGeneration === page.bufferGeneration &&
      consumed.deviceGeneration === page.deviceGeneration
    ) {
      return ok(undefined);
    }
    for (const range of ranges) {
      const receipt = page.consume(range, frameNumber);
      if (!receipt.ok) {
        return err(
          surfaceDynamicInputError(
            'each submitted Surface dynamic range was uploaded before graph consumption',
            receipt.error.hint,
          ),
        );
      }
    }
    this.consumedSurfaceInput = {
      page,
      projectionRevision,
      contentRevision: page.contentRevision,
      bufferGeneration: page.bufferGeneration,
      deviceGeneration: page.deviceGeneration,
    };
    return ok(undefined);
  }

  directInstances(
    materialRaster: MaterialAbiRasterAdapter,
    directInput: Parameters<MaterialAbiRasterAdapter['directSurfaceInstances']>[0],
  ): ReturnType<NonNullable<GpuDrivenStandardPbrFrameResources['surfaceDirectInstances']>> {
    const resolved = materialRaster.directSurfaceInstances(directInput);
    if (!resolved.ok) return resolved;
    const firstInstanceOrdinal = directInput.firstInstanceOrdinal ?? 0;
    const memberIds: string[] = [];
    for (let index = 0; index < directInput.instanceCount; index += 1) {
      const instanceOrdinal = firstInstanceOrdinal + index;
      const memberId = this.memberId(
        directInput.worldId,
        directInput.entityKey,
        directInput.drawItemIndex,
        instanceOrdinal,
      );
      if (memberId === undefined) {
        return err(
          surfaceDynamicInputError(
            'every direct Surface command resolves the retained public member identity',
            `rebuild the Surface projection for world=${directInput.worldId}, entity=${directInput.entityKey}, draw=${directInput.drawItemIndex}, instance=${instanceOrdinal}`,
          ),
        );
      }
      memberIds.push(memberId);
    }
    return ok({ ...resolved.value, memberIds: Object.freeze(memberIds) });
  }

  consumer(
    frame: SurfaceDynamicInputFrame | undefined,
  ): ((frameNumber: number) => Result<void, RhiError>) | undefined {
    const input =
      frame === undefined
        ? undefined
        : {
            page: frame.page,
            ranges: this.surfaceFrameRangeCache?.value.consumptionRanges ?? [],
            projectionRevision: frame.projectionRevision,
          };
    return input === undefined || input.ranges.length === 0
      ? undefined
      : (frameNumber) =>
          this.consumeSurfaceDynamicInput(
            input.page,
            input.ranges,
            input.projectionRevision,
            frameNumber,
          );
  }

  memberId(
    worldId: number,
    entityKey: number,
    drawItemIndex: number,
    instanceOrdinal: number,
  ): string | undefined {
    const frameRange = this.surfaceFrameRangeCache?.value.ranges.find(
      ({ directMember }) =>
        directMember.worldId === worldId &&
        directMember.entityKey === entityKey &&
        directMember.drawItemIndex === drawItemIndex &&
        directMember.instanceOrdinal === instanceOrdinal,
    );
    if (frameRange === undefined) return undefined;
    return JSON.stringify([
      frameRange.directMember.worldIdentity,
      frameRange.directMember.entityKey,
      frameRange.directMember.drawItemIndex,
      frameRange.directMember.instanceOrdinal,
    ]);
  }

  clear(): void {
    this.surfaceFrameRangeCache = undefined;
    this.consumedSurfaceInput = undefined;
  }
}
