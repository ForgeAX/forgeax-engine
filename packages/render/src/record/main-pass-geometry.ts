import type { MeshVertexStreamRange } from '@forgeax/engine-geometry';
import type { ViewportHitDraw } from '../assembly/viewport-hit-proxy';
import { bindMeshVertexStreams, meshVertexStreamsForPipeline } from '../device/mesh-vertex-streams';
import { viewForPipeline } from '../environment/bindings';
import { materialAlphaMask } from '../material-alpha-mask';
import { materialRasterSource } from '../pipeline-builder';
import { createPrimitiveBindGroup, primitiveForPipeline } from '../reflection/primitive-bindings';
import { CapturedSceneTransform } from '../scene/captured-transform';
import type { DrawRows } from './frame-snapshot';
import {
  createGeometryPipelineRequests,
  drawVertexLayout,
  geometryPipelineRequestContext,
  prepareGeometryPipelineRequests,
} from './geometry-pipeline-requests';
import { ordinaryMaterialViewGroup } from './ordinary-material-depth';
import { selectStandardForwardScreenEntry } from './standard-opaque-entry';

export {
  authoredTransparentDepthWrite,
  geometryRenderStateForPass,
  isHdrGeometryTarget,
  resolveGeometryMaterialVariantSet,
  variantSetForCoveragePass,
} from './geometry-pipeline-requests';

import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { waterProgramEntryPoints } from '../material-program-inputs';

import type { FrameList } from '../scene/frame-list';
import { recordContext } from '../world/view-record-context';
import {
  includeMaterialPass,
  type MaterialHandles,
  MaterialPasses,
  type MaterialPassLookup,
  type MaterialSelectionRows,
  type PreparedGeometryMaterialPasses,
} from './material-pass-groups';

export { effectiveMaterialLayoutIdentity } from '../material-layout-facts';
export { sameOpaqueTemporalDraw } from './material-pass-groups';

// @forgeax/engine-runtime - RendererState record stage: main-pass geometry draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordGeometryDraws + resolveGeometryInstanceBuffer, moved verbatim.

import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  type MaterialSurfacePassKind,
  ok,
  type PassKind,
  type PrimitiveTopology,
} from '@forgeax/engine-types';
import { waterBodyOwnerKey } from '@forgeax/engine-water';
import { dynamicCapacity, shouldShrinkCapacity } from '../dynamic-capacity';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { GpuBuffer } from '../gpu-resource';
import type { GpuSceneTableTextures } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type {
  InstanceBufferCacheEntry,
  InstanceBufferCacheKey,
  InstanceBufferChunkKey,
} from '../instance-buffer-cache';
import { sameInstanceOrdinal } from '../instance-generations';
import {
  type InstanceCollectionFailureCode,
  type InstanceSubmissionLane,
  instancePreviousPairing,
  planInstanceUpload,
} from '../instances';
import { preparedMaterialLayoutIdentity } from '../material-layout-facts';

import {
  classifyOitDraw,
  OIT_FRAGMENT_ENTRY,
  OIT_PREMULTIPLIED_FRAGMENT_ENTRY,
} from '../oit/eligibility';
import {
  createPbrSkinMeshBindGroupEntries,
  isStandardPbrMaterialShader,
  pbrSkinMeshDynamicOffsets,
  projectedStandardMaterialLayout,
  standardPipelineMaterialLayoutIndex,
} from '../pbr-pipeline';

import type { PointsLinesRecordPlan } from '../points-lines/record';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { RenderRecordPhase } from '../render-contract';
import type {
  DispatchEntry,
  DispatchList,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { PROBE_BLEND_RECORD_BYTE_SIZE, probeBlendRecordOffset } from '../scene/probe-blend-record';
import { waterGpuMeshDrawBuffers } from '../water/gpu-mesh-draw';
import { waterMaterialReadsBakedSource } from '../water/material-admission';
import {
  requireWaterMaterialBakedSources,
  waterMaterialBakedSourceBindings,
  waterMaterialFrameDynamicOffsets,
  waterMaterialSystemBindGroup,
} from '../water/wave-material';
import { renderWorldFor } from '../world/render-world';
import { cpuInstanceLodDraws } from './cpu-lod';
import { createFoldedDrawRecorder, resolveFoldInstanceBuffer } from './fold-instance-buffer';
import { clusteredMeshSlotBindGroup, meshSlotBindGroup } from './frame-lighting';
import type { ValidatedRenderable } from './frame-snapshot';

import { getOpaqueResourceIdentity, instanceCollectionCacheKey } from './frame-snapshot';
import { type RenderableDrawReceipt, selectSubmittedMaterialProgram } from './gpu-draw-receipts';
import { type MainPassMaterialBindingResolver, selectMaterialGroup2 } from './main-pass-material';

import { materialFromSubmittedSlots, submittedMaterialRow } from './material-pass-selection';
import {
  type FoldBucket,
  getOrCreateFromChain,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  INSTANCE_UBO_FULL_ARRAY_BYTES,
  type InstanceRowLookup,
  instanceStoragePairing,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  MESH_UBO_FULL_ARRAY_BYTES,
  meshDrawSlot,
  packInstanceStorageRange,
  prepareMeshDraw,
} from './mesh-ssbo';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import { geometryRecordingObserver } from './render-bundle-cache';
import type { _InternalRenderPipelineContext, MaterialShaderPipelineEntry } from './render-context';
import type { SkinTaskBinding } from './skin-tasks';
import { resolveSpriteInstanceDraws } from './sprite-instance-buffer';
import { submeshRange } from './submesh-range';

import { POINTS_LINES_VIEW_SLOT_STRIDE, writePointsLinesViewUbo } from './view-ubo';

const EMPTY_MATERIAL_DRAWS: readonly DispatchEntry[] = Object.freeze([]);

type GeometryInstanceDraw = {
  readonly instanceBuffer: Buffer;
  readonly instanceBindGroup: BindGroup;
  /** Producer-owned Probe buffer paired with probeOffset, when present. */
  readonly probeBuffer?: Buffer;
  /** -1 means the no-probe layout and therefore no dynamic offset. */
  readonly probeOffset: number;
  readonly dynamicOffsets?: readonly number[];
  readonly instanceCount: number;
  readonly firstInstanceOrdinal?: number;
  readonly firstInstance?: number;
  readonly lodLevel?: number;
  readonly range?: import('../device/gpu-residency').MeshGpuRange;
  readonly surfaceFrameBase?: number;
  readonly surfaceMemberIds?: readonly string[];
};

type InstanceUploadResult =
  | {
      readonly ok: true;
      readonly ranges: readonly {
        readonly start: number;
        readonly end: number;
      }[];
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly ranges: readonly {
        readonly start: number;
        readonly end: number;
      }[];
      readonly bytes: number;
    };

type GeometryBindingState = {
  pipeline: RenderPipeline | null;
  instancesBuffer: Buffer | null;
  instanceBindGroup: BindGroup | null;
  readonly instanceOffsets: number[];
};

type GeometryRecordProfileSegment = 'material-bind-groups' | 'pipeline-selection' | 'draw-submit';

function gpuDrivenDrawIndicesBySubmesh(
  source: RenderableSnapshot,
  mesh: ValidatedRenderable['mesh'],
  indices: (number | undefined)[],
): readonly (number | undefined)[] | undefined {
  const draws = source.gpuDrivenDraws;
  if (draws === undefined || draws.length === 0) return undefined;
  indices.length = 0;
  let hasStableSourceIdentity = false;
  // Indexed loops: entries() tuples allocated per draw for every renderable.
  for (let compactIndex = 0; compactIndex < draws.length; compactIndex++) {
    const drawItemIndex = (draws[compactIndex] as (typeof draws)[number]).drawItemIndex;
    if (drawItemIndex === undefined) continue;
    hasStableSourceIdentity = true;
    if (
      mesh.submeshes[drawItemIndex] !== undefined &&
      Number.isInteger(drawItemIndex) &&
      drawItemIndex >= 0
    )
      indices[drawItemIndex] = compactIndex;
  }
  if (hasStableSourceIdentity) return indices;

  // Legacy snapshots predating drawItemIndex are matched by their compact
  // geometry facts. New extracted snapshots never take this path.
  let nonIndexedFirst = 0;
  let drawCursor = 0;
  for (let submeshIndex = 0; submeshIndex < mesh.submeshes.length; submeshIndex++) {
    const submesh = mesh.submeshes[submeshIndex] as (typeof mesh.submeshes)[number];
    const first = mesh.indexed ? submesh.indexOffset : nonIndexedFirst;
    const count = mesh.indexed ? submesh.indexCount : submesh.vertexCount;
    if (!mesh.indexed) nonIndexedFirst += submesh.vertexCount;
    const draw = draws[drawCursor];
    if (
      draw !== undefined &&
      draw.first === first &&
      draw.count === count &&
      draw.materialSlot === submesh.materialSlot &&
      draw.topology === submesh.topology
    ) {
      if (Number.isInteger(submeshIndex) && submeshIndex >= 0) indices[submeshIndex] = drawCursor;
      drawCursor += 1;
    }
  }
  return indices;
}

type IblReceipt = NonNullable<_InternalRenderPipelineContext['frameState']['iblBindingInspection']>;

const NO_IBL_ERRORS: readonly string[] = Object.freeze([]);

/** The material's skylight entries, in binding order, name exactly the frame's IBL resources. */
function skylightEntriesMatch(
  material: NonNullable<IblReceipt['material']>,
  resources: IblReceipt['resources'],
): boolean {
  const { entries, skylightBindingStart } = material;
  let index = 0;
  while (index < entries.length && (entries[index]?.binding ?? 0) < skylightBindingStart) index++;
  return (
    entries[index]?.resourceIdentity === resources.irradiance.viewIdentity &&
    entries[index + 1]?.resourceIdentity === resources.irradiance.samplerIdentity &&
    entries[index + 2]?.resourceIdentity === resources.prefilter.viewIdentity &&
    entries[index + 3]?.resourceIdentity === resources.prefilter.samplerIdentity &&
    entries[index + 4]?.resourceIdentity === resources.brdfLut.viewIdentity &&
    entries[index + 5]?.resourceIdentity === resources.intensityBufferIdentity
  );
}

export function recordIblPipelineBinding(
  c: _InternalRenderPipelineContext,
  material: MaterialSnapshot,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
): void {
  const receipt = c.frameState.iblBindingInspection;
  if (receipt === undefined || !isStandardPbrMaterialShader(material.materialShaderId)) return;
  const materialBgl =
    projectedStandardMaterialLayout(
      c.pipelineState.materialBindGroupLayout,
      standardPipelineMaterialLayoutIndex(pipeline),
    ) ??
    c.runtime.getMaterialBindGroupLayout?.(
      material.materialShaderId ?? 'forgeax::default-standard-pbr',
    ) ??
    c.pipelineState.materialBindGroupLayout;
  const last = c.frameState.iblDrawBinding;
  if (
    last?.receipt === receipt &&
    last.pipeline === pipeline &&
    last.group === materialGroup &&
    last.layout === materialBgl &&
    last.shader === material.materialShaderId &&
    last.schema === material.materialParamSchema
  )
    return;
  const materialReceipt = receipt.material;
  const materialBglIdentity = getOpaqueResourceIdentity(materialBgl as object);
  const bindGroupIdentity = getOpaqueResourceIdentity(materialGroup as object);
  let errors: string[] | undefined;
  if (materialReceipt !== undefined) {
    if (materialReceipt.materialBglIdentity !== materialBglIdentity)
      errors = ['material-pipeline-bgl-identity-mismatch'];
    if (materialReceipt.bindGroupIdentity !== bindGroupIdentity) {
      errors ??= [];
      errors.push('material-bind-group-identity-mismatch');
    }
    if (!skylightEntriesMatch(materialReceipt, receipt.resources)) {
      errors ??= [];
      errors.push('material-ibl-resource-identity-mismatch');
    }
  }
  c.frameState.iblBindingInspection = {
    ...receipt,
    pipeline: {
      pipelineIdentity: getOpaqueResourceIdentity(pipeline as object),
      effectiveMaterialLayoutIdentity: preparedMaterialLayoutIdentity(
        material.materialShaderId ?? 'forgeax::default-standard-pbr',
        material.materialParamSchema,
      ),
      materialBglIdentity,
      bindGroupIdentity,
      drawFrameId: c.frameState.frameNumber,
    },
    status: errors === undefined ? 'binding-chain-consistent' : 'binding-chain-mismatch',
    errors: errors ?? NO_IBL_ERRORS,
  };
  if (last === undefined) {
    c.frameState.iblDrawBinding = {
      receipt: c.frameState.iblBindingInspection,
      pipeline,
      group: materialGroup,
      layout: materialBgl,
      shader: material.materialShaderId,
      schema: material.materialParamSchema,
    };
  } else {
    last.receipt = c.frameState.iblBindingInspection;
    last.pipeline = pipeline;
    last.group = materialGroup;
    last.layout = materialBgl;
    last.shader = material.materialShaderId;
    last.schema = material.materialParamSchema;
  }
}

function geometryRecordPhase(
  passKind: PassKind,
  segment: GeometryRecordProfileSegment,
): RenderRecordPhase {
  const pass = passKind === 'deferred' ? 'g-buffer' : 'forward';
  return `record/graph-execute/${pass}/${segment}` as RenderRecordPhase;
}

// The resolver reads only whether a Pass was selected; its shader, state and
// entries are compared as candidate facts. Per-draw dispatch entries share one key.
/** Color, depth and shadow draws bind the same generation-qualified water closure. */
export function waterGeometryGroup2(
  c: _InternalRenderPipelineContext,
  source: RenderableSnapshot,
  meshBinding: { readonly buffer: Buffer; readonly byteOffset: number },
  layout: BindGroupLayout,
  inputs: import('../material-program-inputs').MaterialProgramInputs | undefined,
  gpu: ReturnType<typeof waterGpuMeshDrawBuffers>,
): {
  readonly group: BindGroup;
  readonly offsets: readonly number[];
  readonly sourceBodyIndices: readonly number[];
  readonly bakedSources: readonly import('../world/view-draw-receipt').WaterBakedSourceDrawReceipt[];
  readonly readsBakedSource: boolean;
  readonly viewIdentity: string;
  readonly frameGeneration: number;
  readonly deviceGeneration: number;
  readonly drawBinding: import('../world/view-draw-receipt').WaterBakedDrawBindingReceipt;
} {
  const entryPoints = waterProgramEntryPoints(inputs);
  if (entryPoints === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'certified Water system inputs of the admitted compiled program',
      hint: 'retain compiled reads and the matching water-frame/3 receipt with the pipeline',
    });
  const water = c.resolveWaterMaterialDrawBinding?.(source);
  if (water === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected:
        'same-view wave/WaterInfo binding and current Body row for the selected deformation',
      hint: 'prepare the generation-qualified Water material closure before recording this draw',
    });
  const sourceIndices = (() => {
    if (source.waterGpuMesh === undefined) return water.sourceBodyIndices;
    const owner = source.waterOwner ?? source.waterMeshTiles;
    if (owner === undefined)
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'generation-qualified Water GPU mesh owner identity',
        hint: 'record GPU WaterMesh draws from the selected Zone owner',
      });
    return source.waterGpuMesh.sourceBodies.map((body) => {
      const key = waterBodyOwnerKey(
        owner.worldIdentity,
        body.guid,
        body.generation,
        owner.zoneGeneration,
      );
      const index = water.frameBindings.bodyIndices.get(key);
      if (index === undefined || water.frameBindings.bodyGenerations.get(key) !== body.generation)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'generation-qualified WaveParam rows for all GPU Water material sources',
          hint: 'prepare the exact same-frame Water body closure',
        });
      return index;
    });
  })();
  requireWaterMaterialBakedSources(water.frameBindings, sourceIndices, inputs);
  const bakedSourceBindings = waterMaterialBakedSourceBindings(water.frameBindings, sourceIndices);
  const bakedSources = bakedSourceBindings.map(({ source: bakedSource, ...binding }) =>
    Object.freeze({
      worldIdentity: bakedSource.worldIdentity,
      bodyIndex: bakedSource.bodyIndex,
      bodyGuid: bakedSource.bodyGuid,
      bodyGeneration: bakedSource.bodyGeneration,
      zoneGeneration: bakedSource.zoneGeneration,
      descriptorRange: bakedSource.descriptorRange,
      sampleRange: bakedSource.sampleRange,
      binding: Object.freeze({
        ...binding,
        descriptorBufferIdentity: getOpaqueResourceIdentity(
          water.frameBindings.bakedDescriptorBuffer as object,
        ),
        sampleBufferIdentity: getOpaqueResourceIdentity(
          water.frameBindings.bakedSamplesBuffer as object,
        ),
        descriptorBufferByteLength: water.frameBindings.bakedDescriptorBytes.byteLength,
        sampleBufferByteLength: water.frameBindings.bakedSampleBytes.byteLength,
        viewIdentity: water.frameBindings.viewIdentity,
        frameGeneration: water.frameBindings.frameGeneration,
        deviceGeneration: water.frameBindings.deviceGeneration,
      }),
      ...(bakedSource.lineage === undefined ? {} : { lineage: bakedSource.lineage }),
    }),
  );
  const readsBakedSource = waterMaterialReadsBakedSource(inputs);
  const waterMeshInstanceDynamicOffset = gpu?.headerOffset ?? water.waterMeshInstanceDynamicOffset;
  const waterMeshInstanceBuffer = gpu?.tiles.buffer ?? water.frameBindings.waterMeshInstanceBuffer;
  const waterMeshInstanceBindingSize =
    gpu?.bindingBytes ?? water.frameBindings.waterMeshInstanceBindingSize;
  const waterMeshInstanceRange = Object.freeze([
    waterMeshInstanceDynamicOffset,
    waterMeshInstanceDynamicOffset + waterMeshInstanceBindingSize,
  ]) as readonly [number, number];
  const drawBinding = Object.freeze({
    viewIdentity: water.frameBindings.viewIdentity,
    frameGeneration: water.frameBindings.frameGeneration,
    deviceGeneration: water.frameBindings.deviceGeneration,
    drawDataBufferIdentity: getOpaqueResourceIdentity(water.frameBindings.drawDataBuffer as object),
    drawDataDynamicOffset: water.dynamicOffset,
    ...(water.waterInfoDynamicOffset === undefined
      ? {}
      : { waterInfoDynamicOffset: water.waterInfoDynamicOffset }),
    waterMeshInstanceBufferIdentity: getOpaqueResourceIdentity(waterMeshInstanceBuffer as object),
    waterMeshInstanceBufferByteLength:
      gpu?.tiles.size ?? water.frameBindings.waterMeshInstanceBytes.byteLength,
    waterMeshInstanceDynamicOffset,
    waterMeshInstanceRange,
    bakedDescriptorBufferIdentity: getOpaqueResourceIdentity(
      water.frameBindings.bakedDescriptorBuffer as object,
    ),
    bakedSamplesBufferIdentity: getOpaqueResourceIdentity(
      water.frameBindings.bakedSamplesBuffer as object,
    ),
  });
  const group = waterMaterialSystemBindGroup(
    c.runtime.device,
    layout,
    water.frameBindings,
    entryPoints,
    {
      mesh: {
        buffer: meshBinding.buffer,
        size: c.runtime.device.caps.storageBuffer
          ? MESH_PER_ENTITY_STRIDE
          : MESH_UBO_FULL_ARRAY_BYTES,
      },
      tiles: gpu === undefined ? undefined : { buffer: gpu.tiles.buffer, size: gpu.bindingBytes },
    },
  );
  return {
    group,
    offsets: [
      meshBinding.byteOffset,
      ...waterMaterialFrameDynamicOffsets(
        {
          ...(water.waterInfoDynamicOffset === undefined
            ? {}
            : { waterInfo: water.waterInfoDynamicOffset }),
          body: water.dynamicOffset,
          mesh: gpu?.headerOffset ?? water.waterMeshInstanceDynamicOffset,
        },
        entryPoints,
        water.frameBindings.waterInfoTextureView !== undefined,
      ),
    ],
    sourceBodyIndices: Object.freeze([...sourceIndices]),
    bakedSources: Object.freeze(bakedSources),
    readsBakedSource,
    viewIdentity: water.frameBindings.viewIdentity,
    frameGeneration: water.frameBindings.frameGeneration,
    deviceGeneration: water.frameBindings.deviceGeneration,
    drawBinding,
  };
}

interface DrawPipelineSelection {
  readonly flags: number;
  readonly layout: object;
  readonly indexFormat: string;
  readonly topology: PrimitiveTopology;
  readonly shaderId: string | undefined;
  readonly renderState: MaterialSnapshot['renderState'];
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly variantSet: string | undefined;
  readonly pipeline: RenderPipeline | null;
  readonly material: MaterialShaderPipelineEntry | null;
  readonly probeBlend: boolean;
  readonly viewOffset: number;
  readonly shader: string | undefined;
  readonly sceneDirect: boolean;
  /** This recording's physical group, first bound after material readiness. */
  viewGroup: BindGroup | null | undefined;
}

/** Compare borrowed draw facts without allocating a per-draw key. */
function matchesDrawPipelineSelection(
  cached: DrawPipelineSelection,
  flags: number,
  entry: import('./frame-snapshot').ValidatedRenderable,
  topology: PrimitiveTopology,
  shaderId: string | undefined,
  renderState: MaterialSnapshot['renderState'],
  vertexEntry: string | undefined,
  fragmentEntry: string | undefined,
  variantSet: string | undefined,
): boolean {
  return (
    cached.flags === flags &&
    cached.layout === drawVertexLayout(entry) &&
    cached.indexFormat === entry.mesh.indexFormat &&
    cached.topology === topology &&
    cached.shaderId === shaderId &&
    cached.renderState === renderState &&
    cached.vertexEntry === vertexEntry &&
    cached.fragmentEntry === fragmentEntry &&
    cached.variantSet === variantSet
  );
}

function profileGeometrySegment<T>(
  c: _InternalRenderPipelineContext,
  passKind: PassKind,
  segment: GeometryRecordProfileSegment,
  action: () => T,
): T {
  const profilePhase = c.profilePhase;
  return profilePhase === undefined
    ? action()
    : profilePhase(geometryRecordPhase(passKind, segment), action);
}

function submitSubmeshDraws(
  pass: RhiRenderPassEncoder,
  state: GeometryBindingState,
  pipeline: RenderPipeline,
  instanceDraws: readonly GeometryInstanceDraw[],
  indexed: boolean,
  defaultRange: import('../device/gpu-residency').MeshGpuRange,
  visibleSurfaceBase: number | undefined,
  water: ReturnType<typeof waterGpuMeshDrawBuffers>,
  onDraw?: (
    draw: GeometryInstanceDraw,
    command: 'draw' | 'draw-indexed',
    range: import('../device/gpu-residency').MeshGpuRange,
    firstInstance: number,
  ) => void,
): void {
  if (state.pipeline !== pipeline) {
    pass.setPipeline(pipeline);
    state.pipeline = pipeline;
  }
  for (let ordinal = 0; ordinal < instanceDraws.length; ordinal++) {
    const instanceDraw = instanceDraws[ordinal] as GeometryInstanceDraw;
    const offsets = instanceDraw.dynamicOffsets;
    const count = offsets?.length ?? (instanceDraw.probeOffset < 0 ? 0 : 1);
    const bound = state.instanceOffsets;
    let needsBinding =
      instanceDraw.instanceBuffer !== state.instancesBuffer ||
      instanceDraw.instanceBindGroup !== state.instanceBindGroup ||
      bound.length !== count;
    for (let i = 0; !needsBinding && i < count; i++)
      needsBinding = bound[i] !== (offsets?.[i] ?? instanceDraw.probeOffset);
    if (needsBinding) {
      bound.length = count;
      for (let i = 0; i < count; i++) bound[i] = offsets?.[i] ?? instanceDraw.probeOffset;
      if (count === 0) pass.setBindGroup(3, instanceDraw.instanceBindGroup);
      else pass.setBindGroup(3, instanceDraw.instanceBindGroup, offsets ?? bound);
      state.instancesBuffer = instanceDraw.instanceBuffer;
      state.instanceBindGroup = instanceDraw.instanceBindGroup;
    }
    const range = instanceDraw.range ?? defaultRange;
    const firstInstance =
      visibleSurfaceBase === undefined
        ? (instanceDraw.firstInstance ?? 0)
        : visibleSurfaceBase + (instanceDraw.firstInstanceOrdinal ?? 0);
    if (indexed && water !== undefined) {
      pass.drawIndexedIndirect(water.args.buffer, water.indirectOffset);
    } else if (indexed) {
      pass.drawIndexed(
        range.count,
        instanceDraw.instanceCount,
        range.first,
        range.baseVertex,
        firstInstance,
      );
    } else {
      pass.draw(range.count, instanceDraw.instanceCount, range.first, firstInstance);
    }
    onDraw?.(instanceDraw, indexed ? 'draw-indexed' : 'draw', range, firstInstance);
  }
}

/**
 * Issues a prepared Points/Lines draw into the already-open geometry pass.
 * Pass lifetime, attachments, bind groups, and submission remain owned by the
 * existing main-pass interpreter.
 */
export function recordPointsLinesDraw(
  pass: RhiRenderPassEncoder,
  plan: PointsLinesRecordPlan,
): void {
  if (plan.drawCount === 0) return;
  if (plan.indexCount > 0) {
    pass.drawIndexed(plan.indexCount, 1, 0, 0, 0);
    return;
  }
  pass.draw(plan.vertexCount, 1, 0, 0);
}

export function geometrySkinBindGroup(
  c: _InternalRenderPipelineContext,
  task: SkinTaskBinding | undefined,
  meshBinding: ReturnType<typeof meshSsboBufferBinding>,
  contract: MaterialShaderPipelineEntry['group2Contract'],
): BindGroup | null {
  const { pipelineState, runtime, frameState, bindGroupCounts } = c;
  if (task === undefined) return null;
  if (contract !== 'skin' && contract !== 'skin-cluster') return null;
  const layout =
    contract === 'skin-cluster'
      ? pipelineState.hdrpSkinMeshBindGroupLayout
      : pipelineState.pbrSkinMeshBindGroupLayout;
  if (layout === null) return null;
  const meshBindSize = runtime.device.caps.storageBuffer
    ? MESH_PER_ENTITY_STRIDE
    : MESH_UBO_FULL_ARRAY_BYTES;
  const skinStats = (pipelineState as { _skinBgCacheStats?: { miss: number; hit: number } })
    ._skinBgCacheStats;
  const skinMissesBefore = bindGroupCounts.createBindGroup;
  const bindGroup = getOrCreateFromChain(
    frameState.meshBindGroupCache,
    [layout, meshBinding.buffer, task.data, task.auxiliary],
    'pbr-skin-mesh',
    () => {
      const result = createPrimitiveBindGroup(runtime.device, {
        label: 'pbr-skin-mesh-bg',
        layout,
        entries: createPbrSkinMeshBindGroupEntries(meshBinding.buffer, meshBindSize, task),
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    bindGroupCounts,
  );
  if (skinStats !== undefined) {
    if (bindGroupCounts.createBindGroup > skinMissesBefore) skinStats.miss += 1;
    else skinStats.hit += 1;
  }
  return bindGroup;
}

function observeGeometryRecording(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder | undefined,
  passKind: PassKind,
  coverageOnly: boolean,
  surfacePass: MaterialSurfacePassKind | undefined,
  oit: 'accumulate' | 'residual' | undefined,
) {
  return pass !== undefined && c.profilePhase !== undefined
    ? geometryRecordingObserver(
        c.frameState.renderBundleCounters,
        `${
          c.camera?.captureProjection === undefined
            ? 'display'
            : c.camera.planarReflection !== undefined
              ? 'reflection'
              : 'target'
        }/${passKind}/${coverageOnly ? 'depth' : (surfacePass ?? oit ?? 'color')}`,
      )
    : undefined;
}

function supportsViewportHitCoverage(
  raster: NonNullable<ReturnType<typeof materialRasterSource>>,
  material: MaterialSnapshot,
  seededDepth: boolean,
): boolean {
  const effects = raster.fragmentEffects;
  // Fresh pick depth cannot assume that the color pass already applied alpha rejection.
  return (
    !(
      seededDepth &&
      raster.descriptor.depthStencil?.depthCompare === 'equal' &&
      materialAlphaMask(material.paramSnapshot)
    ) &&
    effects !== undefined &&
    !effects.writesDepth &&
    !effects.writesSampleMask &&
    !effects.writesStorage
  );
}

function geometryViewportHit(
  context: _InternalRenderPipelineContext,
  passKind: PassKind,
  colorTargets: number,
  coverageOnly: boolean,
) {
  const hit = context.viewportHit;
  return hit?.camera === context.camera &&
    colorTargets > 0 &&
    !coverageOnly &&
    (passKind === 'forward' || passKind === 'deferred')
    ? hit
    : undefined;
}

/**
 * feat-20260704 M3/w19: per-entity geometry (main colour) draw loop, extracted
 * verbatim from encodeMainPass. Walks `c.validatedOrdered`, selects the
 * per-entity / per-submesh PBR / unlit / skin pipeline, uploads the per-submesh
 * material UBO slices, binds view / material / mesh / instances bind groups, and
 * issues the per-submesh draws into the already-begun geometry `pass`. Fully-
 * transparent entities are skipped here (drawn in the LDR blend sub-pass);
 * mixed meshes draw their opaque submeshes here and skip transparent submeshes.
 * The pass-selector match set, per-entity material-slot start table, MSAA sample
 * count, Standard group(2) bind group, fallback mesh group(2) bind group, and
 * the shared per-submesh material BG builder are threaded in explicitly.
 *
 * @internal
 */
export function recordGeometryDraws(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder | undefined,
  matchedMaterials: MaterialSelectionRows | null,
  materialSlotIndices: FrameList<readonly number[]>,
  sampleCount: number,
  meshGroup2: BindGroup | null,
  meshBindGroup: BindGroup | null,
  resolveMaterialBinding: MainPassMaterialBindingResolver | undefined,
  passKind: PassKind = 'forward',
  selectedDispatch?: DispatchList,
  colorFormats: readonly GPUTextureFormat[] = [],
  coverageOnly = false,
  fragmentEntryPoint?: string,
  surfacePass?: MaterialSurfacePassKind,
  transparentDepthWrite = false,
  oit?: 'accumulate' | 'residual',
  preparationPassMatches?: (
    pass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>,
    material: MaterialSnapshot,
  ) => boolean,
  skipPreparationDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
  seededDepth = false,
  depthPrepass = false,
  opaqueDepthPrimed = false,
  materialSceneDepth?: TextureView,
): void {
  const observe = observeGeometryRecording(c, pass, passKind, coverageOnly, surfacePass, oit);
  let recordedDraws = 0;
  const recordPresented = createFoldedDrawRecorder(c);
  const viewportHit = geometryViewportHit(c, passKind, colorFormats.length, coverageOnly);
  const {
    runtime,
    pipelineState,
    dispatchCounts,
    tonemapActive,
    msaaActive,
    validatedOrdered,
    splitLdrSprite,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
  } = c;
  const prepared = admittedGeometryMaterialPasses(c, selectedDispatch, passKind === 'temporal');
  const materialPasses =
    prepared?.groups ?? selectedMaterialPasses(selectedDispatch, passKind === 'temporal');
  // The prepared Standard topology is the frame authority. A bind-group
  // identity is only a resource result; using it to infer the shader lane
  // would silently fall back to URP when the clustered resource is missing.
  let lastViewGroup = viewBindGroup;
  let lastVertexBuffer: Buffer | null = null;
  let lastVertexStreams: readonly MeshVertexStreamRange[] | undefined;
  let lastIndexBuffer: Buffer | null = null;
  let lastIndexFormat: GPUIndexFormat | undefined;
  let lastMeshGroup: BindGroup | undefined;
  let lastMeshOffset: number | undefined;
  let lastMaterialGroup: BindGroup | undefined;
  let lastMaterialOffset: number | undefined;
  const bindingState: GeometryBindingState = {
    pipeline: null,
    instancesBuffer: null,
    instanceBindGroup: null,
    instanceOffsets: [],
  };
  const identityInstanceBuffer = pipelineState.identityInstanceBuffer;
  const instanceBindings = new PassGeometryInstances(c);
  // Color/temporal passes may draw instanced slots from their GPU Scene rows
  // (default-unlit GPU_SCENE_DIRECT): storage tables, or texture tables on
  // devices without vertex storage.
  const sceneDirectPass =
    c.gpuDrivenScene !== undefined &&
    pipelineState.sceneDirectPipelineLayout != null &&
    !coverageOnly &&
    (passKind === 'forward' || passKind === 'temporal');
  const materialGroup1DynamicOffsets = new Uint32Array(1);
  const meshGroup2DynamicOffsets = [0];
  let lastStencilReference: number | null = null;
  let lastViewOffset = viewBindGroupDynamicOffset;
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
  // sprite PSO selection no longer maintains a dedicated tag — the
  // generic materialShaderId path covers sprite via the same per-
  // MaterialShader pipeline cache PBR / unlit use. The 4-placeholder
  // BG bindings (D-1 candidate b) still apply via the generic per-
  // submesh BG construction below; sprite's `forgeax::sprite` shader
  // module ships through the same cache key formula.
  const pipelineContext = geometryPipelineRequestContext(c);
  const pipelineRequests = createGeometryPipelineRequests(
    pipelineContext,
    {
      passKind,
      sampleCount,
      colorFormats,
      coverageOnly,
      tonemapActive,
      msaaActive,
      viewBindGroupDynamicOffset,
      transparentDepthWrite,
      seededDepth,
      depthPrepass,
      opaqueDepthPrimed,
      ...(surfacePass === undefined ? {} : { surfacePass }),
      oit,
    },
    (action) => profileGeometrySegment(c, passKind, 'pipeline-selection', action),
  );
  const { resolvePointsLinesPipeline, resolveDrawPipeline, pipelineSelection, viewOffsetForBlend } =
    pipelineRequests;
  const drawPipelines = new Map<MaterialSnapshot, DrawPipelineSelection[]>();
  const resolveSharedDrawPipeline = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smTopology: PrimitiveTopology,
    submeshMaterial: MaterialSnapshot,
    selectedPass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'> | undefined,
    selectedShaderId: string | undefined,
    selectedRenderState: MaterialSnapshot['renderState'],
    vertexEntry: string | undefined,
    fragmentEntry: string | undefined,
    oitAccumulateDraw: boolean,
    authoredVariantSet: string | undefined,
    sceneDirect: boolean,
  ): DrawPipelineSelection | boolean => {
    const source = entry.source;
    const hasWaterOwner =
      (source as typeof source & { readonly waterOwner?: unknown }).waterOwner !== undefined;
    const flags =
      (source.skinBinding !== undefined ? 1 : 0) |
      (source.probeBlendRecord !== undefined ? 2 : 0) |
      (CapturedSceneTransform.reflected(source.transform) ? 4 : 0) |
      (source.spriteInstances !== undefined ? 8 : 0) |
      (oitAccumulateDraw ? 16 : 0) |
      (sceneDirect ? 32 : 0) |
      (selectedPass !== undefined ? 64 : 0);
    const candidates = hasWaterOwner ? undefined : drawPipelines.get(submeshMaterial);
    if (candidates !== undefined) {
      for (let index = 0; index < candidates.length; index++) {
        const cached = candidates[index] as DrawPipelineSelection;
        if (
          matchesDrawPipelineSelection(
            cached,
            flags,
            entry,
            smTopology,
            selectedShaderId,
            selectedRenderState,
            vertexEntry,
            fragmentEntry,
            authoredVariantSet,
          )
        ) {
          pipelineSelection.pipeline = cached.pipeline;
          pipelineSelection.material = cached.material;
          pipelineSelection.probeBlend = cached.probeBlend;
          pipelineSelection.viewOffset = cached.viewOffset;
          pipelineSelection.shader = cached.shader;
          pipelineSelection.sceneDirect = cached.sceneDirect;
          pipelineSelection.variantSet = cached.variantSet;
          return cached;
        }
      }
    }
    pipelineRequests.reported = false;
    const resolved = resolveDrawPipeline(
      entry,
      smTopology,
      submeshMaterial,
      selectedPass,
      selectedShaderId,
      selectedRenderState,
      vertexEntry,
      fragmentEntry,
      oitAccumulateDraw,
      authoredVariantSet,
      false,
      sceneDirect,
    );
    // A fallback without a material pipeline entry may still be pending.
    if (
      !resolved ||
      pipelineRequests.reported ||
      pipelineSelection.pipeline === null ||
      pipelineSelection.material === null
    )
      return resolved;
    // Each water body resolves its own pipeline selection.
    if (hasWaterOwner) return true;
    const selection: DrawPipelineSelection = {
      flags,
      layout: drawVertexLayout(entry),
      indexFormat: entry.mesh.indexFormat,
      topology: smTopology,
      shaderId: selectedShaderId,
      renderState: selectedRenderState,
      vertexEntry,
      fragmentEntry,
      variantSet: authoredVariantSet,
      pipeline: pipelineSelection.pipeline,
      material: pipelineSelection.material,
      probeBlend: pipelineSelection.probeBlend,
      viewOffset: pipelineSelection.viewOffset,
      shader: pipelineSelection.shader,
      sceneDirect: pipelineSelection.sceneDirect,
      viewGroup: undefined,
    };
    if (candidates === undefined) drawPipelines.set(submeshMaterial, [selection]);
    else candidates.push(selection);
    return selection;
  };

  if (preparationPassMatches !== undefined)
    prepareGeometryPipelineRequests(
      {
        ...pipelineContext,
        frameState: c.frameState,
        ...(c.materialFrame === undefined ? {} : { materialFrame: c.materialFrame }),
        ...(c.pipelinePreparationEntries === undefined
          ? {}
          : { pipelinePreparationEntries: c.pipelinePreparationEntries }),
      },
      {
        passKind,
        sampleCount,
        colorFormats,
        coverageOnly,
        tonemapActive,
        msaaActive,
        viewBindGroupDynamicOffset,
        transparentDepthWrite,
        seededDepth,
        oit,
        ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
      },
      preparationPassMatches,
      skipPreparationDraw,
      pipelineRequests,
    );

  // Preparation shares the exact resolver but never opens or binds a raster pass.
  if (pass === undefined) return;
  const bindMeshGroup = (group: BindGroup, offsets: readonly number[]): void => {
    // Ordinary geometry uses one offset in mutable scratch. Snapshot the value at encode.
    const offset = offsets.length === 1 ? offsets[0] : undefined;
    if (offset !== undefined && group === lastMeshGroup && offset === lastMeshOffset) return;
    pass.setBindGroup(2, group, offsets);
    lastMeshGroup = group;
    lastMeshOffset = offset;
  };

  if (resolveMaterialBinding === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'geometry drawing has material bindings',
      hint: 'use preparation-only mode without a render pass or supply the draw material resolver',
    });

  const directInstanceDraw: SceneDirectDraw[] = [];

  // Rebuilt per source and owned by this invocation, including nested recording.
  const drawIndicesScratch: (number | undefined)[] = [];
  // Per-entity draw state: the entity's physical mesh address and fold, plus
  // the mesh binding and base instance draws its first surviving draw
  // prepares for every later submesh pass of the same entity.
  let entityMeshSlot = 0;
  let entityMaterialSlots: readonly number[] | undefined;
  let entityBindingSlots: readonly number[] | undefined;
  let entityMeshStaged = false;
  let entityFold: FoldBucket | undefined;
  let entityDrawIndices: readonly (number | undefined)[] | undefined;
  let addressedEntityDraws = false;
  const compactDrawAt = (entry: ValidatedRenderable, submesh: number) => {
    if (!addressedEntityDraws) {
      entityDrawIndices = gpuDrivenDrawIndicesBySubmesh(
        entry.source,
        entry.mesh,
        drawIndicesScratch,
      );
      addressedEntityDraws = true;
    }
    return submeshDrawIndex(entityDrawIndices, submesh);
  };
  let entityMeshBinding: ReturnType<typeof meshSsboBufferBinding> | undefined;
  let entityInstanceDraws: readonly GeometryInstanceDraw[] | undefined;
  // Set when the entity's instances are drawn from its GPU Scene rows.
  let entitySceneDirect = false;
  let entityDirectMeshGroup = meshBindGroup;
  let entitySkinTask: SkinTaskBinding | undefined;
  let group2DynamicOffsets: readonly number[] = meshGroup2DynamicOffsets;

  // One admitted row owns the same physical mesh payload across its
  // submeshes. Other rows and passes still consult the actual slot mirror.
  const stageEntityMesh = (entry: ValidatedRenderable): void => {
    if (prepared !== undefined && entityMeshStaged) return;
    prepareMeshDraw(c, entry, entityFold !== undefined, entityMeshSlot);
    entityMeshStaged = true;
  };

  const bindStencilReference = (stencilReference: number): void => {
    if (stencilReference === lastStencilReference) return;
    pass.setStencilReference(stencilReference);
    lastStencilReference = stencilReference;
  };

  // Points/Lines share the Standard geometry pass. Their retained source is
  // prepared once by the renderer owner, while this loop remains the sole
  // pass/draw submission owner and preserves the authored topology.
  const recordPointsLines = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    submission: NonNullable<ReturnType<NonNullable<typeof c.pointsLines>['submission']>>,
    style: NonNullable<RenderableSnapshot['pointsLines']>['style'],
  ): void => {
    bindStencilReference(entry.stencilReference ?? 0);
    const pointsLinesOffset = (c.pointsLines?.slot(entry) ?? 0) * POINTS_LINES_VIEW_SLOT_STRIDE;
    // Like a transparent submesh, a blended point/line draw belongs to the
    // LDR blend sub-pass only; drawing it here too would blend it twice.
    const pointsLinesMaterial = materialFromSubmittedSlots(c.materialSlots, entityMaterialSlots);
    if (
      splitLdrSprite &&
      (pointsLinesMaterial.transparent === true ||
        pointsLinesMaterial.renderState?.blend !== undefined)
    )
      return;
    const pointsLinesBinding = resolveMaterialBinding(
      entityBindingSlots?.[0] ?? 0,
      pointsLinesMaterial,
      entry.source.entityKey,
      entry.world ?? c.world,
      POINTS_LINES_MATERIAL_SHADER_ID,
    );
    const pointsLinesPipelineEntry = resolvePointsLinesPipeline(
      pointsLinesMaterial,
      style,
      submission.layoutProjection,
    );
    if (pointsLinesPipelineEntry === null) return;
    const pointsLinesPipeline = pointsLinesPipelineEntry.pipeline;
    if (pipelineState.pointsLinesViewBuffer === undefined) return;
    writePointsLinesViewUbo(
      runtime.device.queue,
      pipelineState.pointsLinesViewBuffer,
      c.camera,
      c.targetW,
      c.targetH,
      entry.source.transform.world,
      style,
      pointsLinesOffset,
    );
    pass.setBindGroup(
      0,
      viewBindGroup as BindGroup,
      new Uint32Array([
        viewOffsetForBlend(
          pointsLinesMaterial.renderState?.blend,
          pointsLinesMaterial.renderState?.fog,
        ),
        pointsLinesOffset,
      ]),
      0,
      2,
    );
    pass.setPipeline(pointsLinesPipeline);
    bindingState.pipeline = pointsLinesPipeline;
    pass.setVertexBuffer(0, submission.vertexBuffer);
    pass.setIndexBuffer(submission.indexBuffer, 'uint32');
    lastVertexBuffer = submission.vertexBuffer;
    lastVertexStreams = undefined;
    lastIndexBuffer = submission.indexBuffer;
    lastIndexFormat = 'uint32';
    materialGroup1DynamicOffsets[0] = pointsLinesBinding.byteOffset;
    pass.setBindGroup(1, pointsLinesBinding.group, materialGroup1DynamicOffsets, 0, 1);
    lastMaterialGroup = undefined;
    const pointsLinesMeshGroup =
      pipelineState.meshStorageBuffer.pages === undefined
        ? (meshBindGroup ?? meshGroup2)
        : meshSlotBindGroup(
            runtime.device,
            c.frameState,
            pipelineState,
            c.bindGroupCounts,
            entityMeshSlot * MESH_PER_ENTITY_STRIDE,
          );
    meshGroup2DynamicOffsets[0] = meshSsboBufferBinding(
      pipelineState.meshStorageBuffer,
      entityMeshSlot * MESH_PER_ENTITY_STRIDE,
    ).byteOffset;
    if (pointsLinesMeshGroup === null) return;
    stageEntityMesh(entry);
    bindMeshGroup(pointsLinesMeshGroup, meshGroup2DynamicOffsets);
    const pointsLinesInstancesBg = instanceBindings.identity()[0].instanceBindGroup;
    pass.setBindGroup(3, pointsLinesInstancesBg);
    bindingState.instancesBuffer = identityInstanceBuffer;
    bindingState.instanceBindGroup = pointsLinesInstancesBg;
    bindingState.instanceOffsets.length = 0;
    recordPointsLinesDraw(pass, submission.plan);
    if (observe !== undefined && submission.plan.drawCount !== 0) recordedDraws++;
    viewportHit?.reject('geometry-coverage');
    c.onRenderableDraw?.(entry);
    pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);
    lastViewOffset = viewBindGroupDynamicOffset;
    lastViewGroup = viewBindGroup;
  };

  // GPU ownership is per submesh. Prepare CPU buffers only after the exact
  // claim, material-pass and transparency filters leave a draw.
  /** Bind the entity's vertex/index buffers and prepare its base instance draws. */
  const bindEntityGeometry = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    meshBinding: ReturnType<typeof meshSsboBufferBinding>,
  ): boolean => {
    entityDirectMeshGroup =
      pipelineState.meshStorageBuffer.pages === undefined
        ? meshBindGroup
        : meshSlotBindGroup(
            runtime.device,
            c.frameState,
            pipelineState,
            c.bindGroupCounts,
            entityMeshSlot * MESH_PER_ENTITY_STRIDE,
          );
    meshGroup2DynamicOffsets[0] = meshBinding.byteOffset;
    const gpuVertex = entry.source.gpuVertexSource;
    let vertexBuffer = entry.mesh.vertexBuffer.handle;
    if (gpuVertex) {
      const output = runtime.viewOwner?.preparedResolver.gpuWork.resolveNamedBuffer(
        gpuVertex.feature,
        gpuVertex.resource,
      );
      if (!output || output.size < entry.mesh.vboBytes || (output.physicalUsage & 32) === 0) {
        runtime.errorRegistry.fire(
          new RhiError({
            code: 'rhi-not-available',
            expected:
              'current feature vertex output matches the actual MeshAsset layout and extent',
            hint: 'prepare the declared storage/vertex buffer through the native RenderFeature before rendering this mesh',
          }),
        );
        return false;
      }
      vertexBuffer = output.buffer;
    }
    if (
      (gpuVertex !== undefined || entry.mesh.vertexStreams === undefined) &&
      (vertexBuffer !== lastVertexBuffer || lastVertexStreams !== undefined)
    ) {
      pass.setVertexBuffer(0, vertexBuffer);
      lastVertexBuffer = vertexBuffer;
      lastVertexStreams = undefined;
    }
    // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
    // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
    // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
    if (
      entry.mesh.indexed &&
      entry.mesh.indexBuffer !== null &&
      (entry.mesh.indexBuffer.handle !== lastIndexBuffer ||
        entry.mesh.indexFormat !== lastIndexFormat)
    ) {
      pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
      lastIndexBuffer = entry.mesh.indexBuffer.handle;
      lastIndexFormat = entry.mesh.indexFormat;
    }
    const sceneDirectDraws =
      entityFold === undefined && sceneDirectPass
        ? resolveSceneDirectInstanceDraws(c, entry, directInstanceDraw)
        : undefined;
    entitySceneDirect = sceneDirectDraws !== undefined;
    const prepared =
      sceneDirectDraws ??
      (entityFold === undefined
        ? instanceBindings.resolve(entry, false)
        : foldInstanceDraws(c, entityFold, entry.renderableIndex));
    if (prepared === null) return false;
    entityInstanceDraws = prepared;
    return true;
  };

  /**
   * Per-submesh material bind group (group 1). Texture views resolve from the
   * submesh's own material slot; identical-texture-set submeshes, on the same
   * or different entities, share one group via the shaderId-outer
   * `materialBgShared` cache.
   */
  let hitMaterialOffset: number | undefined;
  const bindSubmeshMaterial = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    sourceSlot: number,
    submeshMaterial: MaterialSnapshot,
    selectedShaderId: string | undefined,
    standardMaterialLayoutIndex: number,
  ): import('./main-pass-material').MainPassMaterialBinding => {
    const materialSlot = entityBindingSlots?.[sourceSlot] ?? entityBindingSlots?.[0] ?? 0;
    const binding =
      c.profilePhase === undefined
        ? resolveMaterialBinding(
            materialSlot,
            submeshMaterial,
            entry.source.entityKey,
            entry.world ?? c.world,
            selectedShaderId,
            standardMaterialLayoutIndex,
          )
        : profileGeometrySegment(c, passKind, 'material-bind-groups', () =>
            resolveMaterialBinding(
              materialSlot,
              submeshMaterial,
              entry.source.entityKey,
              entry.world ?? c.world,
              selectedShaderId,
              standardMaterialLayoutIndex,
            ),
          );
    const offset = binding.dynamicOffsetCount === 0 ? undefined : binding.byteOffset;
    // The native recorder owns the consecutive rows and the pass state. Use
    // the resolved physical group and dynamic offset, including no-offset
    // layouts, rather than inferring equivalence from a material ID.
    if (
      prepared === undefined ||
      lastMaterialGroup !== binding.group ||
      lastMaterialOffset !== offset
    ) {
      materialGroup1DynamicOffsets[0] = binding.byteOffset;
      pass.setBindGroup(
        1,
        binding.group,
        materialGroup1DynamicOffsets,
        0,
        binding.dynamicOffsetCount,
      );
      lastMaterialGroup = binding.group;
      lastMaterialOffset = offset;
    }
    if (viewportHit !== undefined) hitMaterialOffset = offset;
    return binding;
  };

  /**
   * Standard and authored Surface share the ProbeBlend ABI. Resolve this per
   * submesh so mixed unlit/lit meshes cannot cross layouts.
   */
  const submeshInstanceDraws = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smIdx: number,
    submeshMaterial: MaterialSnapshot,
    probeBlendAvailable: boolean,
  ): readonly GeometryInstanceDraw[] | null => {
    // A pending scene-direct build draws this submesh from packed instances.
    const resolvedInstanceDraws =
      probeBlendAvailable || (entitySceneDirect && !pipelineSelection.sceneDirect)
        ? instanceBindings.resolve(entry, probeBlendAvailable)
        : entityInstanceDraws;
    if (resolvedInstanceDraws == null) return null;
    const medium =
      entry.source.waterGpuMesh === undefined &&
      submeshMaterial.surfaceModel === 'single-layer-medium' &&
      (passKind === 'forward' || passKind === 'temporal');
    const deferredSurface = passKind === 'deferred' && c.visibleSurface !== undefined;
    let sourceDrawItemIndex = smIdx;
    if (medium || deferredSurface) {
      const compactDrawIndex = compactDrawAt(entry, smIdx);
      const draw =
        compactDrawIndex === undefined
          ? undefined
          : entry.source.gpuDrivenDraws?.[compactDrawIndex];
      if (draw !== undefined && compactDrawIndex !== undefined)
        sourceDrawItemIndex = gpuDrivenSourceDrawItemIndex(draw, compactDrawIndex);
    }
    const instanceDraws = medium
      ? resolveSurfaceDirectInstanceDraws(c, entry, sourceDrawItemIndex, resolvedInstanceDraws)
      : resolvedInstanceDraws;
    if (instanceDraws === null) return null;
    submittedWaterGeometry =
      entry.source.waterGpuMesh === undefined
        ? undefined
        : waterGpuMeshDrawBuffers(c, entry.source);
    visibleSurfaceInstanceBase =
      deferredSurface && submittedWaterGeometry === undefined
        ? sourceDrawItemIndex * (entry.source.instances?.instanceCount ?? 1)
        : undefined;
    // Generated Water grids are indexed. Preserve direct non-indexed page offsets
    // for a borrowed Water source before LOD intersects its page windows.
    return submittedWaterGeometry !== undefined && !entry.mesh.indexed
      ? instanceDraws.map((draw) => ({ ...draw, firstInstance: 0 }))
      : instanceDraws;
  };

  /**
   * The selected submesh Pass owns its group(2) contract. Rigid Passes on the
   * same Mesh do not demand Skin or borrow another Pass's task binding.
   */
  const selectSubmeshGroup2 = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    group2Contract: NonNullable<MaterialShaderPipelineEntry['group2Contract']>,
    meshBinding: ReturnType<typeof meshSsboBufferBinding>,
  ): BindGroup | null => {
    if (group2Contract !== 'skin' && group2Contract !== 'skin-cluster') {
      const entryMeshGroup2 =
        group2Contract === 'cluster' && pipelineState.meshStorageBuffer.pages !== undefined
          ? clusteredMeshSlotBindGroup(c, entityMeshSlot * MESH_PER_ENTITY_STRIDE)
          : meshGroup2;
      group2DynamicOffsets = meshGroup2DynamicOffsets;
      return selectMaterialGroup2(entryMeshGroup2, entityDirectMeshGroup, group2Contract);
    }
    if (entry.source.skinBinding === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'a Skin Binding for the selected material Skin contract',
        hint: 'bind a complete Skin source before recording a Skin-input material',
      });
    entitySkinTask ??= runtime.skinTask?.(entry.source, 'main');
    const skinTask = entitySkinTask;
    if (skinTask === undefined) return null;
    const selectedGroup = geometrySkinBindGroup(c, skinTask, meshBinding, group2Contract);
    if (selectedGroup === null) return null;
    group2DynamicOffsets = pbrSkinMeshDynamicOffsets(
      meshBinding.byteOffset,
      skinTask,
      runtime.device.caps.storageBuffer,
    );
    return selectedGroup;
  };

  // One synchronous geometry pass owns its prepared submit callbacks. Nested
  // recording has its own locals. Equal adjacent draws share immutable facts;
  // entity and submesh identity still travel through every presentation callback.
  let submittedEntry: ValidatedRenderable;
  let submittedSubmesh: number;
  let submittedMaterial: MaterialSnapshot;
  let submittedPass: DispatchEntry | undefined;
  let submittedPipeline: RenderPipeline;
  let submittedMaterialPipeline: MaterialShaderPipelineEntry | null;
  let submittedShader: string | undefined;
  let submittedFold: FoldBucket | undefined;
  const rangeScratch = { first: 0, count: 0, baseVertex: 0 };
  let submittedRange: ReturnType<typeof submeshRange>;
  let submittedInstances: readonly GeometryInstanceDraw[];
  let submittedWaterGeometry: ReturnType<typeof waterGpuMeshDrawBuffers>;
  let visibleSurfaceInstanceBase: number | undefined;
  let hitDraw:
    | Pick<ViewportHitDraw, 'pipeline' | 'state'>
    | Omit<ViewportHitDraw, 'first' | 'count' | 'baseVertex' | 'instanceCount' | 'firstInstance'>
    | undefined;
  let submittedWaterBaked:
    | {
        readonly sourceBodyIndices: readonly number[];
        readonly bakedSources: readonly import('../world/view-draw-receipt').WaterBakedSourceDrawReceipt[];
        readonly viewIdentity: string;
        readonly frameGeneration: number;
        readonly deviceGeneration: number;
        readonly drawBinding: import('../world/view-draw-receipt').WaterBakedDrawBindingReceipt;
      }
    | undefined;
  let presentedFacts: RenderableDrawReceipt | undefined;
  let presentedHasPass = false;
  const recordViewportHit = (
    draw: GeometryInstanceDraw,
    range: import('../device/gpu-residency').MeshGpuRange,
    firstInstance: number,
  ): void => {
    if (hitDraw !== undefined && viewportHit !== undefined) {
      if (submittedWaterGeometry !== undefined) viewportHit.reject('geometry-coverage');
      else if ('bindings' in hitDraw) {
        const offsets =
          draw.dynamicOffsets?.slice() ?? (draw.probeOffset < 0 ? [] : [draw.probeOffset]);
        viewportHit.record({
          ...hitDraw,
          ...range,
          bindings: [...hitDraw.bindings, { group: draw.instanceBindGroup, offsets }],
          instanceCount: draw.instanceCount,
          firstInstance,
        });
      } else viewportHit.recordPipeline(hitDraw);
    }
  };
  const recordPreparedSubmesh = (
    draw: GeometryInstanceDraw,
    command: 'draw' | 'draw-indexed',
    range: import('../device/gpu-residency').MeshGpuRange,
    firstInstance: number,
  ): void => {
    const unsupportedLineage =
      passKind !== 'forward' ||
      submittedFold !== undefined ||
      submittedEntry.source.instances !== undefined ||
      submittedEntry.source.skinBinding !== undefined ||
      draw.instanceCount !== 1;
    const hasPass = submittedPass !== undefined;
    const passIndex = submittedPass === undefined ? 0 : submittedPass.passIndex;
    if (
      presentedFacts === undefined ||
      submittedWaterBaked !== undefined ||
      presentedFacts.pipeline !== submittedPipeline ||
      presentedFacts.material !== submittedMaterial ||
      presentedFacts.unsupportedLineage !== unsupportedLineage ||
      presentedFacts.programKey !== submittedShader ||
      presentedHasPass !== hasPass ||
      (hasPass && !Object.is(presentedFacts.passIndex, passIndex))
    ) {
      const facts: {
        -readonly [K in keyof RenderableDrawReceipt]: RenderableDrawReceipt[K];
      } = {
        lane: 'cpu',
        ready: true,
        pipeline: submittedPipeline,
        material: submittedMaterial,
        unsupportedLineage,
      };
      if (hasPass) facts.passIndex = passIndex;
      if (submittedShader !== undefined) facts.programKey = submittedShader;
      if (submittedWaterBaked !== undefined) {
        const source = submittedEntry.source;
        const publication = submittedMaterial.materialPublication;
        const identity = publication?.identity;
        const selectedProgram = selectSubmittedMaterialProgram(
          publication?.programs,
          hasPass,
          passIndex,
          submittedShader,
        );
        facts.waterBaked = Object.freeze({
          entityKey: source.entityKey,
          submeshIndex: submittedSubmesh,
          materialSlot: submittedEntry.mesh.submeshes[submittedSubmesh]?.materialSlot ?? -1,
          viewIdentity: submittedWaterBaked.viewIdentity,
          frameId: submittedWaterBaked.frameGeneration,
          deviceGeneration: submittedWaterBaked.deviceGeneration,
          graphGeneration: c.runtime.observationGraphGeneration ?? -1,
          drawKey: source.waterOwner?.drawKey ?? source.waterMeshTiles?.drawKey ?? '',
          ownerWorldIdentity:
            source.waterOwner?.worldIdentity ?? source.waterMeshTiles?.worldIdentity ?? '',
          drawBinding: submittedWaterBaked.drawBinding,
          materialIdentity: Object.freeze({
            materialGuid: identity?.materialGuid ?? '',
            publicationGeneration: identity?.publicationGeneration ?? -1,
            ...(identity?.specializationKey === undefined
              ? {}
              : { specializationKey: identity.specializationKey }),
            ...(identity?.artifactHash === undefined
              ? {}
              : { artifactHash: identity.artifactHash }),
            ...(selectedProgram === undefined
              ? {}
              : { programKey: selectedProgram.specializationKey }),
          }),
          ...(selectedProgram === undefined
            ? {}
            : {
                programIdentity: Object.freeze({
                  pass: selectedProgram.pass,
                  context: Object.freeze({ ...selectedProgram.context }),
                  address: selectedProgram.address,
                  specializationKey: selectedProgram.specializationKey,
                  artifactHash: selectedProgram.artifactHash,
                }),
              }),
          sourceBodyIndices: submittedWaterBaked.sourceBodyIndices,
          sources: submittedWaterBaked.bakedSources,
        });
      }
      presentedFacts = Object.freeze(facts);
      presentedHasPass = hasPass;
    }
    if (observe !== undefined) recordedDraws++;
    recordPresented(submittedEntry, submittedSubmesh, presentedFacts, submittedFold);
    recordViewportHit(draw, range, firstInstance);
    if (surfacePass !== undefined && draw.surfaceFrameBase !== undefined) {
      c.frameState.surfaceSubmissionObservation?.record(surfacePass, {
        kind: command,
        count: range.count,
        first: range.first,
        instanceCount: draw.instanceCount,
        firstInstance: 0,
        surfaceFrameBase: draw.surfaceFrameBase,
        memberIds: draw.surfaceMemberIds ?? [],
        pipelineIdentity: getOpaqueResourceIdentity(submittedPipeline as object),
        ...(submittedMaterialPipeline?.materialProgramKey === undefined
          ? {}
          : { materialProgramKey: submittedMaterialPipeline.materialProgramKey }),
        ...(submittedMaterialPipeline?.receipt === undefined
          ? {}
          : {
              receiptIdentity: submittedMaterialPipeline.receipt.identity,
              receiptGeneration: submittedMaterialPipeline.receipt.generation,
            }),
      });
    }
  };
  const observeSubmittedDraws =
    c.onRenderableDraw !== undefined ||
    viewportHit !== undefined ||
    observe !== undefined ||
    (surfacePass !== undefined && c.frameState.surfaceSubmissionObservation !== undefined);
  const submitPreparedSubmesh = (): void => {
    submitSubmeshDraws(
      pass,
      bindingState,
      submittedPipeline,
      submittedInstances,
      submittedEntry.mesh.indexed,
      submittedRange,
      visibleSurfaceInstanceBase,
      submittedWaterGeometry,
      observeSubmittedDraws ? recordPreparedSubmesh : undefined,
    );
  };

  const prepareViewportHitDraw = (
    viewportHit: NonNullable<_InternalRenderPipelineContext['viewportHit']>,
    entry: ValidatedRenderable,
    submeshMaterial: MaterialSnapshot,
    selectedPass: DispatchEntry | undefined,
    smPipelineHandle: RenderPipeline,
    smMaterialShaderId: string | undefined,
    drawViewGroup: BindGroup | null,
    viewOffset: number,
    perSubmeshBg: BindGroup,
    selectedGroup2: BindGroup,
    selectedGroup2Offsets: readonly number[],
    water: boolean,
  ): void => {
    hitDraw = undefined;
    const state =
      selectedPass === undefined ? submeshMaterial.renderState : selectedPass.renderState;
    if (submeshMaterial.transparent !== true && state?.blend === undefined) {
      const raster = materialRasterSource(smPipelineHandle);
      if (
        entityFold !== undefined ||
        entry.source.gpuVertexSource !== undefined ||
        water ||
        state?.stencil !== undefined ||
        raster?.descriptor.multisample?.alphaToCoverageEnabled ||
        drawViewGroup === null ||
        raster === undefined ||
        raster.descriptor.depthStencil === undefined
      )
        viewportHit.reject('geometry-coverage');
      else if (!supportsViewportHitCoverage(raster, submeshMaterial, seededDepth))
        viewportHit.reject('material-coverage', {
          entity: entry.source.entityKey,
          shader: smMaterialShaderId,
          entryPoint: raster.descriptor.fragment?.entryPoint,
          effects: raster.fragmentEffects,
        });
      else if (viewportHit.warmup) hitDraw = { pipeline: smPipelineHandle, state };
      else {
        const mesh = entry.mesh;
        hitDraw = {
          entity: state?.colorWriteMask === 0 ? null : entry.source.entityKey,
          pipeline: smPipelineHandle,
          state,
          vertex: mesh.vertexBuffer.handle,
          vertexStreams: mesh.vertexStreams,
          indices:
            mesh.indexBuffer === null
              ? null
              : { buffer: mesh.indexBuffer.handle, format: mesh.indexFormat },
          bindings: [
            { group: drawViewGroup, offsets: [viewOffset, 0] },
            {
              group: perSubmeshBg,
              offsets: hitMaterialOffset === undefined ? [] : [hitMaterialOffset],
            },
            { group: selectedGroup2, offsets: [...selectedGroup2Offsets] },
          ],
        };
      }
    }
  };

  const admittedViewGroup = (
    selection: DrawPipelineSelection | undefined,
    pipeline: RenderPipeline,
    shader: string | undefined,
  ) => {
    if (selection?.viewGroup !== undefined) return selection.viewGroup;
    const view =
      ordinaryMaterialViewGroup(c, pipeline, shader, materialSceneDepth) ?? viewBindGroup;
    const group = view === null ? null : viewForPipeline(runtime.device, pipeline, view);
    if (selection !== undefined) selection.viewGroup = group;
    return group;
  };

  const submitSubmeshPass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smIdx: number,
    submeshMaterial: MaterialSnapshot,
    selectedPass: DispatchEntry | undefined,
    binding: import('./main-pass-material').MainPassMaterialBinding,
    meshBinding: ReturnType<typeof meshSsboBufferBinding>,
    smPipelineHandle: RenderPipeline,
    selection: DrawPipelineSelection | undefined,
  ): void => {
    const {
      material: materialPipelineEntry,
      probeBlend: probeBlendAvailable,
      viewOffset,
      shader: smMaterialShaderId,
    } = pipelineSelection;
    const perSubmeshBg = binding.group;
    const drawViewGroup = admittedViewGroup(selection, smPipelineHandle, smMaterialShaderId);
    if (viewOffset !== lastViewOffset || drawViewGroup !== lastViewGroup) {
      pass.setBindGroup(0, drawViewGroup as BindGroup, [viewOffset, 0]);
      lastViewOffset = viewOffset;
      lastViewGroup = drawViewGroup;
    }
    const instanceDraws = submeshInstanceDraws(entry, smIdx, submeshMaterial, probeBlendAvailable);
    if (instanceDraws === null) return;
    const materialGroup2Contract = materialPipelineEntry?.group2Contract;
    if (materialGroup2Contract === undefined) return;
    const meshGroup2 = selectSubmeshGroup2(entry, materialGroup2Contract, meshBinding);
    if (meshGroup2 === null) return;
    const fold = entityFold;
    stageEntityMesh(entry);
    let selectedGroup2 = primitiveForPipeline(
      runtime.device,
      smPipelineHandle,
      meshGroup2,
      binding.reflection,
    );
    let selectedGroup2Offsets = group2DynamicOffsets;
    const layout = materialPipelineEntry?.waterGroup2Layout;
    submittedWaterBaked = undefined;
    if (layout !== undefined) {
      const inputs = materialPipelineEntry?.inputs;
      if (inputs === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'the admitted Water pipeline compiled entry-point resource reads',
          hint: 'retain the selected compiled program with its pipeline before recording Water bindings',
        });
      const water = waterGeometryGroup2(
        c,
        entry.source,
        meshBinding,
        layout,
        inputs,
        submittedWaterGeometry,
      );
      selectedGroup2 = water.group;
      selectedGroup2Offsets = water.offsets;
      if (water.readsBakedSource && passKind === 'forward')
        submittedWaterBaked = Object.freeze({
          sourceBodyIndices: water.sourceBodyIndices,
          bakedSources: water.bakedSources,
          viewIdentity: water.viewIdentity,
          frameGeneration: water.frameGeneration,
          deviceGeneration: water.deviceGeneration,
          drawBinding: water.drawBinding,
        });
    }
    bindMeshGroup(selectedGroup2, selectedGroup2Offsets);
    const range = submeshRange(entry.mesh, smIdx, rangeScratch);

    submittedEntry = entry;
    submittedSubmesh = smIdx;
    submittedMaterial = submeshMaterial;
    submittedPass = selectedPass;
    submittedPipeline = smPipelineHandle;
    submittedMaterialPipeline = materialPipelineEntry;
    submittedShader = smMaterialShaderId;
    submittedFold = fold;
    submittedRange = range;
    submittedInstances = cpuInstanceLodDraws(entry, smIdx, instanceDraws);
    if (viewportHit !== undefined)
      prepareViewportHitDraw(
        viewportHit,
        entry,
        submeshMaterial,
        selectedPass,
        smPipelineHandle,
        smMaterialShaderId,
        drawViewGroup,
        viewOffset,
        perSubmeshBg,
        selectedGroup2,
        selectedGroup2Offsets,
        layout !== undefined,
      );
    profileGeometrySegment(c, passKind, 'draw-submit', submitPreparedSubmesh);
    recordIblPipelineBinding(c, submeshMaterial, smPipelineHandle, perSubmeshBg);
  };

  const bindSubmeshVertexStreams = (entry: ValidatedRenderable, pipeline: RenderPipeline) => {
    if (entry.mesh.vertexStreams === undefined || entry.source.gpuVertexSource !== undefined)
      return;
    const streams = meshVertexStreamsForPipeline(pipeline, entry.mesh.vertexStreams);
    if (entry.mesh.vertexBuffer.handle === lastVertexBuffer && streams === lastVertexStreams)
      return;
    bindMeshVertexStreams(pass, entry.mesh.vertexBuffer.handle, streams);
    lastVertexBuffer = entry.mesh.vertexBuffer.handle;
    lastVertexStreams = streams;
  };

  /** Record one selected material pass of a submesh; false aborts the entity. */
  const recordSubmeshPass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smIdx: number,
    sm: import('./frame-snapshot').ValidatedRenderable['mesh']['submeshes'][number],
    submeshMaterial: MaterialSnapshot,
    selectedPass: DispatchEntry | undefined,
  ): boolean => {
    // Temporal keeps owner-selected entries and otherwise projects the selected
    // material's alpha/motion contract without authored Forward entry points.
    const vertexEntry = passKind === 'temporal' ? undefined : selectedPass?.vertexEntry;
    let fragmentEntry =
      passKind === 'temporal'
        ? fragmentEntryPoint === 'fs_scene_velocity'
          ? fragmentEntryPoint
          : undefined
        : selectStandardForwardScreenEntry(fragmentEntryPoint, selectedPass?.fragmentEntry);
    const selectedShaderId =
      selectedPass === undefined ? submeshMaterial.materialShaderId : selectedPass.materialShaderId;
    const selectedRenderState =
      selectedPass === undefined ? submeshMaterial.renderState : selectedPass.renderState;
    // Weighted blended OIT splits one transparent set into the eligible
    // accumulation draws and the residual sorted draws. Both passes use
    // the same classifier as the frame's inspection facts.
    let oitAccumulateDraw = false;
    if (oit !== undefined) {
      const eligibility = classifyOitDraw({
        materialShaderId: selectedShaderId,
        skinned: entry.source.skinBinding !== undefined,
        renderState: selectedRenderState,
        fragmentEntry,
      });
      if (eligibility.eligible !== (oit === 'accumulate')) return true;
      if (eligibility.eligible) {
        oitAccumulateDraw = true;
        fragmentEntry = eligibility.premultiplied
          ? OIT_PREMULTIPLIED_FRAGMENT_ENTRY
          : OIT_FRAGMENT_ENTRY;
      }
    }
    bindStencilReference(
      (selectedPass === undefined ? entry.stencilReference : selectedPass.stencilReference) ?? 0,
    );
    // feat-city-glb Bug 5 (per-submesh transparency): in the LDR split, a
    // transparent submesh is drawn in the blend sub-pass (non-sRGB view),
    // NOT here in the sRGB geometry pass. Opaque submeshes of the same
    // (mixed) mesh still draw here.
    if (
      splitLdrSprite &&
      (selectedPass === undefined
        ? submeshMaterial.transparent === true
        : selectedRenderState?.blend !== undefined)
    )
      return true;
    if (entityInstanceDraws === undefined || entityMeshBinding === undefined) {
      entityMeshBinding = meshSsboBufferBinding(
        pipelineState.meshStorageBuffer,
        entityMeshSlot * MESH_PER_ENTITY_STRIDE,
        entityMeshBinding,
      );
      if (!bindEntityGeometry(entry, entityMeshBinding)) return false;
    }
    const resolvedPipeline = resolveSharedDrawPipeline(
      entry,
      sm.topology,
      submeshMaterial,
      selectedPass,
      selectedShaderId,
      selectedRenderState,
      vertexEntry,
      fragmentEntry,
      oitAccumulateDraw,
      entry.variantSet,
      entitySceneDirect,
    );
    if (!resolvedPipeline) return true;
    const smPipelineHandle = pipelineSelection.pipeline;
    if (smPipelineHandle === null) {
      const shader = pipelineSelection.shader;
      markPipelinePreparationPending(c.frameState, {
        code: 'material-pipeline-preparation',
        entity: entry.source.entityKey,
        pass: passKind,
        ...(shader === undefined ? {} : { shader: shader.slice(0, 256) }),
      });
      return true;
    }
    // A general fallback cannot supply the requested material's group contract.
    // The resolver keeps its pending/error classification; it still draws nothing.
    if (pipelineSelection.material === null) return true;
    bindSubmeshVertexStreams(entry, smPipelineHandle);
    // A pending PSO needs no material binding. Continue requesting later draws
    // instead of suspending their preparation behind this binding's readiness.
    const materialBinding = bindSubmeshMaterial(
      entry,
      sm.materialSlot,
      submeshMaterial,
      selectedShaderId,
      standardPipelineMaterialLayoutIndex(smPipelineHandle),
    );
    submitSubmeshPass(
      entry,
      smIdx,
      submeshMaterial,
      selectedPass,
      materialBinding,
      entityMeshBinding,
      smPipelineHandle,
      resolvedPipeline === true ? undefined : resolvedPipeline,
    );
    return true;
  };

  /** Record every selected material pass of one submesh; false aborts the entity. */
  const recordSubmesh = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smIdx: number,
    matchedHandles: MaterialHandles | undefined,
    passes: MaterialPasses | undefined,
  ): boolean => {
    const sm = entry.mesh.submeshes[smIdx];
    if (sm === undefined) return true;
    const submeshMaterial = materialFromSubmittedSlots(
      c.materialSlots,
      entityMaterialSlots,
      sm.materialSlot,
    );
    const materialHandle = submeshMaterial.materialHandle ?? 0;
    if (matchedHandles !== undefined && !matchedHandles.has(materialHandle)) return true;
    if (
      c.gpuDrivenSelection !== undefined &&
      gpuDrivenOwnsSubmesh(c, entry, compactDrawAt(entry, smIdx), passKind)
    )
      return true;
    const draws = submeshMaterialDraws(
      selectedDispatch,
      passes,
      submeshMaterial,
      materialHandle,
      matchedHandles !== undefined,
    );
    if (!isMaterialDrawList(draws))
      return recordSubmeshPass(entry, smIdx, sm, submeshMaterial, draws);
    for (let passIndex = 0; passIndex < draws.length; passIndex++) {
      if (!recordSubmeshPass(entry, smIdx, sm, submeshMaterial, draws[passIndex])) return false;
    }
    return true;
  };

  const recordEntry = (i: number): void => {
    const entry = validatedOrdered.at(i);
    if (entry === undefined) return;
    const fold = c.foldDispatchPlan?.headBuckets.get(i);
    // The typed transparent pass uses this common draw owner. Consume the
    // same fold plan as the legacy sprite pass, including coverage/depth draws.
    if (c.foldDispatchPlan?.skipIndices.has(i) === true) return;
    const pointsLines = entry.source.pointsLines;
    const pointsLinesSubmission =
      pointsLines === undefined ? undefined : c.pointsLines?.submission(entry);
    if (pointsLines !== undefined && pointsLinesSubmission?.plan.drawCount !== 1) return;
    // feat-20260609 M2: skip entities that don't match the pass selector.
    const passes = materialPasses.get(entry.renderableIndex);
    const matchedHandles =
      matchedMaterials === materialPasses ? passes : matchedMaterials?.get(entry.renderableIndex);
    if (matchedMaterials !== null && matchedHandles === undefined) return;
    entityBindingSlots = submittedMaterialRow(materialSlotIndices, i);
    entityMaterialSlots =
      materialSlotIndices === c.materialSlotIndices
        ? entityBindingSlots
        : c.materialSlotIndices.at(i);
    // D-2 generalised feat-20260625 M2 / w7: entities whose EVERY submesh is
    // transparent draw in the separate LDR blend sub-pass, never here. A
    // mixed mesh draws its opaque submeshes here; the per-submesh filter
    // skips the transparent ones.
    if (
      selectedDispatch === undefined &&
      splitLdrSprite &&
      everyMaterialSlotTransparent(c, entityBindingSlots)
    )
      return;
    entityMeshSlot = meshDrawSlot(entry, fold !== undefined);
    entityMeshStaged = false;
    entityFold = fold;
    entityInstanceDraws = undefined;
    entitySceneDirect = false;
    entityDirectMeshGroup = meshBindGroup;
    entitySkinTask = undefined;
    if (pointsLinesSubmission !== undefined && pointsLines !== undefined) {
      recordPointsLines(entry, pointsLinesSubmission, pointsLines.style);
      return;
    }
    // Dispatch counter bump — sprite folds into the same unlit bucket; the
    // bench reads sprite render counts via the transparent bucket length.
    dispatchCounts.unlit += 1;
    addressedEntityDraws = false;
    // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
    // Each submesh carries its own topology and material slot.
    const submeshIndices = entry.submeshIndices;
    if (submeshIndices === undefined) {
      for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
        if (!recordSubmesh(entry, smIdx, matchedHandles, passes)) return;
      }
    } else {
      for (let ordinal = 0; ordinal < submeshIndices.length; ordinal++) {
        if (!recordSubmesh(entry, submeshIndices[ordinal] as number, matchedHandles, passes))
          return;
      }
    }
  };

  // A capture may sort against a different camera. Follow its selected dispatch
  // while retaining the original row index for material slots and GPU payloads.
  const drawOrder =
    selectedDispatch !== undefined && c.foldDispatchPlan == null && prepared?.ordered !== true
      ? dispatchDrawOrder(validatedOrdered, materialPasses)
      : undefined;
  for (let ordinal = 0; ordinal < validatedOrdered.length; ordinal++)
    recordEntry(drawOrder?.[ordinal] ?? ordinal);
  observe?.('direct', recordedDraws);
}

/** Overrides keep ordinary selection and order reads unless every actual owner key agrees. */
function admittedGeometryMaterialPasses(
  c: Pick<_InternalRenderPipelineContext, 'geometryMaterialPasses' | 'validatedOrdered'>,
  dispatch: DispatchList | undefined,
  temporal: boolean,
): PreparedGeometryMaterialPasses | undefined {
  const prepared = c.geometryMaterialPasses;
  return prepared !== undefined &&
    prepared.dispatch === dispatch &&
    prepared.validatedOrdered === c.validatedOrdered &&
    prepared.temporal === temporal
    ? prepared
    : undefined;
}

/** Borrowed dispatch has no immutable owner and is read on every call. */
export function selectedMaterialPasses(
  selectedDispatch: DispatchList | undefined,
  temporal: boolean,
): ReadonlyMap<number, MaterialPasses> {
  const materialPasses = new Map<number, MaterialPasses>();
  for (const dispatch of selectedDispatch ?? EMPTY_MATERIAL_DRAWS) {
    let byMaterial = materialPasses.get(dispatch.renderableIndex);
    if (byMaterial === undefined) {
      byMaterial = new MaterialPasses();
      materialPasses.set(dispatch.renderableIndex, byMaterial);
    }
    includeMaterialPass(byMaterial, dispatch, temporal);
  }
  return materialPasses;
}

/** Selected-dispatch order first, then the remaining rows in validated order. */
function dispatchDrawOrder(
  validatedOrdered: DrawRows,
  materialPasses: Pick<MaterialPassLookup, 'size' | 'keys'>,
): number[] | undefined {
  // The retained phase normally publishes rows in this exact dispatch order.
  // Equal complete keys prove the ordinal loop already follows the selected
  // commands; no reverse index or second draw-order array is required.
  if (materialPasses.size === validatedOrdered.length) {
    let ordinal = 0;
    for (const key of materialPasses.keys()) {
      if (validatedOrdered.at(ordinal)?.renderableIndex !== key) break;
      ordinal += 1;
    }
    if (ordinal === validatedOrdered.length) return undefined;
  }
  const remaining = new Map<number, number>();
  for (let index = 0; index < validatedOrdered.length; index++)
    remaining.set((validatedOrdered.at(index) as ValidatedRenderable).renderableIndex, index);
  const drawOrder: number[] = [];
  for (const renderableIndex of materialPasses.keys()) {
    const index = remaining.get(renderableIndex);
    if (index === undefined) continue;
    drawOrder.push(index);
    remaining.delete(renderableIndex);
  }
  for (const index of remaining.values()) drawOrder.push(index);
  return drawOrder;
}

function everyMaterialSlotTransparent(
  c: Pick<_InternalRenderPipelineContext, 'materialSlots'>,
  slots: readonly number[] | undefined,
): boolean {
  return (slots ?? []).every((slot) => c.materialSlots[slot]?.transparent === true);
}

function submeshDrawIndex(
  drawIndices: readonly (number | undefined)[] | undefined,
  smIdx: number,
): number | undefined {
  return drawIndices !== undefined && Object.hasOwn(drawIndices, smIdx)
    ? drawIndices[smIdx]
    : undefined;
}

/** A GPU-driven lane that claimed this exact submesh draw records it instead. */
function gpuDrivenOwnsSubmesh(
  c: _InternalRenderPipelineContext,
  entry: ValidatedRenderable,
  compactDrawIndex: number | undefined,
  passKind: PassKind,
): boolean {
  if (passKind !== 'forward' && passKind !== 'deferred' && passKind !== 'temporal') return false;
  if (compactDrawIndex === undefined) return false;
  const sourceDraw = entry.source.gpuDrivenDraws?.[compactDrawIndex];
  return (
    sourceDraw !== undefined &&
    c.gpuDrivenSelection?.owns(entry.source, sourceDraw, compactDrawIndex, passKind) === true
  );
}

/**
 * The material passes one submesh records: every material's default pass
 * without a selected dispatch (or for a matched single-layer medium that
 * selected no pass of its own), else its selected passes.
 */
function submeshMaterialDraws(
  selectedDispatch: DispatchList | undefined,
  byMaterial: MaterialPasses | undefined,
  material: MaterialSnapshot,
  handle: number,
  matched: boolean,
): DispatchEntry | readonly DispatchEntry[] | undefined {
  if (selectedDispatch === undefined) return undefined;
  const selected = byMaterial?.get(handle);
  if (
    selected === undefined &&
    (material.surfaceModel === 'single-layer-medium' ||
      material.surfaceModel === 'single-layer-water') &&
    matched
  )
    return undefined;
  return selected ?? EMPTY_MATERIAL_DRAWS;
}

function isMaterialDrawList(
  draws: DispatchEntry | readonly DispatchEntry[] | undefined,
): draws is readonly DispatchEntry[] {
  return Array.isArray(draws);
}

/** One instanced draw of a fold bucket's head over its renderer-owned transforms. */
function foldInstanceDraws(
  c: _InternalRenderPipelineContext,
  fold: FoldBucket,
  renderableIndex: number,
): readonly GeometryInstanceDraw[] | null {
  const foldBuffer = resolveFoldInstanceBuffer(c, fold, renderableIndex);
  if (foldBuffer === null) return null;
  return [probeBoundInstanceDraw(c, foldBuffer, undefined, fold.bucketSize)];
}

type InstancePose = NonNullable<RenderableSnapshot['instances']>;

function instanceUploadRows(
  current: InstancePose,
  previous: InstancePose | undefined,
): InstanceRowLookup | undefined {
  if (previous === undefined) return undefined;
  return instanceStoragePairing(
    Math.floor(current.transforms.length / 16),
    Math.floor(previous.transforms.length / 16),
    current.generations,
    previous.generations,
  );
}

/** Each physical window reads the complete collection by ordinal and writes only its requested ranges. */
function uploadInstanceRanges(
  c: InstanceBufferContext,
  inst: InstancePose,
  buffer: Buffer,
  ranges: readonly { readonly start: number; readonly end: number }[],
  storageBacked: boolean,
  sourceOffsetInstances: number,
  previousInst?: InstancePose,
  previousRows?: InstanceRowLookup,
): InstanceUploadResult {
  const world = renderWorldFor(c.runtime);
  if (!world.frameArena.isActive)
    return world
      .withFrameArena(() =>
        ok(
          uploadInstanceRanges(
            c,
            inst,
            buffer,
            ranges,
            storageBacked,
            sourceOffsetInstances,
            previousInst,
            previousRows,
          ),
        ),
      )
      .unwrap();
  const strideBytes =
    (storageBacked ? INSTANCE_STORAGE_STRIDE_FLOATS : 16) * Float32Array.BYTES_PER_ELEMENT;
  const available = Math.max(
    0,
    Math.min(inst.instanceCount, Math.floor(inst.transforms.length / 16)) - sourceOffsetInstances,
  );
  const previous = previousInst?.transforms ?? inst.transforms;
  const untagged = inst.generations === undefined && previousInst?.generations === undefined;
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(available, range.start));
    const end = Math.max(start, Math.min(available, range.end));
    if (end <= start) continue;
    const first = sourceOffsetInstances + start;
    const count = end - start;
    // Legacy untagged inputs can pair by ordinal when the submitted range is complete.
    const lookup =
      untagged && (first + count) * 16 <= previous.length ? sameInstanceOrdinal : previousRows;
    const written = storageBacked
      ? c.runtime.device.queue.writeBuffer(
          buffer,
          start * strideBytes,
          packInstanceStorageRange(
            world.frameArena.alloc(Float32Array, count * INSTANCE_STORAGE_STRIDE_FLOATS).unwrap(),
            inst.transforms,
            previous,
            first,
            count,
            lookup,
          ),
        )
      : c.runtime.device.queue.writeBuffer(
          buffer,
          start * strideBytes,
          inst.transforms,
          first * 16,
          count * 16,
        );
    if (!written.ok) {
      c.runtime.errorRegistry.fire(written.error);
      return { ok: false, ranges: uploadedRanges, bytes: uploadedBytes };
    }
    uploadedRanges.push({ start, end });
    uploadedBytes += count * strideBytes;
  }
  return { ok: true, ranges: uploadedRanges, bytes: uploadedBytes };
}

function withUploadedRevision(
  active: InstanceBufferCacheEntry,
  uploadedRevision: number | undefined,
  motionRows: InstanceBufferCacheEntry['uploadedMotionRows'],
): InstanceBufferCacheEntry {
  const { uploadedMotionRows: _stale, uploadedRevision: _revision, ...rest } = active;
  return {
    ...rest,
    ...(uploadedRevision === undefined ? {} : { uploadedRevision }),
    ...(motionRows === undefined ? {} : { uploadedMotionRows: motionRows }),
  };
}

function reportInstanceResidency(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  input: {
    readonly lane: Exclude<InstanceSubmissionLane, 'unresident' | 'unavailable'>;
    readonly requestedBytes: number;
    readonly supportedBytes: number | undefined;
    readonly uploadRanges: readonly {
      readonly start: number;
      readonly end: number;
    }[];
    readonly uploadedBytes: number;
  },
): void {
  if (inst.collectionId === undefined) return;
  c.frameState.instanceCollections?._reportResidency({
    collectionId: inst.collectionId,
    frameNumber: c.frameState.frameNumber,
    residentGeneration: recordContext(c.runtime).deviceScope.generation,
    lane: input.lane,
    requestedBytes: input.requestedBytes,
    supportedBytes: input.supportedBytes,
    uploadRanges: input.uploadRanges,
    uploadedBytes: input.uploadedBytes,
    backend: c.runtime.device.caps.backendKind,
  });
}

function reportInstanceFailure(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  error: {
    readonly code: InstanceCollectionFailureCode;
    readonly expected: string;
    readonly hint: string;
  },
  requestedBytes: number,
  supportedBytes: number | undefined,
): void {
  if (inst.collectionId === undefined) return;
  c.frameState.instanceCollections?._reportFailure({
    collectionId: inst.collectionId,
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    facts: {
      requestedBytes,
      supportedBytes,
      backend: c.runtime.device.caps.backendKind,
      owner: 'renderer.instances',
      cause: error.code,
      recovery: error.hint,
    },
  });
}

function instanceChunksForOwner(c: InstanceBufferContext, ownerKey: InstanceBufferCacheKey) {
  const owners = c.frameState.instanceBufferChunks;
  if (owners === undefined) return undefined;
  let chunks = owners.get(ownerKey);
  if (chunks === undefined) {
    chunks = new Map<InstanceBufferChunkKey, InstanceBufferCacheEntry>();
    owners.set(ownerKey, chunks);
  }
  return chunks;
}

function clearInstanceChunksForOwner(
  c: InstanceBufferContext,
  ownerKey: InstanceBufferCacheKey,
): void {
  const owners = c.frameState.instanceBufferChunks;
  const chunks = owners?.get(ownerKey);
  if (chunks === undefined) return;
  for (const [start, entry] of chunks) {
    if (typeof start === 'string') continue;
    if (!entry.buffer.isDestroyed) {
      const destroyed = entry.buffer.destroy();
      if (!destroyed.ok) c.runtime.errorRegistry.fire(destroyed.error);
    }
    chunks.delete(start);
  }
  if (chunks.size === 0) owners?.delete(ownerKey);
}

export function resolveStorageInstanceChunks(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  inst: NonNullable<RenderableSnapshot['instances']>,
  cap: number,
  probeBuffer: Buffer | undefined,
  probeOffset: number,
): readonly GeometryInstanceDraw[] | null {
  const { runtime, frameState } = c;
  const strideBytes = INSTANCE_STORAGE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
  const chunkCapacity = Math.floor(cap / strideBytes);
  if (chunkCapacity < 1) {
    reportInstanceFailure(
      c,
      inst,
      {
        code: 'limit-exceeded',
        expected: `maxStorageBufferBindingSize (${cap}) >= ${strideBytes}`,
        hint: 'use a backend with storage-buffer bindings large enough for one InstanceData record',
      },
      inst.instanceCount * strideBytes,
      cap,
    );
    runtime.errorRegistry.fire(
      new RhiError({
        code: 'limit-exceeded',
        expected: `maxStorageBufferBindingSize (${cap}) >= ${strideBytes}`,
        hint: 'use a backend with storage-buffer bindings large enough for one InstanceData record',
        detail: {
          maxStorageBufferBindingSize: cap,
          requestedBytes: strideBytes,
        },
      }),
    );
    return null;
  }
  const ownerKey = instanceCollectionCacheKey(inst);
  const chunks = instanceChunksForOwner(c, ownerKey);
  const draws: GeometryInstanceDraw[] = [];
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  const previousInstances = entry.source.temporal?.previousInstances;
  const pairing = instancePreviousPairing(inst, previousInstances);
  const previousRows = instanceUploadRows(inst, previousInstances);
  for (let start = 0; start < inst.instanceCount; start += chunkCapacity) {
    const end = Math.min(inst.instanceCount, start + chunkCapacity);
    const count = end - start;
    // Keep stable-resident checks arithmetic-only; packing is deferred to the
    // upload path below, where a new or dirty range actually needs payload.
    const payloadBytes = count * strideBytes;
    const previous = chunks?.get(start);
    let active =
      previous !== undefined &&
      previous.uploadedArchVersion === inst.archVersion &&
      previous.uploadedByteLength === payloadBytes
        ? previous
        : undefined;
    let activeIsNew = false;
    if (active === undefined) {
      const created = runtime.device.createBuffer({
        size: payloadBytes,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      });
      if (!created.ok) {
        runtime.errorRegistry.fire(created.error);
        reportInstanceFailure(c, inst, created.error, inst.instanceCount * strideBytes, cap);
        return null;
      }
      if (previous !== undefined && !previous.buffer.isDestroyed) {
        const destroyed = previous.buffer.destroy();
        if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
      }
      active = {
        buffer: new GpuBuffer(runtime.device, created.value),
        uploadedArchVersion: inst.archVersion,
        uploadedByteLength: payloadBytes,
      };
      activeIsNew = true;
      chunks?.set(start, active);
      if (chunks === undefined) frameState.transientInstanceBuffers.push(active);
    }
    if (active === undefined) return null;
    const needsUpload =
      activeIsNew ||
      active.uploadedRevision !== inst.revision ||
      (pairing === 'none' && active.uploadedMotionRows?.length !== 0);
    const plan = planInstanceUpload({
      activeIsNew,
      resident: active,
      current: inst,
      pairing,
      window: { start, end },
    });
    if (needsUpload && plan.ranges.length > 0) {
      const upload = uploadInstanceRanges(
        c,
        inst,
        active.buffer.handle,
        plan.ranges,
        true,
        start,
        previousInstances,
        previousRows,
      );
      for (const range of upload.ranges) {
        uploadedRanges.push({
          start: range.start + start,
          end: range.end + start,
        });
      }
      uploadedBytes += upload.bytes;
      if (!upload.ok) {
        reportInstanceFailure(
          c,
          inst,
          {
            code: 'queue-write-buffer-failed',
            expected: 'the renderer-owned instance storage buffer accepts the dirty range',
            hint: 'retry after the active device is healthy or recover the renderer',
          },
          inst.instanceCount * strideBytes,
          cap,
        );
        return null;
      }
    }
    if (needsUpload) {
      const published = withUploadedRevision(active, inst.revision, plan.motionRows);
      active = published;
      chunks?.set(start, published);
    }
    const activeBuffer = active;
    draws.push({
      instanceBuffer: activeBuffer.buffer.handle,
      instanceBindGroup: resolveGeometryInstancesBindGroup(
        c,
        activeBuffer.buffer.handle,
        probeBuffer,
      ),
      ...(probeBuffer === undefined ? {} : { probeBuffer }),
      probeOffset,
      instanceCount: count,
      firstInstanceOrdinal: start,
    });
  }
  retireNumericInstanceChunks(c, chunks, inst.instanceCount, chunkCapacity);
  reportInstanceResidency(c, inst, {
    lane: 'chunked-storage',
    requestedBytes: inst.instanceCount * strideBytes,
    supportedBytes: cap,
    uploadRanges: uploadedRanges,
    uploadedBytes,
  });
  return draws;
}

type InstanceBufferContext = Pick<
  _InternalRenderPipelineContext,
  'runtime' | 'pipelineState' | 'frameState' | 'bindGroupCounts'
>;

type SceneDirectDraw = {
  instanceBuffer: Buffer;
  instanceBindGroup: BindGroup;
  readonly probeOffset: -1;
  instanceCount: number;
  firstInstance: number;
};

/**
 * One draw over a slot's resident GPU Scene instance rows: the first instance
 * is the slot's first scene row, so no per-frame instance payload is packed.
 * Undefined when the slot is not wholly resident or needs a packed-only path.
 */
function resolveSceneDirectInstanceDraws(
  c: InstanceBufferContext &
    Pick<_InternalRenderPipelineContext, 'gpuDrivenScene' | 'gpuDrivenSceneSlotForEntity'>,
  entry: ValidatedRenderable,
  output: SceneDirectDraw[],
): readonly GeometryInstanceDraw[] | undefined {
  const scene = c.gpuDrivenScene;
  const inst = entry.source.instances;
  if (inst === undefined || scene === undefined) return undefined;
  const slot =
    entry.sceneSlot?.slot ?? c.gpuDrivenSceneSlotForEntity?.(entry.source.entityKey)?.slot;
  const layout = c.pipelineState.sceneDirectInstancesBindGroupLayout;
  const instanceCount = inst.instanceCount;
  if (
    slot === undefined ||
    layout == null ||
    instanceCount === 0 ||
    entry.source.spriteInstances !== undefined ||
    entry.source.skinBinding !== undefined ||
    entry.source.probeBlendRecord !== undefined ||
    entry.cpuInstanceLods !== undefined
  )
    return undefined;
  const lastOrdinal = instanceCount - 1;
  const lastInstance = scene.instanceIndexForSlot(slot, lastOrdinal);
  if (lastInstance === undefined) return undefined;
  const firstInstance = lastInstance - lastOrdinal;
  const upload = scene.takeInstanceUpload(slot);
  if (inst.collectionId !== undefined && c.frameState.instanceCollections !== undefined)
    reportInstanceResidency(c, inst, {
      lane: 'gpu-scene',
      requestedBytes: instanceCount * GPU_SCENE_LAYOUTS.transform.stride,
      supportedBytes: undefined,
      uploadRanges: upload.ranges,
      uploadedBytes: upload.bytes,
    });
  const textures = scene.tableTextures;
  const instanceBuffer =
    textures === undefined ? scene.instanceBuffer : c.pipelineState.identityInstanceBuffer;
  const group =
    textures === undefined
      ? sceneDirectStorageBindGroup(
          c,
          layout,
          instanceBuffer,
          scene.primitiveBuffer,
          scene.transformBuffer,
        )
      : sceneDirectTextureTablesBindGroup(c, layout, textures);
  const draw = output[0];
  if (draw === undefined)
    output.push({
      instanceBuffer,
      instanceBindGroup: group,
      probeOffset: -1,
      instanceCount,
      firstInstance,
    });
  else {
    draw.instanceBuffer = instanceBuffer;
    draw.instanceBindGroup = group;
    draw.instanceCount = instanceCount;
    draw.firstInstance = firstInstance;
  }
  return output;
}

function sceneDirectStorageBindGroup(
  c: InstanceBufferContext,
  layout: BindGroupLayout,
  instanceBuffer: Buffer,
  primitiveBuffer: Buffer,
  transformBuffer: Buffer,
): BindGroup {
  return getOrCreateFromChain(
    c.frameState.instancesBgShared ?? new WeakMap<object, unknown>(),
    [layout, instanceBuffer, primitiveBuffer, transformBuffer],
    'scene-direct-instances',
    () => {
      const result = c.runtime.device.createBindGroup({
        label: 'pbr-scene-direct-instances-bg',
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: instanceBuffer } } },
          { binding: 6, resource: { kind: 'buffer', value: { buffer: primitiveBuffer } } },
          { binding: 9, resource: { kind: 'buffer', value: { buffer: transformBuffer } } },
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    c.bindGroupCounts,
  );
}

/** Slot 3 of a texture-table scene-direct draw: instance, primitive and transform tables. */
function sceneDirectTextureTablesBindGroup(
  c: InstanceBufferContext,
  layout: BindGroupLayout,
  textures: GpuSceneTableTextures,
): BindGroup {
  return getOrCreateFromChain(
    c.frameState.instancesBgShared ?? new WeakMap<object, unknown>(),
    [layout, textures.instance, textures.primitive, textures.transform],
    'scene-direct-texture-tables',
    () => {
      const table = (binding: number, view: TextureView) => ({
        binding,
        resource: { kind: 'textureView' as const, value: view },
      });
      const result = c.runtime.device.createBindGroup({
        label: 'pbr-scene-direct-texture-tables-bg',
        layout,
        entries: [
          table(0, textures.instance),
          table(6, textures.primitive),
          table(7, textures.transform),
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    c.bindGroupCounts,
  );
}

export class PassGeometryInstances {
  private ordinary?: readonly [GeometryInstanceDraw];
  private sentinel?: readonly [GeometryInstanceDraw];
  private sentinelLayout: InstanceBufferContext['pipelineState']['probeInstancesBindGroupLayout'];

  constructor(private readonly context: InstanceBufferContext) {}

  identity(): readonly [GeometryInstanceDraw] {
    const c = this.context;
    this.ordinary ??= [
      probeBoundInstanceDraw(c, c.pipelineState.identityInstanceBuffer, undefined, 1),
    ];
    return this.ordinary;
  }

  resolve(
    entry: ValidatedRenderable,
    useProbeBlend: boolean,
  ): readonly GeometryInstanceDraw[] | null {
    const c = this.context;
    if (
      entry.source.instances !== undefined ||
      entry.source.spriteInstances !== undefined ||
      entry.source.probeBlendRecord !== undefined
    )
      return resolveGeometryInstanceBuffer(c, entry, this.identity(), useProbeBlend);
    if (!useProbeBlend || !c.runtime.device.caps.storageBuffer) return this.identity();
    const resident = c.frameState.probeBlendRecordBuffer;
    const buffer =
      resident === undefined || resident.device !== c.runtime.device || resident.isDestroyed
        ? ensureProbeBlendRecordBuffer(c.runtime.device, c.frameState, undefined)
        : resident.handle;
    const layout = c.pipelineState.probeInstancesBindGroupLayout;
    if (
      this.sentinel === undefined ||
      this.sentinel[0].probeBuffer !== buffer ||
      this.sentinelLayout !== layout
    ) {
      this.sentinel = [
        probeBoundInstanceDraw(c, c.pipelineState.identityInstanceBuffer, { buffer, offset: 0 }, 1),
      ];
      this.sentinelLayout = layout;
    }
    return this.sentinel;
  }
}

export function resolveGeometryInstanceBuffer(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  identityInstanceDraws: readonly GeometryInstanceDraw[],
  useProbeBlend: boolean,
): readonly GeometryInstanceDraw[] | null {
  const inst = entry.source.instances;
  if (entry.source.spriteInstances !== undefined) return spriteInstanceDraws(c, entry);
  const probeBinding = resolveInstanceProbeBinding(c, entry, useProbeBlend);
  if (inst === undefined) {
    if (probeBinding === undefined)
      return identityInstanceDraws.length === 0 ? null : identityInstanceDraws;
    const identity = identityInstanceDraws[0];
    if (identity === undefined) return null;
    return [
      {
        ...identity,
        instanceBindGroup: resolveGeometryInstancesBindGroup(
          c,
          c.pipelineState.identityInstanceBuffer,
          probeBinding?.buffer,
        ),
        ...(probeBinding?.buffer === undefined ? {} : { probeBuffer: probeBinding.buffer }),
        probeOffset: probeBinding?.offset ?? -1,
      },
    ];
  }
  // A present, empty Instances array means zero draws. Do not fall back to
  // the shared identity buffer, which would silently render one instance.
  if (inst.instanceCount === 0) return [];
  // Uniform-only CPU LOD pages may reorder opaque instances within each page.
  // Source ordinals remain the authority; blended collections retain their draw order.
  if (
    !c.runtime.device.caps.storageBuffer &&
    entry.cpuInstanceLods !== undefined &&
    entry.renderState?.blend === undefined &&
    [entry.source.material, ...entry.source.materials].every(
      (material) =>
        material.snapshot.transparent !== true &&
        material.snapshot.passes.every((pass) => pass.renderState?.blend === undefined),
    )
  )
    return resolveUniformLodInstanceDraws(c, entry, inst, probeBinding);
  // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w13:
  // caps.storageBuffer===false -> uniform fallback with 128-instance
  // cap (128 * 64B = 8192B < WebGL2 min 16384B UBO limit).
  // caps.storageBuffer===true -> existing storage buffer path unchanged.
  if (c.runtime.device.caps.storageBuffer === false && inst.instanceCount > MAX_UNIFORM_INSTANCES)
    return resolveChunkedUniformInstanceDraws(c, inst, probeBinding);
  return resolveDirectInstanceDraws(c, entry, inst, probeBinding);
}

type InstanceProbeBinding = ReturnType<typeof resolveProbeBlendBuffer> | undefined;

/** One instanced draw over `instanceBuffer`, carrying the entity's probe binding. */
function probeBoundInstanceDraw(
  c: InstanceBufferContext,
  instanceBuffer: Buffer,
  probeBinding: InstanceProbeBinding,
  instanceCount: number,
  firstInstanceOrdinal?: number,
): GeometryInstanceDraw {
  return {
    instanceBuffer,
    instanceBindGroup: resolveGeometryInstancesBindGroup(c, instanceBuffer, probeBinding?.buffer),
    ...(probeBinding?.buffer === undefined ? {} : { probeBuffer: probeBinding.buffer }),
    probeOffset: probeBinding?.offset ?? -1,
    instanceCount,
    ...(firstInstanceOrdinal === undefined ? {} : { firstInstanceOrdinal }),
  };
}

function spriteInstanceDraws(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
): readonly GeometryInstanceDraw[] {
  return resolveSpriteInstanceDraws(c, entry).map(({ buffer, count, firstInstanceOrdinal }) =>
    probeBoundInstanceDraw(c, buffer, undefined, count, firstInstanceOrdinal),
  );
}

function resolveInstanceProbeBinding(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  useProbeBlend: boolean,
): InstanceProbeBinding {
  if (!useProbeBlend || !c.runtime.device.caps.storageBuffer) return undefined;
  const record = entry.source.probeBlendRecord;
  if (record === undefined)
    return {
      buffer: ensureProbeBlendRecordBuffer(c.runtime.device, c.frameState, undefined),
      offset: 0,
    };
  return resolveProbeBlendBuffer(c, record);
}

function uploadedRevisionMatches(
  cached: InstanceBufferCacheEntry,
  revision: number | undefined,
): boolean {
  return revision === undefined
    ? cached.uploadedRevision === undefined
    : cached.uploadedRevision === revision;
}

function destroyInstanceBuffer(c: InstanceBufferContext, buffer: GpuBuffer): void {
  if (buffer.isDestroyed) return;
  const destroyed = buffer.destroy();
  if (!destroyed.ok) c.runtime.errorRegistry.fire(destroyed.error);
}

const UNIFORM_INSTANCE_STRIDE_BYTES = 16 * Float32Array.BYTES_PER_ELEMENT;

/** Only a proven adjacent revision can narrow uploads to dirty source ordinals. */
function lodPermutationNeedsUpload(
  cached: InstanceBufferCacheEntry,
  inst: NonNullable<RenderableSnapshot['instances']>,
  ordinals: readonly number[],
  isNew: boolean,
): boolean {
  if (isNew) return true;
  if (uploadedRevisionMatches(cached, inst.revision)) return false;
  if (
    inst.revision === undefined ||
    cached.uploadedRevision === undefined ||
    inst.revision !== cached.uploadedRevision + 1 ||
    inst.dirtyRanges === undefined
  )
    return true;
  return ordinals.some((ordinal) =>
    inst.dirtyRanges?.some((range) => ordinal >= range.start && ordinal < range.end),
  );
}

/** Retire ordinary resident pages without touching per-view LOD permutations. */
function retireNumericInstanceChunks(
  c: InstanceBufferContext,
  chunks: Map<InstanceBufferChunkKey, InstanceBufferCacheEntry> | undefined,
  count: number,
  rowsPerChunk: number,
): void {
  if (chunks === undefined) return;
  for (const [key, stale] of chunks) {
    if (typeof key === 'string' || (key >= 0 && key < count && key % rowsPerChunk === 0)) continue;
    destroyInstanceBuffer(c, stale.buffer);
    chunks.delete(key);
  }
}

/** Acquire an upload candidate without retiring or publishing the previous resident. */
function acquireLodPermutation(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  count: number,
  previous: InstanceBufferCacheEntry | undefined,
): InstanceBufferCacheEntry | null {
  if (previous !== undefined && previous.uploadedArchVersion === inst.archVersion) return previous;
  const created = c.runtime.device.createBuffer({
    size: INSTANCE_UBO_FULL_ARRAY_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  if (!created.ok) {
    c.runtime.errorRegistry.fire(created.error);
    return null;
  }
  return {
    buffer: new GpuBuffer(c.runtime.device, created.value),
    uploadedByteLength: count * UNIFORM_INSTANCE_STRIDE_BYTES,
    uploadedArchVersion: inst.archVersion,
  };
}

/** Camera permutations share immutable source pages, never buffers with different ordinal maps. */
function resolveUniformLodInstanceDraws(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  inst: NonNullable<RenderableSnapshot['instances']>,
  probeBinding: InstanceProbeBinding,
): readonly GeometryInstanceDraw[] | null {
  const chunks = instanceChunksForOwner(c, instanceCollectionCacheKey(inst));
  const frame = c.frameState.frameNumber;
  // Retain every permutation used by any view this frame. The following frame
  // can still reuse it; older unused permutations retire with ordinary buffers.
  for (const [key, cached] of chunks ?? []) {
    if (typeof key !== 'string' || (cached.usedFrame ?? -Infinity) >= frame - 1) continue;
    destroyInstanceBuffer(c, cached.buffer);
    chunks?.delete(key);
  }
  const pages = [];
  for (let first = 0; first < inst.instanceCount; first += MAX_UNIFORM_INSTANCES)
    pages.push({
      firstInstanceOrdinal: first,
      instanceCount: Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - first),
    });
  const draws: GeometryInstanceDraw[] = [];
  let uploadedBytes = 0;
  const uploadRanges: { start: number; end: number }[] = [];
  for (const page of cpuInstanceLodDraws(entry, 0, pages, true)) {
    const ordinals = page.instanceOrdinals;
    if (ordinals === undefined || page.lodLevel === undefined) continue;
    const key = ordinals.join(',');
    const previous = chunks?.get(key);
    let active = acquireLodPermutation(c, inst, ordinals.length, previous);
    if (active === null) return null;
    const isNew = active !== previous;
    const changed = lodPermutationNeedsUpload(active, inst, ordinals, isNew);
    if (changed) {
      const packed = new Float32Array(ordinals.length * 16);
      for (let index = 0; index < ordinals.length; index++) {
        const ordinal = ordinals[index] as number;
        packed.set(inst.transforms.subarray(ordinal * 16, (ordinal + 1) * 16), index * 16);
      }
      const written = c.runtime.device.queue.writeBuffer(active.buffer.handle, 0, packed);
      if (!written.ok) {
        if (isNew) destroyInstanceBuffer(c, active.buffer);
        c.runtime.errorRegistry.fire(written.error);
        return null;
      }
      uploadedBytes += packed.byteLength;
      for (const ordinal of ordinals) uploadRanges.push({ start: ordinal, end: ordinal + 1 });
    }
    if (isNew && previous !== undefined) destroyInstanceBuffer(c, previous.buffer);
    active = {
      ...withUploadedRevision(active, inst.revision, undefined),
      usedFrame: frame,
    };
    chunks?.set(key, active);
    if (chunks === undefined) c.frameState.transientInstanceBuffers.push(active);
    draws.push({
      ...probeBoundInstanceDraw(c, active.buffer.handle, probeBinding, ordinals.length),
      lodLevel: page.lodLevel,
    });
  }
  reportInstanceResidency(c, inst, {
    lane: 'chunked-uniform',
    requestedBytes: inst.instanceCount * UNIFORM_INSTANCE_STRIDE_BYTES,
    supportedBytes: MAX_UNIFORM_INSTANCES * UNIFORM_INSTANCE_STRIDE_BYTES,
    uploadRanges,
    uploadedBytes,
  });
  return draws;
}

/** Uniform-only devices split a large collection into 128-instance uniform chunks. */
function resolveChunkedUniformInstanceDraws(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  probeBinding: InstanceProbeBinding,
): readonly GeometryInstanceDraw[] | null {
  const chunks = instanceChunksForOwner(c, instanceCollectionCacheKey(inst));
  const draws: GeometryInstanceDraw[] = [];
  const uploaded: { ranges: { start: number; end: number }[]; bytes: number } = {
    ranges: [],
    bytes: 0,
  };
  for (let start = 0; start < inst.instanceCount; start += MAX_UNIFORM_INSTANCES) {
    const count = Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start);
    const active = resolveUniformInstanceChunk(c, inst, chunks, start, uploaded);
    if (active === null) return null;
    draws.push(probeBoundInstanceDraw(c, active.buffer.handle, probeBinding, count, start));
  }
  retireNumericInstanceChunks(c, chunks, inst.instanceCount, MAX_UNIFORM_INSTANCES);
  reportInstanceResidency(c, inst, {
    lane: 'chunked-uniform',
    requestedBytes: inst.instanceCount * UNIFORM_INSTANCE_STRIDE_BYTES,
    supportedBytes: MAX_UNIFORM_INSTANCES * UNIFORM_INSTANCE_STRIDE_BYTES,
    uploadRanges: uploaded.ranges,
    uploadedBytes: uploaded.bytes,
  });
  return draws;
}

/** Resident, uploaded uniform chunk starting at `start`; null after a reported failure. */
function resolveUniformInstanceChunk(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  chunks: Map<InstanceBufferChunkKey, InstanceBufferCacheEntry> | undefined,
  start: number,
  uploaded: { ranges: { start: number; end: number }[]; bytes: number },
): InstanceBufferCacheEntry | null {
  const count = Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start);
  const previous = chunks?.get(start);
  const active = acquireUniformInstanceChunk(c, inst, chunks, start, previous);
  if (active === null) return null;
  const activeIsNew = active !== previous;
  const revision = inst.revision;
  const needsUpload = activeIsNew || !uploadedRevisionMatches(active, revision);
  const plan = planInstanceUpload({
    activeIsNew,
    resident: active,
    current: inst,
    pairing: 'no-previous-lane',
    window: { start, end: start + count },
  });
  if (!needsUpload) return active;
  if (plan.ranges.length > 0) {
    const upload = uploadInstanceRanges(c, inst, active.buffer.handle, plan.ranges, false, start);
    for (const range of upload.ranges) {
      uploaded.ranges.push({
        start: range.start + start,
        end: range.end + start,
      });
    }
    uploaded.bytes += upload.bytes;
    if (!upload.ok) {
      reportInstanceFailure(
        c,
        inst,
        {
          code: 'queue-write-buffer-failed',
          expected: 'the renderer-owned instance uniform buffer accepts the dirty range',
          hint: 'retry after the active device is healthy or recover the renderer',
        },
        inst.instanceCount * UNIFORM_INSTANCE_STRIDE_BYTES,
        MAX_UNIFORM_INSTANCES * UNIFORM_INSTANCE_STRIDE_BYTES,
      );
      return null;
    }
  }
  const published =
    revision === undefined ? active : withUploadedRevision(active, revision, plan.motionRows);
  chunks?.set(start, published);
  return published;
}

/** Reuse the chunk's buffer while its layout version and size hold; else replace it. */
function acquireUniformInstanceChunk(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  chunks: Map<InstanceBufferChunkKey, InstanceBufferCacheEntry> | undefined,
  start: number,
  previous: InstanceBufferCacheEntry | undefined,
): InstanceBufferCacheEntry | null {
  const { runtime, frameState } = c;
  const payloadBytes =
    Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start) * UNIFORM_INSTANCE_STRIDE_BYTES;
  if (
    previous !== undefined &&
    previous.uploadedArchVersion === inst.archVersion &&
    previous.uploadedByteLength === payloadBytes
  )
    return previous;
  const created = runtime.device.createBuffer({
    size: INSTANCE_UBO_FULL_ARRAY_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    runtime.errorRegistry.fire(created.error);
    reportInstanceFailure(
      c,
      inst,
      created.error,
      inst.instanceCount * UNIFORM_INSTANCE_STRIDE_BYTES,
      MAX_UNIFORM_INSTANCES * UNIFORM_INSTANCE_STRIDE_BYTES,
    );
    return null;
  }
  if (previous !== undefined) destroyInstanceBuffer(c, previous.buffer);
  const active: InstanceBufferCacheEntry = {
    buffer: new GpuBuffer(runtime.device, created.value),
    uploadedArchVersion: inst.archVersion,
    uploadedByteLength: payloadBytes,
  };
  chunks?.set(start, active);
  if (chunks === undefined) frameState.transientInstanceBuffers.push(active);
  return active;
}

/**
 * One storage (or uniform-fallback) buffer for the whole collection. Cap-gate
 * (LimitExceededDetail single emit point — feat-20260514 M3 / w15 anchor):
 * `requestedBytes <= maxStorageBufferBindingSize`. Derive the size from the
 * authoring count; storage packing is deferred until uploadInstanceRanges
 * confirms a new or dirty resident.
 */
function resolveDirectInstanceDraws(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  inst: NonNullable<RenderableSnapshot['instances']>,
  probeBinding: InstanceProbeBinding,
): readonly GeometryInstanceDraw[] | null {
  const { runtime, frameState } = c;
  const uniformFallback = runtime.device.caps.storageBuffer === false;
  const requestedBytes =
    inst.instanceCount *
    (uniformFallback ? 16 : INSTANCE_STORAGE_STRIDE_FLOATS) *
    Float32Array.BYTES_PER_ELEMENT;
  const cap = runtime.device.limits.maxStorageBufferBindingSize;
  if (!uniformFallback && typeof cap === 'number' && cap > 0 && requestedBytes > cap)
    return resolveStorageInstanceChunks(
      c,
      entry,
      inst,
      cap,
      probeBinding?.buffer,
      probeBinding?.offset ?? -1,
    );
  // Cache keys tag authored collections, WaterMesh draws, and legacy owners
  // separately; worldId scopes WaterMesh and legacy source identities.
  const entityCacheKey = instanceCollectionCacheKey(inst);
  const cached = frameState.instanceBuffers.get(entityCacheKey);
  const acquired = acquireDirectInstanceBuffer(c, inst, entityCacheKey, cached, requestedBytes);
  if (acquired === null) return null;
  if (acquired === undefined)
    return [probeBoundInstanceDraw(c, c.pipelineState.identityInstanceBuffer, probeBinding, 1)];
  const active = uploadDirectInstances(
    c,
    entry,
    inst,
    acquired,
    acquired !== cached,
    requestedBytes,
  );
  if (active === null) return null;
  return [
    probeBoundInstanceDraw(c, active.buffer.handle, probeBinding, Math.max(1, inst.instanceCount)),
  ];
}

/**
 * Reuse the cached buffer while the archetype version and byte length hold,
 * else create (and cache) a fresh one. Undefined when no bytes are requested;
 * null after a reported creation failure.
 */
function acquireDirectInstanceBuffer(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  entityCacheKey: InstanceBufferCacheKey,
  cached: InstanceBufferCacheEntry | undefined,
  requestedBytes: number,
): InstanceBufferCacheEntry | null | undefined {
  const { runtime, frameState } = c;
  const sameArchetype = cached !== undefined && cached.uploadedArchVersion === inst.archVersion;
  if (sameArchetype && cached.uploadedByteLength === requestedBytes) return cached;
  if (!(requestedBytes > 0)) return undefined;
  const uniformFallback = runtime.device.caps.storageBuffer === false;
  // A collection whose count changes (spawned and retired members) keeps its
  // buffer and bind group while the payload fits the reservation; the caller
  // treats the resized entry as new and uploads the whole payload.
  const capacity = cached?.capacityBytes ?? cached?.uploadedByteLength ?? 0;
  const stride =
    (uniformFallback ? 16 : INSTANCE_STORAGE_STRIDE_FLOATS) * Float32Array.BYTES_PER_ELEMENT;
  if (
    sameArchetype &&
    requestedBytes <= capacity &&
    (uniformFallback || !shouldShrinkCapacity(requestedBytes / stride, capacity / stride))
  ) {
    const { uploadedRevision: _revision, uploadedMotionRows: _motion, ...rest } = cached;
    const resized: InstanceBufferCacheEntry = {
      ...rest,
      capacityBytes: capacity,
      uploadedByteLength: requestedBytes,
    };
    frameState.instanceBuffers.set(entityCacheKey, resized);
    return resized;
  }
  const cap = runtime.device.limits.maxStorageBufferBindingSize;
  const reserved =
    sameArchetype && !uniformFallback
      ? Math.min(
          dynamicCapacity(requestedBytes / stride) * stride,
          typeof cap === 'number' && cap > 0 ? Math.floor(cap / stride) * stride : Infinity,
        )
      : requestedBytes;
  const capacityBytes = uniformFallback ? INSTANCE_UBO_FULL_ARRAY_BYTES : reserved;
  const created = runtime.device.createBuffer({
    size: capacityBytes,
    usage: uniformFallback
      ? GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST
      : GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    runtime.errorRegistry.fire(created.error);
    reportInstanceFailure(
      c,
      inst,
      created.error,
      requestedBytes,
      runtime.device.limits.maxStorageBufferBindingSize,
    );
    return null;
  }
  // feat-20260619 M4 / F12: destroy the old cached buffer before replacing it
  // with the new one (D-6).
  if (cached !== undefined) destroyInstanceBuffer(c, cached.buffer);
  const active: InstanceBufferCacheEntry = {
    buffer: new GpuBuffer(runtime.device, created.value),
    uploadedArchVersion: inst.archVersion,
    uploadedByteLength: requestedBytes,
    capacityBytes,
  };
  frameState.instanceBuffers.set(entityCacheKey, active);
  return active;
}

/** Upload the dirty rows of a direct instance buffer and publish its revision. */
function uploadDirectInstances(
  c: InstanceBufferContext,
  entry: ValidatedRenderable,
  inst: NonNullable<RenderableSnapshot['instances']>,
  active: InstanceBufferCacheEntry,
  activeIsNew: boolean,
  requestedBytes: number,
): InstanceBufferCacheEntry | null {
  const { runtime, frameState } = c;
  const uniformFallback = runtime.device.caps.storageBuffer === false;
  const entityCacheKey = instanceCollectionCacheKey(inst);
  const cap = runtime.device.limits.maxStorageBufferBindingSize;
  const supportedBytes = uniformFallback
    ? MAX_UNIFORM_INSTANCES * UNIFORM_INSTANCE_STRIDE_BYTES
    : typeof cap === 'number'
      ? cap
      : undefined;
  const previousInstances = entry.source.temporal?.previousInstances;
  const pairing = uniformFallback
    ? 'no-previous-lane'
    : instancePreviousPairing(inst, previousInstances);
  const needsUpload =
    activeIsNew ||
    !uploadedRevisionMatches(active, inst.revision) ||
    (pairing === 'none' && active.uploadedMotionRows?.length !== 0);
  const plan = planInstanceUpload({
    activeIsNew,
    resident: active,
    current: inst,
    pairing,
    window: { start: 0, end: inst.instanceCount },
  });
  let uploadRanges: readonly {
    readonly start: number;
    readonly end: number;
  }[] = [];
  let uploadedBytes = 0;
  if (needsUpload && plan.ranges.length > 0) {
    const upload = uploadInstanceRanges(
      c,
      inst,
      active.buffer.handle,
      plan.ranges,
      !uniformFallback,
      0,
      previousInstances,
      uniformFallback ? undefined : instanceUploadRows(inst, previousInstances),
    );
    uploadRanges = upload.ranges;
    uploadedBytes = upload.bytes;
    if (!upload.ok) {
      reportInstanceFailure(
        c,
        inst,
        {
          code: 'queue-write-buffer-failed',
          expected: 'the renderer-owned instance buffer accepts the dirty ranges',
          hint: 'retry after the active device is healthy or recover the renderer',
        },
        requestedBytes,
        supportedBytes,
      );
      return null;
    }
  }
  let published = active;
  if (needsUpload) {
    published = withUploadedRevision(active, inst.revision, plan.motionRows);
    frameState.instanceBuffers.set(entityCacheKey, published);
  }
  reportInstanceResidency(c, inst, {
    lane: uniformFallback ? 'direct-uniform' : 'direct-storage',
    requestedBytes,
    supportedBytes,
    uploadRanges,
    uploadedBytes,
  });
  clearInstanceChunksForOwner(c, entityCacheKey);
  return published;
}

function resolveSurfaceDirectInstanceDraws(
  c: _InternalRenderPipelineContext,
  entry: ValidatedRenderable,
  drawItemIndex: number,
  draws: readonly GeometryInstanceDraw[],
): readonly GeometryInstanceDraw[] | null {
  const resolve = c.gpuDrivenStandardPbrFrameResources?.surfaceDirectInstances;
  if (resolve === undefined) {
    c.runtime.errorRegistry.fire(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'the prepared Surface producer publishes the direct slot-3 resource closure',
        hint: 'prepare the retained Surface frame before recording direct medium draws',
      }),
    );
    return null;
  }
  const resolved: GeometryInstanceDraw[] = [];
  for (const draw of draws) {
    const direct = resolve({
      includeMemberIds: c.frameState.surfaceSubmissionObservation !== undefined,
      entityKey: entry.source.entityKey,
      drawItemIndex,
      instanceCount: draw.instanceCount,
      firstInstanceOrdinal: draw.firstInstanceOrdinal ?? 0,
      instanceBuffer: draw.instanceBuffer,
      ...(draw.probeBuffer === undefined ? {} : { probeBuffer: draw.probeBuffer }),
      ...(draw.probeOffset < 0
        ? {}
        : {
            probeOffset: draw.probeOffset,
          }),
    });
    if (!direct.ok) {
      c.runtime.errorRegistry.fire(direct.error);
      return null;
    }
    resolved.push({
      ...draw,
      instanceBindGroup: direct.value.bindGroup,
      dynamicOffsets: direct.value.dynamicOffsets,
      surfaceFrameBase: direct.value.frameBase,
      surfaceMemberIds: direct.value.memberIds,
    });
  }
  return resolved;
}

export function resolveProbeBlendBuffer(
  c: InstanceBufferContext,
  record: import('../scene/probe-blend-record').ProbeBlendRecord | undefined,
): { readonly buffer: Buffer; readonly offset: number } {
  const { runtime, frameState } = c;
  if (record === undefined) throw new Error('probe blend record is required for probe allocation');
  const buffer = ensureProbeBlendRecordBuffer(runtime.device, frameState, [
    { cacheKey: record.objectKey, record },
  ]);
  if (buffer === undefined) throw new Error('probe blend record buffer allocation failed');
  return { buffer, offset: probeBlendRecordOffset(record.objectKey) };
}

export function resolveGeometryInstancesBindGroup(
  c: InstanceBufferContext,
  instanceBuffer: Buffer,
  probeBuffer?: Buffer,
): BindGroup {
  const { runtime, pipelineState, frameState, bindGroupCounts } = c;
  const layout =
    probeBuffer === undefined
      ? pipelineState.instancesBindGroupLayout
      : pipelineState.probeInstancesBindGroupLayout;
  if (layout === undefined) throw new Error('probe instances bind-group layout is unavailable');
  // A few record-only fixtures construct a minimal frame state and omit the
  // shared bind-group cache. Production frames always provide it, but keeping
  // this resolver total lets those fixtures exercise the same binding path
  // without weakening the production cache contract.
  const instancesBgShared = frameState.instancesBgShared ?? new WeakMap<object, unknown>();
  return getOrCreateFromChain(
    instancesBgShared,
    probeBuffer === undefined ? [layout, instanceBuffer] : [layout, instanceBuffer, probeBuffer],
    probeBuffer === undefined ? 'instances-no-probe' : 'instances-probe',
    () => {
      const result = runtime.device.createBindGroup({
        label: 'pbr-instances-bg',
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: { buffer: instanceBuffer },
            },
          },
          ...(probeBuffer === undefined
            ? []
            : [
                {
                  binding: 1,
                  resource: {
                    kind: 'buffer' as const,
                    value: {
                      buffer: probeBuffer,
                      offset: 0,
                      size: PROBE_BLEND_RECORD_BYTE_SIZE,
                    },
                  },
                },
              ]),
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    bindGroupCounts,
  );
}
