import {
  deriveVertexBufferLayoutFromProjection,
  vertexLayoutHasColor,
} from '@forgeax/engine-geometry';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RenderPipelineFragmentState,
  Result,
  RhiDevice,
  ShaderModule,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type {
  MaterialDynamicInputLayout,
  MaterialRenderState,
  ResultOk,
} from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import { toGpuVertexBufferLayouts } from '../assembly/webgpu-vertex-layouts';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { GpuSceneTableBindingTarget } from '../gpu-scene';
import type { GpuSceneInputs } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { materialColorTarget, materialDepthStencil } from '../material-render-state';
import {
  colorlessFragmentEntry,
  effectiveStandardSurfaceDiscards,
  materialAbiRasterConstants,
  materialVertexConstants,
} from '../material-stage-constants';
import { isCanonicalStandardPbrMaterialShader, isStandardGBufferEntry } from '../pbr-pipeline';
import { INSTANCE_STORAGE_STRIDE_FLOATS, packInstanceStorageBuffer } from '../record/mesh-ssbo';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { SkinTaskBinding } from '../record/skin-tasks';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import { createPrimitiveBindGroup } from '../reflection/primitive-bindings';
import type { GpuDrivenStandardPbrFrameResources } from '../render-pipeline';
import { PROBE_BLEND_RECORD_BYTE_SIZE } from '../scene/probe-blend-record';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type {
  DynamicInputRange,
  DynamicInputUploadReceipt,
  ReadonlyDynamicInputPage,
  SurfaceDynamicInputFrame,
} from '../surface/dynamic-input';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import type { GpuDrivenPbrPrograms } from './pbr-program';
import { resolveStandardPbrProgram } from './pbr-program';
import type { GpuDrivenPrepareInput } from './production-raster';
import type { FilteredProductionPlan } from './production-raster-prepare';
import {
  createRasterWindowBinding,
  type GpuRasterInputPreparation,
  type PreparingRasterInputBindings,
  type RasterInputDemand,
  type RasterSceneTables,
  type RasterWindowStorage,
  rasterInputCurrent,
  rasterInputTarget,
  remapRasterWindowBase,
} from './raster-input-bindings';
import { isVelocityRasterEntry } from './raster-selection';
import { type RasterWindowLayout, rasterWindowLayout } from './raster-window-layout';
import { gpuDrivenReflectionFallbackRenderState } from './reflection-fallback-output';
import {
  GpuResourceAllocationLedger,
  type GpuResourceAllocationToken,
} from './resource-allocation';

const SURFACE_FRAME_RECORD_BYTES = 48;
const SURFACE_SHARED_FRAME_BYTES = 16;
const SURFACE_DIRECT_ADDRESS_STRIDE = 256;

interface SurfaceFrameRange {
  readonly frameIndex: number;
  readonly range?: DynamicInputRange;
  readonly directMember?: {
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

interface SurfaceDrawRun {
  readonly entity: number;
  readonly draw: number;
  readonly frameBase: number;
  count: number;
  start: number;
}

/** One physical range per draw. Local ordinals address both GPU parameters and the
 * published member directly, including when the input arrives in arbitrary order. */
interface SurfaceDrawAddresses<T extends SurfaceFrameRange> {
  readonly layout: SurfaceDrawLayout;
  readonly members: readonly T[];
}

class SurfaceDrawLayout {
  readonly runs: SurfaceDrawRun[] = [];
  private readonly byEntity = new Map<number, SurfaceDrawRun | Map<number, SurfaceDrawRun>>();

  get(entity: number, draw: number): SurfaceDrawRun | undefined {
    const held = this.byEntity.get(entity);
    return held instanceof Map ? held.get(draw) : held?.draw === draw ? held : undefined;
  }

  static build<T extends SurfaceFrameRange>(
    rows: readonly T[],
  ): Result<SurfaceDrawAddresses<T>, RhiError> {
    const result = new SurfaceDrawLayout();
    for (const row of rows) {
      const member = row.directMember;
      if (member === undefined) continue;
      const { entityKey, drawItemIndex, instanceOrdinal } = member;
      const base = row.frameIndex - instanceOrdinal;
      let run = result.get(entityKey, drawItemIndex);
      if (run === undefined) {
        run = { entity: entityKey, draw: drawItemIndex, frameBase: base, count: 0, start: 0 };
        const held = result.byEntity.get(entityKey);
        if (held === undefined) result.byEntity.set(entityKey, run);
        else if (held instanceof Map) held.set(drawItemIndex, run);
        else
          result.byEntity.set(
            entityKey,
            new Map([
              [held.draw, held],
              [drawItemIndex, run],
            ]),
          );
        result.runs.push(run);
      }
      if (
        run.frameBase !== base ||
        base < 0 ||
        !Number.isSafeInteger(instanceOrdinal) ||
        instanceOrdinal < 0
      )
        return err(invalidSurfaceDrawAddress(entityKey, drawItemIndex));
      run.count++;
    }
    let size = 0;
    for (const run of result.runs) {
      run.start = size;
      size += run.count;
    }
    const members = new Array<T>(size);
    for (const row of rows) {
      const member = row.directMember;
      if (member === undefined) continue;
      const run = result.get(member.entityKey, member.drawItemIndex) as SurfaceDrawRun;
      const offset = run.start + member.instanceOrdinal;
      if (member.instanceOrdinal >= run.count || members[offset] !== undefined)
        return err(invalidSurfaceDrawAddress(member.entityKey, member.drawItemIndex));
      members[offset] = row;
    }
    return ok({ layout: result, members });
  }

  sameLayout(other: SurfaceDrawLayout): boolean {
    if (this.runs.length !== other.runs.length) return false;
    for (let i = 0; i < this.runs.length; i++) {
      const a = this.runs[i] as SurfaceDrawRun,
        b = other.runs[i] as SurfaceDrawRun;
      if (
        a.entity !== b.entity ||
        a.draw !== b.draw ||
        a.count !== b.count ||
        a.frameBase !== b.frameBase
      )
        return false;
    }
    return true;
  }
}

function invalidSurfaceDrawAddress(entity: number, draw: number) {
  return surfaceDynamicInputError(
    'each direct Surface draw has contiguous local instance ordinals and one frame-row base',
    `rebuild the retained member projection for draw [${entity},${draw}]`,
  );
}

interface SurfaceFrameRow {
  readonly eventRangeStart: number;
  readonly eventRangeCount: number;
  readonly instanceIndex: number;
  readonly backgroundAvailable: boolean;
}

interface SurfaceSharedFrameState {
  buffer: Buffer;
  readonly fallback: Buffer;
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

function invalidSurfaceInputShape(
  frameTime: number,
  recordCapacity: number,
  page: ReadonlyDynamicInputPage | undefined,
  expectedLayout: MaterialDynamicInputLayout | undefined,
): RhiError | undefined {
  if (!Number.isFinite(frameTime)) {
    return surfaceDynamicInputError(
      'the frame-time snapshot is finite',
      'pass the World/App time snapshot to the Render owner',
    );
  }
  if (!Number.isSafeInteger(recordCapacity) || recordCapacity <= 0) {
    return surfaceDynamicInputError(
      'the GPU-driven Surface frame capacity is a positive safe integer',
      'prepare the frame from the bounded RenderScene batch capacity',
    );
  }
  if (expectedLayout === undefined && page !== undefined) {
    return surfaceDynamicInputError(
      'a dynamic input page is supplied only when the published Surface ABI declares one',
      'remove the page or recook the material with its dynamicInput declaration',
    );
  }
  if (expectedLayout !== undefined && page === undefined) {
    return surfaceDynamicInputError(
      'the published Surface ABI dynamicInput page is present for this draw',
      'publish the renderer-owned page before preparing the Surface draw',
    );
  }
  return undefined;
}

function invalidSurfaceFrameRanges(
  frameRanges: readonly SurfaceFrameRange[],
  ranges: readonly DynamicInputRange[],
): RhiError | undefined {
  const frameIndices = new Set<number>();
  for (const entry of frameRanges) {
    if (!Number.isSafeInteger(entry.frameIndex) || entry.frameIndex < 0) {
      return surfaceDynamicInputError(
        'every renderer-owned Surface frame index is a non-negative safe integer',
        'derive the visible-member row from the retained GPU Scene window',
      );
    }
    if (frameIndices.has(entry.frameIndex)) {
      return surfaceDynamicInputError(
        'each Surface frame row has one renderer-owned visible member',
        'repair the filtered scene-index membership before encoding the frame',
      );
    }
    frameIndices.add(entry.frameIndex);
    if (entry.range !== undefined && !ranges.includes(entry.range)) {
      return surfaceDynamicInputError(
        'each Surface row references a range from the submitted frame',
        'derive the visible-member mapping from the same SurfaceDynamicInputFrame instance',
      );
    }
  }
  return undefined;
}

/** A page matching its cooked ABI, device generation and byte bounds opens one upload receipt. */
function beginSurfacePageUpload(
  page: ReadonlyDynamicInputPage,
  expectedLayout: MaterialDynamicInputLayout | undefined,
  expectedDeviceGeneration: number | undefined,
): Result<DynamicInputUploadReceipt, RhiError> {
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
  return ok(begun.value);
}

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

function legacyFragmentKey(fragmentEntry: string | null | undefined): string {
  if (fragmentEntry === null) return 'fs:none';
  return fragmentEntry ?? '';
}

/** Fragment stage of the fixed legacy module; `null` entry is a vertex-only PSO. */
function legacyFragmentState(
  module: ShaderModule,
  fragmentEntry: string | null | undefined,
  constants: Record<string, number> | undefined,
  targets: readonly TextureFormat[],
  renderState: MaterialRenderState | undefined,
): { fragment?: RenderPipelineFragmentState } {
  if (fragmentEntry === null) return {};
  return {
    fragment: {
      module,
      // The fixed legacy module predates fs_opaque; fs_main is output-equivalent.
      entryPoint:
        fragmentEntry === undefined || fragmentEntry === STANDARD_OPAQUE_FRAGMENT_ENTRY
          ? 'fs_main'
          : fragmentEntry,
      ...(constants === undefined ? {} : { constants }),
      targets: targets.map((targetFormat, index) =>
        materialColorTarget(targetFormat, renderState, index),
      ),
    },
  };
}

interface MaterialAbiRasterPipelineInput {
  readonly artifact: MaterialShaderArtifact;
  readonly deformation: 'rigid' | 'skin';
  /** `null` is the colorless scene prepass: no color target. */
  readonly format: TextureFormat | null;
  readonly sampleCount: 1 | 4;
  readonly layoutProjection: MeshGpuHandles['layoutProjection'];
  readonly shaderUvSetCount: number;
  readonly topology: GpuDrivenBatch['key']['topology'];
  readonly stripIndexFormat: 'uint16' | 'uint32' | undefined;
  readonly renderState: MaterialRenderState | undefined;
  readonly additionalColorFormats: readonly TextureFormat[];
  readonly standardTextureMask?: number | undefined;
  /** Standard surface discard bits; applied only to modules declaring the override. */
  readonly standardSurfaceDiscards?: number | undefined;
  readonly forwardColorPass: boolean;
}

/** One request specification for real raster and hidden preparation. */
export function requestMaterialAbiRasterPipeline(
  factory: MaterialPipelineFactory,
  input: MaterialAbiRasterPipelineInput,
) {
  const artifact = input.artifact,
    receipt = artifact.receipt;
  const sceneEntry = isVelocityRasterEntry(artifact.fragmentEntry)
    ? 'vs_temporal'
    : receipt?.sceneIndexEntry;
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
  const surfaceDiscards = effectiveStandardSurfaceDiscards(artifact, input.standardSurfaceDiscards);
  const fragmentEntry = colorlessFragmentEntry(
    input.format === null,
    artifact.variantSet,
    receipt,
    surfaceDiscards,
    artifact.fragmentEntry,
    artifact.program,
    input.renderState?.alphaToCoverageEnabled === true,
  );
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
    isStandardGBufferEntry(fragmentEntry) ? 'deferred' : 'forward',
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
    fragmentEntry,
    undefined,
    materialAbiRasterConstants(input.standardTextureMask, surfaceDiscards),
  );
}

function rasterInputBindingError(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'unchanged native raster windows and their original Inputs target',
    hint: 'release this private window preparation and retry against the current owner',
  });
}

export class MaterialAbiRasterAdapter {
  /** Effective fixed entry of this adapter, including its retained factory lane. */
  diagnosticGBufferVertexEntry(artifact: MaterialShaderArtifact): string | undefined {
    return this.pipelineFactory === undefined
      ? (artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry)
      : artifact.receipt?.sceneIndexEntry;
  }

  private readonly pipelines = new Map<string, RenderPipeline>();
  private rigidPrimitive: BindGroup | undefined;
  private readonly skinPrimitives = new WeakMap<
    Buffer,
    WeakMap<
      Buffer,
      {
        readonly dataBytes: number;
        readonly auxiliaryBytes: number;
        readonly result: ResultOk<BindGroup>;
      }
    >
  >();
  private readonly pendingRetirements = new Set<Buffer>();
  private readonly destroyedBuffers = new WeakSet<Buffer>();
  private disposed = false;
  private visibleWindowBindGroups = new WeakMap<Buffer, Map<string, BindGroup>>();
  readonly visibleWindowCounters = { creates: 0, hits: 0, resets: 0 };

  private resetVisibleWindows(): void {
    this.visibleWindowCounters.resets += 1;
    this.visibleWindowBindGroups = new WeakMap();
  }
  private sceneTables: RasterSceneTables | undefined;
  private preparingInputBindings: PreparingRasterInputBindings | undefined;
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
  private boundSharedFrame: Buffer;
  private readonly dynamicSharedFrame: SurfaceSharedFrameState;
  private readonly emptySurfaceBuffer: Buffer;
  private directAddressBuffer: Buffer;
  private directAddressBufferSize: number;
  private directAddresses = new SurfaceDrawLayout();
  private readonly directBindGroups = new Map<
    number,
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
    private readonly programs: GpuDrivenPbrPrograms | undefined,
    private instancesBindGroup: BindGroup,
    private readonly instanceBuffer: Buffer,
    private readonly instanceBufferSize: number,
    private visibleBuffer: Buffer,
    private probeBlendRecordBuffer: Buffer | undefined,
    private readonly artifact: MaterialShaderArtifact,
    private readonly deformation: 'rigid' | 'skin',
    private readonly pipelineFactory: MaterialPipelineFactory | undefined,
    dynamicSharedFrame: SurfaceSharedFrameState,
    directAddressBuffer: Buffer,
    allocationLedger: GpuResourceAllocationLedger,
  ) {
    this.allocationLedger = allocationLedger;
    // The original zeroed address stripe also covers legacy layouts whose
    // selected entries never touch dynamic Surface slots.
    this.dynamicInputBuffer = directAddressBuffer;
    this.dynamicInputBufferSize = 16;
    this.dynamicFrameBuffer = directAddressBuffer;
    this.dynamicFrameBufferSize = 0;
    this.dynamicSharedFrame = dynamicSharedFrame;
    this.boundSharedFrame = dynamicSharedFrame.buffer;
    this.emptySurfaceBuffer = directAddressBuffer;
    this.directAddressBuffer = directAddressBuffer;
    this.directAddressBufferSize = SURFACE_DIRECT_ADDRESS_STRIDE;
    this.surfaceInputBuffers.add(directAddressBuffer);
    this.trackOwnedBuffer(instanceBuffer, instanceBufferSize);
    this.trackOwnedBuffer(directAddressBuffer, SURFACE_DIRECT_ADDRESS_STRIDE);
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly pipelineState: PipelineState;
    readonly artifact: MaterialShaderArtifact;
    readonly visibleBuffer: Buffer;
    readonly deformation?: 'rigid' | 'skin';
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
      resolveStandardPbrProgram(
        programs,
        input.artifact.material,
        receipt.vertexInputs.some((attribute) => attribute.semantic === 'color'),
      )?.module === undefined
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
        ? input.pipelineState.gpuDrivenSkinPrimitiveBindGroupLayout
        : input.pipelineState.gpuDrivenPrimitiveBindGroupLayout;
    if (meshLayout == null) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: `${deformation === 'skin' ? 'skinned ' : ''}material mesh bind-group layout`,
          hint: 'publish the exact mesh-array layout selected by the material receipt',
        }),
      );
    }
    const identity = new Float32Array(16);
    identity[0] = 1;
    identity[5] = 1;
    identity[10] = 1;
    identity[15] = 1;
    const instancePayload = packInstanceStorageBuffer(
      new Float32Array(INSTANCE_STORAGE_STRIDE_FLOATS),
      identity,
    );
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
    const directAddressBuffer = input.device.createBuffer({
      label: 'surface-direct-addresses',
      size: SURFACE_DIRECT_ADDRESS_STRIDE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!directAddressBuffer.ok) {
      cleanupCreatedBuffers();
      return directAddressBuffer;
    }
    createdBuffers.push(directAddressBuffer.value);
    const dynamicSharedFrame = input.sharedSurfaceFrame ?? {
      buffer: directAddressBuffer.value,
      fallback: directAddressBuffer.value,
      frameTime: 0,
      writes: 0,
    };
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
        { binding: 3, resource: bufferBinding(directAddressBuffer.value, 0, 16) },
        {
          binding: 4,
          resource: bufferBinding(directAddressBuffer.value, 0, SURFACE_FRAME_RECORD_BYTES),
        },
        {
          binding: 5,
          resource: bufferBinding(dynamicSharedFrame.buffer, 0, SURFACE_SHARED_FRAME_BYTES),
        },
        // Frame-level placeholder; scene-index draws bind visible windows.
        {
          binding: 6,
          resource: bufferBinding(instanceBuffer.value, 0, instancePayload.byteLength),
        },
        { binding: 7, resource: bufferBinding(input.visibleBuffer) },
        { binding: 8, resource: bufferBinding(input.visibleBuffer) },
        { binding: 9, resource: bufferBinding(instanceBuffer.value) },
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
        dynamicSharedFrame,
        directAddressBuffer.value,
        allocationLedger,
      ),
    );
  }

  ensureVisibleBuffer(visibleBuffer: Buffer): Result<void, RhiError> {
    if (this.visibleBuffer === visibleBuffer) return ok(undefined);
    const created = this.createVisibleBufferBinding(visibleBuffer);
    if (!created.ok) return created;
    this.instancesBindGroup = created.value;
    this.visibleBuffer = visibleBuffer;
    return ok(undefined);
  }

  private createVisibleBufferBinding(
    visibleBuffer: Buffer,
    tables = this.sceneTables,
  ): Result<BindGroup, RhiError> {
    return this.device.createBindGroup({
      label: 'standard-pbr-gpu-driven-visible-instances-bg',
      layout: this.instancesBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize),
        },
        { binding: 1, resource: bufferBinding(this.probeBlendRecordBuffer ?? visibleBuffer) },
        { binding: 2, resource: bufferBinding(visibleBuffer) },
        {
          binding: 3,
          resource: bufferBinding(this.dynamicInputBuffer, 0, this.dynamicInputBufferSize),
        },
        {
          binding: 4,
          resource: bufferBinding(this.dynamicFrameBuffer, 0, this.surfaceDynamicFrameBufferSize),
        },
        {
          binding: 5,
          resource: bufferBinding(this.boundSharedFrame, 0, SURFACE_SHARED_FRAME_BYTES),
        },
        { binding: 6, resource: bufferBinding(this.instanceBuffer, 0, this.instanceBufferSize) },
        {
          binding: 7,
          resource: bufferBinding(tables?.visibleSurfaceRows ?? visibleBuffer),
        },
        { binding: 8, resource: bufferBinding(tables?.sceneInputs ?? visibleBuffer) },
        {
          binding: 9,
          resource: bufferBinding(
            tables?.transformBuffer ?? this.instanceBuffer,
            0,
            tables?.transformBytes,
          ),
        },
      ],
    });
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
   * Keep the resident transform, instance, and primitive tables with the
   * visible index windows. Rebind the windows when a table handle or range changes.
   */
  ensureSceneTables(
    transformBuffer: Buffer,
    transformBytes: number,
    instanceBuffer: Buffer,
    instanceBytes: number,
    primitiveBuffer: Buffer,
    primitiveBytes: number,
    visibleSurfaceRows?: Buffer,
    sceneInputs?: Buffer,
    inputOwner?: GpuSceneInputs,
  ): void {
    const current = this.sceneTables;
    if (
      current?.transformBuffer === transformBuffer &&
      current.transformBytes === transformBytes &&
      current.instanceBuffer === instanceBuffer &&
      current.instanceBytes === instanceBytes &&
      current.primitiveBuffer === primitiveBuffer &&
      current.primitiveBytes === primitiveBytes &&
      current.visibleSurfaceRows === visibleSurfaceRows &&
      current.sceneInputs === sceneInputs &&
      current.inputOwner === inputOwner
    ) {
      return;
    }
    this.sceneTables = {
      transformBuffer,
      transformBytes,
      instanceBuffer,
      instanceBytes,
      primitiveBuffer,
      primitiveBytes,
      visibleSurfaceRows,
      sceneInputs,
      ...(inputOwner === undefined ? {} : { inputOwner }),
    };
    this.resetVisibleWindows();
  }

  /** Identity of the physical resources behind every visible-window binding. */
  get visibleBindingIdentity(): object {
    return this.visibleWindowBindGroups;
  }

  inputBindingState(
    inputs: GpuSceneInputs,
    target?: GpuSceneTableBindingTarget,
  ): 'unused' | 'foreign' | 'current' | 'stale' {
    if (this.disposed) return 'stale';
    const tables = this.sceneTables;
    if (target !== undefined) {
      if (
        tables === undefined ||
        target.owner.inputs !== inputs ||
        !target.owner.capacityTargetMatches(target)
      )
        return 'stale';
      if (
        tables.transformBuffer !== target.owner.transformBuffer ||
        tables.instanceBuffer !== target.owner.instanceBuffer ||
        tables.primitiveBuffer !== target.owner.primitiveBuffer
      )
        return 'foreign';
      if (tables.sceneInputs === undefined) return 'current';
    }
    if (tables?.sceneInputs === undefined) return 'unused';
    if (tables.inputOwner === undefined) return 'stale';
    if (tables.inputOwner !== inputs) return 'foreign';
    return inputs.isCurrentBuffer(tables.sceneInputs) ? 'current' : 'stale';
  }

  visibleWindowBindGroup(
    visibleBase: number,
    visibleCapacity: number,
    current?: () => boolean,
    projection?: RasterWindowLayout,
  ): Result<BindGroup, RhiError> {
    return this.visibleWindowBindGroupForBuffer(
      this.visibleBuffer,
      visibleBase,
      visibleCapacity,
      false,
      current,
      projection,
    );
  }

  visibleWindowBindGroupForBuffer(
    visibleBuffer: Buffer,
    visibleBase: number,
    visibleCapacity: number,
    shadowVisibleAlias = false,
    current?: () => boolean,
    projection?: RasterWindowLayout,
  ): Result<BindGroup, RhiError> {
    const invalid = () =>
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'current original raster window storage',
          hint: 'reprepare from the live native Scene/View owners',
        }),
      );
    if (this.disposed || (current !== undefined && !current()) || this.disposed) return invalid();
    const cache = this.visibleWindowBindGroups;
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
    const mode = shadowVisibleAlias ? 'shadow' : 'main';
    const region = wholeVisibleBuffer ? mode : `${visibleBase}:${visibleCapacity}:${mode}`;
    const key = projection === undefined ? region : `${region}:${projection.index}`;
    const cached = groups.get(key);
    if (cached !== undefined) {
      this.visibleWindowCounters.hits += 1;
      return ok(cached);
    }
    const created = createRasterWindowBinding(
      this.device,
      this.instancesBindGroupLayout,
      this.windowStorage(sceneTables),
      visibleBuffer,
      visibleBase,
      visibleCapacity,
      shadowVisibleAlias,
      projection,
    );
    if (!created.ok) return created;
    if (!this.windowStorageCurrent(sceneTables, cache, current)) return invalid();
    this.visibleWindowCounters.creates += 1;
    groups.set(key, created.value);
    return ok(created.value);
  }

  private windowStorageCurrent(
    tables: RasterSceneTables,
    cache: WeakMap<Buffer, Map<string, BindGroup>>,
    current: (() => boolean) | undefined,
  ): boolean {
    const owned = () =>
      !this.disposed && this.sceneTables === tables && this.visibleWindowBindGroups === cache;
    return owned() && (current === undefined || current()) && owned();
  }

  private windowStorage(tables: RasterSceneTables): RasterWindowStorage {
    return {
      tables,
      probe: this.probeBlendRecordBuffer,
      dynamicInput: this.dynamicInputBuffer,
      dynamicFrame: this.dynamicFrameBuffer,
      sharedFrame: this.boundSharedFrame,
    };
  }

  /** Existing cached windows only; the caller must close its real View/bundle roster. */
  prepareInputBindings(
    inputs: GpuSceneInputs,
    demand: RasterInputDemand,
    visibleBuffers: readonly Buffer[],
    ownerCurrent?: () => boolean,
    tableTarget?: GpuSceneTableBindingTarget,
  ): Result<GpuRasterInputPreparation, RhiError> {
    const tables = this.sceneTables;
    const target = rasterInputTarget(inputs, demand);
    if (
      tables === undefined ||
      target === undefined ||
      !this.inputPreparationAvailable(inputs, demand, tableTarget)
    )
      return err(rasterInputBindingError());
    const role: PreparingRasterInputBindings = {
      facts: {
        storage: this.windowStorage(tables),
        cache: this.visibleWindowBindGroups,
        visible: this.visibleBuffer,
        whole: this.device.caps.firstInstanceIndirect,
        inputs,
        demand,
        target,
      },
      snapshots: [],
      replacements: new Map(),
      next: new WeakMap(),
      nextVisible: undefined,
      nextInstances: undefined,
      nextTables: {
        ...tables,
        sceneInputs: tables.sceneInputs === undefined ? undefined : target.buffer,
        ...(tableTarget === undefined
          ? {}
          : {
              transformBuffer: tableTarget.transformBuffer,
              transformBytes: tableTarget.transformBytes,
              primitiveBuffer: tableTarget.primitiveBuffer,
              primitiveBytes: tableTarget.rowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
              instanceBuffer: tableTarget.instanceBuffer,
              instanceBytes: tableTarget.rowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
            }),
      },
      ready: false,
      closeOwner: undefined,
    };
    this.preparingInputBindings = role;
    let accepted = false;
    try {
      if (tableTarget !== undefined)
        role.sceneTablesCurrent = () => tableTarget.owner.capacityTargetMatches(tableTarget);
      for (const buffer of new Set([this.visibleBuffer, ...visibleBuffers])) {
        const groups = this.visibleWindowBindGroups.get(buffer);
        role.snapshots.push({ buffer, groups, rows: groups === undefined ? [] : [...groups] });
      }
      if (demand.kind === 'current' && this.visibleBuffer === demand.storage.before.visible) {
        role.nextVisible = demand.storage.after.visible;
        role.nextInstances = this.createVisibleBufferBinding(
          role.nextVisible,
          role.nextTables,
        ).unwrap();
      }
      const created = this.createInputWindows(role, ownerCurrent);
      if (!created.ok) return created;
      role.ready = true;
      const api = this.inputBindingPreparationApi(role);
      accepted = true;
      return ok(api);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      if (!accepted) this.releaseInputBindings(role);
    }
  }

  private inputPreparationAvailable(
    inputs: GpuSceneInputs,
    demand: RasterInputDemand,
    tableTarget: GpuSceneTableBindingTarget | undefined,
  ): boolean {
    const tables = this.sceneTables;
    return !(
      this.disposed ||
      this.preparingInputBindings !== undefined ||
      tables === undefined ||
      (tables.sceneInputs === undefined &&
        tableTarget === undefined &&
        demand.kind === 'successor') ||
      !inputs.isLiveOn(this.device) ||
      (tables.sceneInputs !== undefined && !inputs.isCurrentBuffer(tables.sceneInputs))
    );
  }

  private inputBindingPreparationApi(
    role: PreparingRasterInputBindings,
  ): GpuRasterInputPreparation {
    let owner: MaterialAbiRasterAdapter | undefined = this;
    role.closeOwner = () => {
      owner = undefined;
    };
    const current = () => owner?.preparedInputsCurrent(role) === true;
    return Object.freeze({
      isCurrent: current,
      bindingIdentity: () => (current() ? role.next : undefined),
      replacement: (window: BindGroup) => (current() ? role.replacements.get(window) : undefined),
      publish: () => {
        const active = owner;
        if (active === undefined) return err(rasterInputBindingError());
        const result = active.publishInputBindings(role);
        if (result.ok) owner = undefined;
        return result;
      },
      release: () => {
        const active = owner;
        owner = undefined;
        active?.releaseInputBindings(role);
      },
    });
  }

  private createInputWindows(
    role: PreparingRasterInputBindings,
    ownerCurrent?: () => boolean,
  ): Result<void, RhiError> {
    const facts = role.facts;
    if (facts?.target === undefined || role.nextTables === undefined)
      return err(rasterInputBindingError());
    const { inputs, demand, target } = facts;
    // The Root's pure source guard applies during construction only. Accepted
    // window eligibility remains this owner's exact issuer/table observation.
    const current = () =>
      this.inputBindingsMatch(role) && ownerCurrent?.() !== false && this.inputBindingsMatch(role);
    for (const snapshot of role.snapshots) {
      const result = this.createInputWindowSnapshot(role, snapshot, current);
      if (!result.ok) return result;
    }
    if (!current() || rasterInputTarget(inputs, demand)?.buffer !== target.buffer)
      return err(rasterInputBindingError());
    return ok(undefined);
  }

  private createInputWindowSnapshot(
    role: PreparingRasterInputBindings,
    snapshot: PreparingRasterInputBindings['snapshots'][number],
    current: () => boolean,
  ): Result<void, RhiError> {
    const facts = role.facts;
    if (facts?.target === undefined || role.nextTables === undefined)
      return err(rasterInputBindingError());
    const { inputs, demand, target } = facts;
    const storage = { ...facts.storage, tables: role.nextTables };
    const targetStorage = demand.kind === 'current' ? demand.storage : undefined;
    const moved = targetStorage !== undefined && snapshot.buffer === targetStorage.before.visible;
    const nextBuffer = moved ? targetStorage.after.visible : snapshot.buffer;
    const groups = new Map<string, BindGroup>();
    for (const [key, previous] of snapshot.rows) {
      if (!current() || rasterInputTarget(inputs, demand)?.buffer !== target.buffer)
        return err(rasterInputBindingError());
      if (targetStorage !== undefined && !moved) {
        groups.set(key, previous);
        role.replacements.set(previous, previous);
        continue;
      }
      const parts = key.split(':');
      const oldBase = Number(parts[0]);
      const base = moved ? remapRasterWindowBase(oldBase, targetStorage) : oldBase;
      const whole = this.device.caps.firstInstanceIndirect;
      const created = createRasterWindowBinding(
        this.device,
        this.instancesBindGroupLayout,
        storage,
        nextBuffer,
        whole ? 0 : base,
        whole ? 1 : Number(parts[1]),
        parts[whole ? 0 : 2] === 'shadow',
        rasterWindowLayout(previous),
      );
      if (!created.ok) return created;
      if (!current() || rasterInputTarget(inputs, demand)?.buffer !== target.buffer)
        return err(rasterInputBindingError());
      const nextKey = whole ? key : `${base}${key.slice(key.indexOf(':'))}`;
      groups.set(nextKey, created.value);
      role.replacements.set(previous, created.value);
    }
    role.next?.set(nextBuffer, groups);

    return ok(undefined);
  }

  private inputBindingsMatch(role: PreparingRasterInputBindings): boolean {
    const facts = role.facts;
    if (this.disposed || this.preparingInputBindings !== role || facts === undefined) return false;
    const storage = facts.storage;
    if (
      this.sceneTables !== storage.tables ||
      this.visibleWindowBindGroups !== facts.cache ||
      this.visibleBuffer !== facts.visible ||
      this.device.caps.firstInstanceIndirect !== facts.whole ||
      role.sceneTablesCurrent?.() === false ||
      this.probeBlendRecordBuffer !== storage.probe ||
      this.dynamicInputBuffer !== storage.dynamicInput ||
      this.dynamicFrameBuffer !== storage.dynamicFrame ||
      this.boundSharedFrame !== storage.sharedFrame
    )
      return false;
    // Each private map only appends on a miss; reset/replacement changes the root identity.
    for (const snapshot of role.snapshots)
      if (
        facts.cache.get(snapshot.buffer) !== snapshot.groups ||
        (snapshot.groups?.size ?? 0) !== snapshot.rows.length
      )
        return false;
    return true;
  }

  private preparedInputsCurrent(role: PreparingRasterInputBindings): boolean {
    const facts = role.facts;
    return (
      role.ready &&
      this.inputBindingsMatch(role) &&
      facts !== undefined &&
      facts.target !== undefined &&
      rasterInputCurrent(facts.inputs, facts.demand, facts.target.buffer)
    );
  }

  private publishInputBindings(role: PreparingRasterInputBindings): Result<void, RhiError> {
    const facts = role.facts;
    if (
      !this.preparedInputsCurrent(role) ||
      facts?.target === undefined ||
      role.next === undefined ||
      role.nextTables === undefined ||
      !facts.inputs.isCurrentBuffer(facts.target.buffer)
    )
      return err(rasterInputBindingError());
    this.sceneTables = role.nextTables;
    this.visibleWindowBindGroups = role.next;
    if (role.nextVisible !== undefined && role.nextInstances !== undefined) {
      this.visibleBuffer = role.nextVisible;
      this.instancesBindGroup = role.nextInstances;
    }
    this.releaseInputBindings(role);
    return ok(undefined);
  }

  private releaseInputBindings(role: PreparingRasterInputBindings): void {
    const closeOwner = role.closeOwner;
    role.closeOwner = undefined;
    role.facts = undefined;
    role.snapshots.length = 0;
    role.replacements.clear();
    role.next = undefined;
    role.nextTables = undefined;
    role.nextVisible = undefined;
    role.nextInstances = undefined;
    role.ready = false;
    role.sceneTablesCurrent = undefined;
    if (this.preparingInputBindings === role) this.preparingInputBindings = undefined;
    closeOwner?.();
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
    prepared?: SurfaceDrawAddresses<SurfaceFrameRange>,
  ): Result<void, RhiError> {
    const collected = prepared === undefined ? SurfaceDrawLayout.build(frameRanges) : ok(prepared);
    if (!collected.ok) return collected;
    const addresses = collected.value;
    if (this.directAddresses.sameLayout(addresses.layout)) return ok(undefined);
    const payload = new Uint8Array(
      Math.max(1, addresses.members.length) * SURFACE_DIRECT_ADDRESS_STRIDE,
    );
    const view = new DataView(payload.buffer);
    for (const run of addresses.layout.runs) {
      for (let ordinal = 0; ordinal < run.count; ordinal++) {
        const offset = (run.start + ordinal) * SURFACE_DIRECT_ADDRESS_STRIDE;
        view.setUint32(offset, run.frameBase + ordinal, true);
        view.setUint32(offset + 4, run.count - ordinal, true);
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
    this.directAddresses = addresses.layout;
    this.directBindGroups.clear();
    this.surfaceInputBuffers.add(replacement.value);
    this.retireSurfaceBuffer(previous);
    return ok(undefined);
  }

  directSurfaceInstances(input: {
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
    const ordinal = input.firstInstanceOrdinal ?? 0;
    const run = this.directAddresses.get(input.entityKey, input.drawItemIndex);
    if (
      run === undefined ||
      !Number.isSafeInteger(input.instanceCount) ||
      input.instanceCount < 0 ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= run.count ||
      run.count - ordinal < input.instanceCount
    ) {
      return err(
        surfaceDynamicInputError(
          'the direct Surface draw resolves one retained frame base with the same instance count',
          `rebuild the producer projection for draw [${input.entityKey},${input.drawItemIndex}] at ordinal ${ordinal} (instances=${input.instanceCount})`,
        ),
      );
    }
    const key = run.start + ordinal;
    const frameBase = run.frameBase + ordinal;
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
        frameBase,
      });
    }
    const created = this.device.createBindGroup({
      label: `surface-direct-instances--${input.entityKey}-${input.drawItemIndex}`,
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
        {
          binding: 3,
          resource: bufferBinding(this.dynamicInputBuffer, 0, this.dynamicInputBufferSize),
        },
        {
          binding: 4,
          resource: bufferBinding(this.dynamicFrameBuffer, 0, this.surfaceDynamicFrameBufferSize),
        },
        {
          binding: 5,
          resource: bufferBinding(this.boundSharedFrame, 0, SURFACE_SHARED_FRAME_BYTES),
        },
        {
          binding: 6,
          resource: bufferBinding(
            this.directAddressBuffer,
            key * SURFACE_DIRECT_ADDRESS_STRIDE,
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
      frameBase,
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
    addresses?: SurfaceDrawAddresses<SurfaceFrameRange>,
  ): Result<void, RhiError> {
    this.pendingDynamicInputUpload = undefined;
    const page = frame?.page;
    const shapeError = invalidSurfaceInputShape(frameTime, recordCapacity, page, expectedLayout);
    if (shapeError !== undefined) return err(shapeError);
    const ranges = frame?.ranges ?? [];
    const compactFrameRanges = frameRanges ?? this.compactSurfaceFrameRanges(ranges);
    const frameRangesChanged = compactFrameRanges !== this.dynamicFrameRangeSource;
    if (frameRangesChanged) {
      const frameError = invalidSurfaceFrameRanges(compactFrameRanges, ranges);
      if (frameError !== undefined) return err(frameError);
    }
    let uploaded: DynamicInputUploadReceipt | undefined;
    if (page !== undefined) {
      const begun = beginSurfacePageUpload(page, expectedLayout, expectedDeviceGeneration);
      if (!begun.ok) return begun;
      uploaded = begun.value;
    }
    if (frameRangesChanged) {
      const admitted = this.admitSurfaceDynamicRanges(
        ranges,
        page,
        expectedDeviceGeneration,
        compactFrameRanges,
        addresses,
      );
      if (!admitted.ok) return admitted;
    }
    if (page !== undefined) {
      const pageUpload = this.uploadSurfacePage(page, uploaded);
      if (!pageUpload.ok) return pageUpload;
    }
    const compactRangeCapacity = frameRangesChanged
      ? compactFrameRanges.reduce((capacity, entry) => Math.max(capacity, entry.frameIndex + 1), 0)
      : this.dynamicFrameRangeCapacity;
    const shared = this.ensureSurfaceSharedFrame();
    if (!shared.ok) return shared;
    const frameBuffer = this.ensureSurfaceFrameBuffer(
      Math.max(1, recordCapacity, compactRangeCapacity),
    );
    if (!frameBuffer.ok) return frameBuffer;
    const frameBufferReplaced = frameBuffer.value;
    const timeWrite = this.writeSurfaceFrameTime(frameTime);
    if (!timeWrite.ok) return timeWrite;
    if (!frameBufferReplaced && !frameRangesChanged) {
      return ok(undefined);
    }
    const rowWrite = this.writeSurfaceFrameRows(compactFrameRanges, frameBufferReplaced);
    if (!rowWrite.ok) return rowWrite;
    this.dynamicFrameRangeSource = compactFrameRanges;
    this.dynamicFrameRangeCapacity = compactRangeCapacity;
    return ok(undefined);
  }

  /** Frame-owned ranges address their own instance rows; one projection per range list. */
  private compactSurfaceFrameRanges(
    ranges: readonly DynamicInputRange[],
  ): readonly SurfaceFrameRange[] {
    if (ranges === this.dynamicInputRangeSource && this.dynamicInputFrameRanges !== undefined) {
      return this.dynamicInputFrameRanges;
    }
    const compact = Object.freeze(
      ranges.map(
        (range) => ({ frameIndex: range.instanceIndex, range }) satisfies SurfaceFrameRange,
      ),
    );
    this.dynamicInputRangeSource = ranges;
    this.dynamicInputFrameRanges = compact;
    return compact;
  }

  /** Validate every published range against its page, then derive direct addresses. */
  private admitSurfaceDynamicRanges(
    ranges: readonly DynamicInputRange[],
    page: ReadonlyDynamicInputPage | undefined,
    expectedDeviceGeneration: number | undefined,
    compactFrameRanges: readonly SurfaceFrameRange[],
    addresses?: SurfaceDrawAddresses<SurfaceFrameRange>,
  ): Result<void, RhiError> {
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
    return this.ensureDirectSurfaceAddresses(compactFrameRanges, addresses);
  }

  /** Replace the page buffer on growth or page identity change; otherwise write dirty ranges. */
  private uploadSurfacePage(
    page: ReadonlyDynamicInputPage,
    uploaded: DynamicInputUploadReceipt | undefined,
  ): Result<void, RhiError> {
    const pageChanged = page !== this.dynamicInputPage;
    const pageGenerationChanged = page.bufferGeneration !== this.dynamicInputPageGeneration;
    const requiredBytes = Math.max(16, page.bytes.byteLength);
    const limit = this.storageBindingLimitError(
      requiredBytes,
      'the Surface dynamic page fits maxStorageBufferBindingSize',
      'reduce the published dynamic page budget before entering the GPU lane',
    );
    if (limit !== undefined) return err(limit);
    if (requiredBytes > this.dynamicInputBufferSize || pageChanged || pageGenerationChanged) {
      const replaced = this.replaceSurfacePageBuffer(page, requiredBytes);
      if (!replaced.ok) return replaced;
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
    return ok(undefined);
  }

  private storageBindingLimitError(
    requestedBytes: number,
    expected: string,
    hint: string,
  ): RhiError | undefined {
    const maxStorageBufferBindingSize = this.device.limits.maxStorageBufferBindingSize;
    if (!Number.isFinite(maxStorageBufferBindingSize)) return undefined;
    if (requestedBytes <= maxStorageBufferBindingSize) return undefined;
    return new RhiError({
      code: 'limit-exceeded',
      expected,
      hint,
      detail: { maxStorageBufferBindingSize, requestedBytes },
    });
  }

  /** Publish a fully written page buffer; a failed rebind restores the previous one. */
  private replaceSurfacePageBuffer(
    page: ReadonlyDynamicInputPage,
    requiredBytes: number,
  ): Result<void, RhiError> {
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
    this.retireSurfaceBuffer(previous);
    return ok(undefined);
  }

  /** Grow the frame record buffer to `capacity` rows; `true` when it was replaced. */
  private ensureSurfaceFrameBuffer(capacity: number): Result<boolean, RhiError> {
    if (capacity > Number.MAX_SAFE_INTEGER / SURFACE_FRAME_RECORD_BYTES) {
      return err(
        surfaceDynamicInputError(
          'the Surface frame record allocation fits the JavaScript safe integer range',
          'reduce the explicit instance address range before preparing the frame',
        ),
      );
    }
    const requiredFrameBytes = capacity * SURFACE_FRAME_RECORD_BYTES;
    const limit = this.storageBindingLimitError(
      requiredFrameBytes,
      'the Surface frame records fit maxStorageBufferBindingSize',
      'reduce the explicit instance address range or the batch capacity',
    );
    if (limit !== undefined) return err(limit);
    if (requiredFrameBytes <= this.dynamicFrameBufferSize) return ok(false);
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
    this.retireSurfaceBuffer(previous);
    this.dynamicFrameRows.clear();
    this.dynamicFrameRangeSource = undefined;
    return ok(true);
  }

  private ensureSurfaceSharedFrame(): Result<void, RhiError> {
    const state = this.dynamicSharedFrame;
    if (state.buffer === state.fallback && state.fallback === this.emptySurfaceBuffer) {
      const created = this.device.createBuffer({
        label: 'surface-dynamic-shared-frame-input',
        size: SURFACE_SHARED_FRAME_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      });
      if (!created.ok) return created;
      this.trackOwnedBuffer(created.value, SURFACE_SHARED_FRAME_BYTES);
      this.surfaceInputBuffers.add(created.value);
      state.buffer = created.value;
    }
    if (this.boundSharedFrame === state.buffer) return ok(undefined);
    const previous = this.boundSharedFrame;
    this.boundSharedFrame = state.buffer;
    const rebound = this.rebuildInstancesBindGroup();
    if (!rebound.ok) {
      this.boundSharedFrame = previous;
      return rebound;
    }
    this.resetVisibleWindows();
    this.directBindGroups.clear();
    return ok(undefined);
  }

  private writeSurfaceFrameTime(frameTime: number): Result<void, RhiError> {
    if (frameTime === this.dynamicSharedFrame.frameTime) return ok(undefined);
    const payload = new Float32Array(4);
    payload[0] = frameTime;
    const write = this.device.queue.writeBuffer(this.boundSharedFrame, 0, payload);
    if (!write.ok) return write;
    this.dynamicSharedFrame.frameTime = frameTime;
    this.dynamicSharedFrame.writes += 1;
    return ok(undefined);
  }

  /** Write changed frame rows and zero retired rows still inside the frame buffer. */
  private writeSurfaceFrameRows(
    compactFrameRanges: readonly SurfaceFrameRange[],
    frameBufferReplaced: boolean,
  ): Result<void, RhiError> {
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
    const created = this.createVisibleBufferBinding(this.visibleBuffer);
    if (!created.ok) return created;
    this.instancesBindGroup = created.value;
    return ok(undefined);
  }

  pipeline(
    format: TextureFormat | null,
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
    standardSurfaceDiscards?: number,
  ): Result<RenderPipeline, RhiError> {
    const pipelineRenderState = gpuDrivenReflectionFallbackRenderState({
      renderState,
      colorFormat: format,
      additionalColorFormats,
      forwardColorPass,
      reflectionFallbackOutputAvailable:
        selectedArtifact.reflectionFallbackOutputAvailable === true,
    });
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
    // Discards are a compile-time program axis. The factory compiles the
    // selected program; the fixed legacy module is the discard-free program
    // and has no pipeline constant to carry them.
    const surfaceDiscards =
      this.pipelineFactory === undefined
        ? undefined
        : effectiveStandardSurfaceDiscards(selectedArtifact, standardSurfaceDiscards);
    const constants = materialAbiRasterConstants(standardTextureMask, surfaceDiscards);
    const fragmentEntry = colorlessFragmentEntry(
      format === null,
      selectedArtifact.variantSet,
      receipt,
      surfaceDiscards,
      selectedArtifact.fragmentEntry,
      selectedArtifact.program,
      pipelineRenderState?.alphaToCoverageEnabled === true,
    );
    // Projection identity and shader UV count already determine the aliased
    // layout. Do not build a temporary GPU descriptor just to look up its PSO.
    const key = `${String(format)}:${additionalColorFormats.join(',')}|${sampleCount}|${layoutProjection.arrayStride}|${topology}|${stripIndexFormat ?? ''}|${JSON.stringify(pipelineRenderState ?? null)}|${selectedArtifact.material}|${selectedArtifact.layoutIdentity}|${receipt.receiptIdentity}|${receipt.generation}|${selectedArtifact.variantSet ?? ''}|${materialArtifactProgramIdentity(selectedArtifact)}|${selectedArtifact.vertexEntry ?? receipt.sceneIndexEntry}|${legacyFragmentKey(fragmentEntry)}|${layoutProjection.digest}|uv${pipelineUvSetCount}|textures=${standardTextureMask ?? ''}|discards=${surfaceDiscards ?? ''}`;
    const sceneEntry = isVelocityRasterEntry(selectedArtifact.fragmentEntry)
      ? 'vs_temporal'
      : receipt.sceneIndexEntry;
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
          ...(surfaceDiscards === undefined ? {} : { standardSurfaceDiscards: surfaceDiscards }),
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
    const module = resolveStandardPbrProgram(
      this.programs,
      this.artifact.material,
      vertexLayoutHasColor(layoutProjection),
    )?.module;
    if (
      module === undefined ||
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
    const vertexLayouts = deriveVertexBufferLayoutFromProjection(layoutProjection, {
      shaderUvSetCount: pipelineUvSetCount,
    });
    const vertexConstants = materialVertexConstants(constants);
    const pipeline = this.device.createRenderPipeline({
      label: `standard-pbr-gpu-driven.${key}`,
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: selectedArtifact.vertexEntry ?? sceneEntry,
        ...(vertexConstants === undefined ? {} : { constants: vertexConstants }),
        buffers: [...toGpuVertexBufferLayouts(vertexLayouts)],
      },
      ...legacyFragmentState(
        module,
        fragmentEntry,
        constants,
        format === null ? [] : [format, ...additionalColorFormats],
        pipelineRenderState,
      ),
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

  /** Primitive geometry bindings survive resident Scene table replacement. */
  primitiveBindGroup(task?: SkinTaskBinding): Result<BindGroup, RhiError> {
    if (this.deformation === 'rigid') {
      if (this.rigidPrimitive !== undefined) return ok(this.rigidPrimitive);
      const result = createPrimitiveBindGroup(this.device, {
        label: 'gpu-scene-primitive',
        layout: this.meshLayout,
        entries: [],
      });
      if (result.ok) this.rigidPrimitive = result.value;
      return result;
    }
    if (task === undefined)
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'the selected view physical Skin task buffers',
          hint: 'prepare Skin demand before binding this view for raster',
        }),
      );
    const { data, auxiliary } = task;
    let byAuxiliary = this.skinPrimitives.get(data);
    if (byAuxiliary === undefined) {
      byAuxiliary = new WeakMap();
      this.skinPrimitives.set(data, byAuxiliary);
    }
    const hit = byAuxiliary.get(auxiliary);
    const { dataSize, auxiliarySize } = task;
    if (hit !== undefined && hit.dataBytes === dataSize && hit.auxiliaryBytes === auxiliarySize)
      return hit.result;
    const result = createPrimitiveBindGroup(this.device, {
      label: 'gpu-scene-skin-primitive',
      layout: this.meshLayout,
      entries: [
        { binding: 1, resource: bufferBinding(data, 0, dataSize) },
        { binding: 2, resource: bufferBinding(auxiliary, 0, auxiliarySize) },
      ],
    });
    if (result.ok)
      byAuxiliary.set(auxiliary, { dataBytes: dataSize, auxiliaryBytes: auxiliarySize, result });
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.directAddresses = new SurfaceDrawLayout();
    this.directBindGroups.clear();
    if (this.preparingInputBindings !== undefined)
      this.releaseInputBindings(this.preparingInputBindings);
    for (const buffer of this.pendingRetirements) this.destroyOwnedBuffer(buffer);
    this.pendingRetirements.clear();
    this.rigidPrimitive = undefined;
    this.sceneTables = undefined;
    this.dynamicFrameRows.clear();
    this.dynamicFrameRangeSource = undefined;
    this.dynamicInputRangeSource = undefined;
    this.dynamicInputFrameRanges = undefined;
    this.dynamicFrameRangeCapacity = 0;
    this.destroyOwnedBuffer(this.instanceBuffer);
    for (const buffer of this.surfaceInputBuffers) this.destroyOwnedBuffer(buffer);
    this.surfaceInputBuffers.clear();
  }

  private retireSurfaceBuffer(buffer: Buffer): void {
    if (buffer === this.emptySurfaceBuffer) return;
    this.retireOwnedBuffer(buffer);
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
    return this.boundSharedFrame;
  }

  get surfaceDynamicInputBufferSize(): number {
    return this.dynamicInputBufferSize;
  }

  get surfaceDynamicFrameBufferSize(): number {
    return Math.max(SURFACE_FRAME_RECORD_BYTES, this.dynamicFrameBufferSize);
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
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

function publicSurfaceMemberId(member: DynamicInputRange['member']): string {
  return JSON.stringify([
    member.worldIdentity,
    member.entityKey,
    member.drawItemIndex,
    member.instanceOrdinal,
  ]);
}

function sameSurfaceMembers(
  previous: readonly DynamicInputRange['member'][],
  ranges: readonly DynamicInputRange[],
): boolean {
  if (previous.length !== ranges.length) return false;
  for (let i = 0; i < previous.length; i++) {
    const a = previous[i] as DynamicInputRange['member'];
    const b = (ranges[i] as DynamicInputRange).member;
    if (
      a.worldIdentity !== b.worldIdentity ||
      a.entityKey !== b.entityKey ||
      a.drawItemIndex !== b.drawItemIndex ||
      a.instanceOrdinal !== b.instanceOrdinal
    )
      return false;
  }
  return true;
}

const EMPTY_MEMBER_IDS: readonly string[] = Object.freeze([]);

interface SurfaceFrameProjection {
  readonly addresses: SurfaceDrawAddresses<ProjectedSurfaceFrameRange>;
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
  directRanges: readonly DynamicInputRange[],
): Result<readonly ProjectedSurfaceFrameRange[], RhiError> {
  const surfaceMembers: ProjectedSurfaceFrameRange[] = [];
  // Candidate rows follow the encoded plan: batches in order, then candidates.
  let candidateRow = 0;
  for (const prepared of filtered.batches) {
    const firstRow = candidateRow;
    candidateRow += prepared.batch.candidates.length;
    if (prepared.artifact.receipt?.surface?.model !== 'single-layer-medium') continue;
    let nextIndex = 0;
    for (const candidate of prepared.batch.candidates) {
      const index = nextIndex++;
      const slot = scene.slotAt(candidate.primitiveIndex);
      const worldIdentity = slot === undefined ? undefined : scene.sourceIdentity;
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
          entityKey: slot.entityKey,
          drawItemIndex: prepared.batch.binding?.drawItemIndex ?? candidate.drawItemIndex,
          instanceOrdinal: candidate.instanceOrdinal,
        },
      });
    }
  }
  if (ranges.length === 0) return ok(Object.freeze(surfaceMembers));
  const rangeByIdentity = new Map<string, DynamicInputRange>();
  for (const range of ranges) {
    const identity = publicSurfaceMemberId(range.member);
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
  const frameRanges: ProjectedSurfaceFrameRange[] = [];
  for (const member of surfaceMembers) {
    const identity = publicSurfaceMemberId(member.directMember);
    const range = rangeByIdentity.get(identity);
    if (range === undefined) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'every admitted medium draw member resolves one stable-identity Surface range',
          hint: `publish the missing producer range for member ${identity}`,
        }),
      );
    }
    rangeByIdentity.delete(identity);
    frameRanges.push({ frameIndex: member.frameIndex, range, directMember: member.directMember });
  }
  const direct = new Set(directRanges);
  for (const [identity, range] of rangeByIdentity) {
    if (!direct.has(range)) continue;
    frameRanges.push({ frameIndex: candidateRow++, range, directMember: range.member });
    rangeByIdentity.delete(identity);
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
        readonly directMembers: readonly DynamicInputRange['member'][];
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
    directRanges: readonly DynamicInputRange[] = [],
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
      cached.projectionRevision === projectionRevision &&
      sameSurfaceMembers(cached.directMembers, directRanges)
    ) {
      return ok(cached.value);
    }
    this.surfaceFrameRangeBuilds += 1;
    for (const prepared of filtered.batches) {
      if (prepared.artifact.receipt?.surface?.model !== 'single-layer-medium') continue;
      this.surfaceFrameRangeMemberScans += prepared.batch.candidates.length;
    }
    const built = buildProjectedSurfaceFrameRanges(filtered, ranges, scene, directRanges);
    if (!built.ok) return built;
    let capacity = 1;
    const consumptionRanges: DynamicInputRange[] = [];
    for (const entry of built.value) {
      capacity = Math.max(capacity, entry.frameIndex + 1);
      if (entry.range !== undefined) consumptionRanges.push(entry.range);
    }
    const addresses = SurfaceDrawLayout.build(built.value);
    if (!addresses.ok) return addresses;
    const value = {
      addresses: addresses.value,
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
    directRanges: readonly DynamicInputRange[] = [],
  ): void {
    if (this.surfaceFrameRangeCache?.value === value) return;
    this.surfaceFrameRangeCache = {
      filtered,
      slots: scene.slots,
      allocationRevision: scene.scene.allocationRevision,
      page: frame?.page,
      projectionRevision: frame?.projectionRevision ?? 0,
      directMembers: directRanges.map((range) => ({ ...range.member })),
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
    directInput: Parameters<
      NonNullable<GpuDrivenStandardPbrFrameResources['surfaceDirectInstances']>
    >[0],
  ): ReturnType<NonNullable<GpuDrivenStandardPbrFrameResources['surfaceDirectInstances']>> {
    const resolved = materialRaster.directSurfaceInstances(directInput);
    if (!resolved.ok) return resolved;
    const first = directInput.firstInstanceOrdinal ?? 0;
    const count = directInput.instanceCount;
    const addresses = this.surfaceFrameRangeCache?.value.addresses;
    const run = addresses?.layout.get(directInput.entityKey, directInput.drawItemIndex);
    if (addresses === undefined || run === undefined || first < 0 || first + count > run.count) {
      return err(
        surfaceDynamicInputError(
          'every direct Surface command resolves the retained public member identity',
          `rebuild the Surface projection for entity=${directInput.entityKey}, draw=${directInput.drawItemIndex}, instance=${first}`,
        ),
      );
    }
    let memberIds = EMPTY_MEMBER_IDS;
    if (directInput.includeMemberIds !== false) {
      const ids: string[] = [];
      for (let i = run.start + first, end = i + count; i < end; i++) {
        ids.push(
          publicSurfaceMemberId((addresses.members[i] as ProjectedSurfaceFrameRange).directMember),
        );
      }
      memberIds = Object.freeze(ids);
    }
    return ok({ ...resolved.value, memberIds });
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

  /** A readback completes asynchronously. Its member addresses belong to the issuing projection. */
  capturedMemberId(): (entity: number, draw: number, ordinal: number) => string | undefined {
    const addresses = this.surfaceFrameRangeCache?.value.addresses;
    return (entity, draw, ordinal) => {
      const run = addresses?.layout.get(entity, draw);
      if (run === undefined || ordinal < 0 || ordinal >= run.count) return undefined;
      const member = addresses?.members[run.start + ordinal]?.directMember;
      return member === undefined ? undefined : publicSurfaceMemberId(member);
    };
  }

  clear(): void {
    this.surfaceFrameRangeCache = undefined;
    this.consumedSurfaceInput = undefined;
  }
}

const surfaceRowCache = new WeakMap<
  SubmissionPlan,
  { readonly bases: object; readonly layout: number; readonly rows: Uint32Array }
>();

export function surfaceVisibleRows(
  plan: SubmissionPlan,
  scene: PersistentGpuDrivenState,
  visibleSurface: GpuDrivenPrepareInput['visibleSurface'],
): Uint32Array | undefined {
  if (visibleSurface === undefined) return undefined;
  // Rows derive only from the plan and the surface addresses: an unchanged
  // layout reuses the immutable array, so a steady frame does no candidate walk.
  const cached = surfaceRowCache.get(plan);
  if (cached?.bases === visibleSurface.slotBases && cached.layout === visibleSurface.layout)
    return cached.rows;
  const rows = new Uint32Array(plan.candidateCount);
  let row = 0;
  for (const batch of plan.batches) {
    for (const candidate of batch.candidates) {
      const base = visibleSurface.slotBases.get(candidate.primitiveIndex) ?? 0;
      const instanceCount =
        scene.slotAt(candidate.primitiveIndex)?.snapshot.instances?.instanceCount ?? 1;
      rows[row++] =
        base === 0
          ? 0
          : base +
            (batch.binding?.drawItemIndex ?? candidate.drawItemIndex) * instanceCount +
            candidate.instanceOrdinal;
    }
  }
  surfaceRowCache.set(plan, {
    bases: visibleSurface.slotBases,
    layout: visibleSurface.layout,
    rows,
  });
  return rows;
}
