import {
  createGeometryPipelineRequests,
  geometryPipelineRequestContext,
  prepareGeometryPipelineRequests,
} from './geometry-pipeline-requests';
import { selectStandardForwardScreenEntry } from './standard-opaque-entry';

export {
  authoredTransparentDepthWrite,
  geometryRenderStateForPass,
  isHdrGeometryTarget,
  resolveGeometryMaterialVariantSet,
  variantSetForCoveragePass,
} from './geometry-pipeline-requests';

import { meshSsboBufferBinding, meshSsboByteOffset } from '../assembly/mesh-ssbo-grow';
import type { RenderResourceScope } from '../publication/resource-scope';

import type { FrameList } from '../scene/frame-list';
import { recordContext } from '../world/view-record-context';
import { FirstEntryMap } from './first-entry-map';
import {
  includeMaterialPass,
  type MaterialPasses,
  type MaterialPassLookup,
  type PreparedGeometryMaterialPasses,
} from './material-pass-groups';

export { sameOpaqueTemporalDraw } from './material-pass-groups';

import { renderWorldFor } from '../world/render-world';
import { cpuInstanceLodDraws } from './cpu-lod';
import { clusteredMeshSlotBindGroup, meshSlotBindGroup } from './frame-lighting';
import type { ValidatedRenderable } from './frame-snapshot';

import { drawMaterial } from './material-pass-selection';
import { materialUniformSlot } from './material-uniforms';
import type { SkinTaskBinding } from './skin-tasks';
import { resolveSpriteInstanceDraws } from './sprite-instance-buffer';
import { submeshRange } from './submesh-range';
// @forgeax/engine-runtime - RendererState record stage: main-pass geometry draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordGeometryDraws + resolveGeometryInstanceBuffer, moved verbatim.

import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import {
  type MaterialSurfacePassKind,
  ok,
  type ParamSchemaEntry,
  type PassKind,
  type PrimitiveTopology,
} from '@forgeax/engine-types';
import { isEngineOwnedMaterialShader } from '../assembly/material/pipeline-helpers';
import { dynamicCapacity, shouldShrinkCapacity } from '../dynamic-capacity';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { createHdrpSkinUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import type { InstanceBufferCacheEntry, InstanceBufferChunkKey } from '../instance-buffer-cache';
import {
  type InstanceCollectionFailureCode,
  instancePreviousPairing,
  planInstanceUpload,
} from '../instances';
import { isReflectedTransform } from '../material-render-state';

import {
  classifyOitDraw,
  OIT_FRAGMENT_ENTRY,
  OIT_PREMULTIPLIED_FRAGMENT_ENTRY,
} from '../oit/eligibility';
import {
  createPbrSkinMeshBindGroupEntries,
  isStandardPbrMaterialShader,
  materialBindGroupLayoutIdentity,
  pbrSkinMeshDynamicOffsets,
  physicalTextureFields,
} from '../pbr-pipeline';

import type { PointsLinesRecordPlan } from '../points-lines/record';
import { POINTS_LINES_MATERIAL_SHADER_ID, pointsLinesFragmentEntry } from '../points-lines/record';
import type { RenderRecordPhase } from '../render-contract';
import type {
  DispatchEntry,
  DispatchList,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { PROBE_BLEND_RECORD_BYTE_SIZE, probeBlendRecordOffset } from '../scene/probe-blend-record';
import { createFoldedDrawRecorder, resolveFoldInstanceBuffer } from './fold-instance-buffer';
import {
  getOpaqueResourceIdentity,
  instanceCollectionCacheKey,
  worldEntityKey,
} from './frame-snapshot';
import type { RenderableDrawReceipt } from './gpu-draw-receipts';
import { geometryRenderStateForTopology, selectMaterialGroup2 } from './main-pass-material';
import {
  type FoldBucket,
  getOrCreateFromChain,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  INSTANCE_UBO_FULL_ARRAY_BYTES,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  MESH_UBO_FULL_ARRAY_BYTES,
  meshDrawSlot,
  packInstanceStorageBuffer,
  prepareMeshDraw,
} from './mesh-ssbo';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import type { _InternalRenderPipelineContext, MaterialShaderPipelineEntry } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-context';

import { POINTS_LINES_VIEW_SLOT_STRIDE, writePointsLinesViewUbo } from './view-ubo';

const DEFAULT_MATERIAL_DRAWS: readonly undefined[] = Object.freeze([undefined]);
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
      readonly ranges: readonly { readonly start: number; readonly end: number }[];
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly ranges: readonly { readonly start: number; readonly end: number }[];
      readonly bytes: number;
    };

type GeometryBindingState = {
  pipeline: RenderPipeline | null;
  instancesBuffer: Buffer | null;
  instanceBindGroup: BindGroup | null;
  probeOffset: number;
};

type GeometryRecordProfileSegment = 'material-bind-groups' | 'pipeline-selection' | 'draw-submit';

function gpuDrivenDrawIndicesBySubmesh(
  source: RenderableSnapshot,
  mesh: _InternalRenderPipelineContext['validatedOrdered'][number]['mesh'],
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

export function recordIblPipelineBinding(
  c: _InternalRenderPipelineContext,
  material: MaterialSnapshot,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
): void {
  const receipt = c.frameState.iblBindingInspection;
  if (receipt === undefined || !isStandardPbrMaterialShader(material.materialShaderId)) return;
  const materialBgl =
    c.runtime.getMaterialBindGroupLayout?.(
      material.materialShaderId ?? 'forgeax::default-standard-pbr',
    ) ?? c.pipelineState.materialBindGroupLayout;
  const materialReceipt = receipt.material;
  const errors: string[] = [];
  if (
    materialReceipt !== undefined &&
    materialReceipt.materialBglIdentity !== getOpaqueResourceIdentity(materialBgl as object)
  ) {
    errors.push('material-pipeline-bgl-identity-mismatch');
  }
  if (
    materialReceipt !== undefined &&
    materialReceipt.bindGroupIdentity !== getOpaqueResourceIdentity(materialGroup as object)
  ) {
    errors.push('material-bind-group-identity-mismatch');
  }
  if (materialReceipt !== undefined) {
    const expectedResourceIdentities = [
      receipt.resources.irradiance.viewIdentity,
      receipt.resources.irradiance.samplerIdentity,
      receipt.resources.prefilter.viewIdentity,
      receipt.resources.prefilter.samplerIdentity,
      receipt.resources.brdfLut.viewIdentity,
      receipt.resources.brdfLut.samplerIdentity,
      receipt.resources.intensityBufferIdentity,
    ];
    const actualResourceIdentities = materialReceipt.entries
      .filter((entry) => entry.binding >= materialReceipt.skylightBindingStart)
      .slice(0, expectedResourceIdentities.length)
      .map((entry) => entry.resourceIdentity);
    if (
      actualResourceIdentities.length !== expectedResourceIdentities.length ||
      actualResourceIdentities.some(
        (identity, index) => identity !== expectedResourceIdentities[index],
      )
    ) {
      errors.push('material-ibl-resource-identity-mismatch');
    }
  }
  c.frameState.iblBindingInspection = {
    ...receipt,
    pipeline: {
      pipelineIdentity: getOpaqueResourceIdentity(pipeline as object),
      effectiveMaterialLayoutIdentity: effectiveMaterialLayoutIdentity(
        material.materialShaderId ?? 'forgeax::default-standard-pbr',
        material.materialParamSchema,
      ),
      materialBglIdentity: getOpaqueResourceIdentity(materialBgl as object),
      bindGroupIdentity: getOpaqueResourceIdentity(materialGroup as object),
      drawFrameId: c.frameState.frameNumber,
    },
    status: errors.length === 0 ? 'binding-chain-consistent' : 'binding-chain-mismatch',
    errors,
  };
}

/**
 * Returns the layout identity that can distinguish a material PSO in the
 * record cache. Shared boot shaders keep the boot layout identity even when a
 * manifest exposes a schema; Standard PBR only opts into a schema-derived
 * identity when authored clearcoat texture bindings extend that layout.
 */
export function effectiveMaterialLayoutIdentity(
  materialShaderId: string,
  materialParamSchema?: readonly ParamSchemaEntry[],
): string | undefined {
  if (materialParamSchema === undefined) return undefined;
  const hasStandardPhysicalMaps =
    isStandardPbrMaterialShader(materialShaderId) &&
    physicalTextureFields(materialParamSchema).length > 0;
  if (isEngineOwnedMaterialShader(materialShaderId) && !hasStandardPhysicalMaps) {
    return undefined;
  }
  return materialBindGroupLayoutIdentity(materialShaderId, materialParamSchema);
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
const NO_SELECTED_PASS = {};
const SELECTED_PASS = {};

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
    cached.layout === entry.mesh.layoutProjection &&
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
  count: number,
  first: number,
  baseVertex: number,
  onDraw?: (
    draw: GeometryInstanceDraw,
    command: 'draw' | 'draw-indexed',
    range: import('../device/gpu-residency').MeshGpuRange,
  ) => void,
): void {
  if (state.pipeline !== pipeline) {
    pass.setPipeline(pipeline);
    state.pipeline = pipeline;
  }
  for (const instanceDraw of instanceDraws) {
    if (
      instanceDraw.instanceBuffer !== state.instancesBuffer ||
      instanceDraw.instanceBindGroup !== state.instanceBindGroup ||
      instanceDraw.probeOffset !== state.probeOffset
    ) {
      if (instanceDraw.dynamicOffsets !== undefined) {
        pass.setBindGroup(3, instanceDraw.instanceBindGroup, instanceDraw.dynamicOffsets);
      } else if (instanceDraw.probeOffset < 0) {
        pass.setBindGroup(3, instanceDraw.instanceBindGroup);
      } else {
        pass.setBindGroup(3, instanceDraw.instanceBindGroup, [instanceDraw.probeOffset]);
      }
      state.instancesBuffer = instanceDraw.instanceBuffer;
      state.instanceBindGroup = instanceDraw.instanceBindGroup;
      state.probeOffset = instanceDraw.probeOffset;
    }
    const range = instanceDraw.range ?? { count, first, baseVertex };
    if (indexed) {
      pass.drawIndexed(
        range.count,
        instanceDraw.instanceCount,
        range.first,
        range.baseVertex,
        instanceDraw.firstInstance ?? 0,
      );
    } else {
      pass.draw(
        range.count,
        instanceDraw.instanceCount,
        range.first,
        instanceDraw.firstInstance ?? 0,
      );
    }
    onDraw?.(instanceDraw, indexed ? 'draw-indexed' : 'draw', range);
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
  const hdrpBuffers =
    contract === 'skin-cluster'
      ? getOrCreateHdrpBuffers(
          runtime,
          frameState.installedPipelineConfig?.clusterGrid,
          frameState.standardClusterTextureExtent,
        )
      : null;
  if (contract === 'skin-cluster' && hdrpBuffers === null) return null;
  const meshBindSize = runtime.device.caps.storageBuffer
    ? MESH_PER_ENTITY_STRIDE
    : MESH_UBO_FULL_ARRAY_BYTES;
  const skinStats = (pipelineState as { _skinBgCacheStats?: { miss: number; hit: number } })
    ._skinBgCacheStats;
  const skinMissesBefore = bindGroupCounts.createBindGroup;
  const bindGroup = getOrCreateFromChain(
    frameState.meshBindGroupCache,
    [
      layout,
      meshBinding.buffer,
      task.data,
      task.auxiliary,
      ...(hdrpBuffers === null ? [] : [hdrpBuffers]),
      ...(hdrpBuffers === null || c.hdrpSsaoBlurredView === undefined
        ? []
        : [c.hdrpSsaoBlurredView]),
    ],
    'pbr-skin-mesh',
    () => {
      if (hdrpBuffers !== null) {
        const result = createHdrpSkinUnifiedBindGroup(
          runtime,
          hdrpBuffers,
          layout,
          meshBinding.buffer,
          task,
          c.hdrpSsaoBlurredView === undefined
            ? { enabled: false }
            : { enabled: true, ssaoBlurredView: c.hdrpSsaoBlurredView },
        );
        if (result === null) {
          throw new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'HDRP clustered skin BindGroup creation succeeds',
            hint: 'inspect prior errorRegistry events for createBindGroup failure detail',
          });
        }
        return result;
      }
      const result = runtime.device.createBindGroup({
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
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  materialSlotIndices: FrameList<readonly number[]>,
  sampleCount: number,
  meshGroup2: BindGroup | null,
  meshBindGroup: BindGroup | null,
  resolveMaterialBindGroup:
    | ((
        materialSlot: number,
        submeshMaterial: MaterialSnapshot,
        entityKey: number,
        materialWorld: RenderResourceScope,
        materialShaderId?: string,
      ) => BindGroup)
    | undefined,
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
): void {
  const recordPresented = createFoldedDrawRecorder(c);
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
  const colorFormatOverride = c.transparentColorFormat as GPUTextureFormat | undefined;
  // The prepared Standard topology is the frame authority. A bind-group
  // identity is only a resource result; using it to infer the shader lane
  // would silently fall back to URP when the clustered resource is missing.
  let lastVertexBuffer: GpuBuffer | null = null;
  let lastIndexBuffer: GpuBuffer | null = null;
  const bindingState: GeometryBindingState = {
    pipeline: null,
    instancesBuffer: null,
    instanceBindGroup: null,
    probeOffset: -1,
  };
  const identityInstanceBuffer = pipelineState.identityInstanceBuffer;
  let identityInstanceDraws: readonly GeometryInstanceDraw[] | undefined;
  const resolveIdentityInstanceDraws = (): readonly GeometryInstanceDraw[] =>
    (identityInstanceDraws ??= [
      {
        instanceBuffer: identityInstanceBuffer,
        instanceBindGroup: resolveGeometryInstancesBindGroup(c, identityInstanceBuffer, undefined),
        probeOffset: -1,
        instanceCount: 1,
      },
    ]);
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
  // Pipeline identity does not include material parameters or the material
  // asset handle. Keying this cache by material handle therefore misses for
  // every distinct asset even when all assets use the same PSO. The nested
  // table keeps lookup O(1) by shader and immutable render-state identity; the
  // renderer's authoritative cache still owns lifetime/invalidation, while
  // this frame-local table removes the hot call/lookup overhead.
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
      oit,
    },
    (action) => profileGeometrySegment(c, passKind, 'pipeline-selection', action),
  );
  const { resolveMaterialPipeline, resolveDrawPipeline, pipelineSelection, viewOffsetForBlend } =
    pipelineRequests;
  const drawPipelines = new Map<MaterialSnapshot, Map<object, DrawPipelineSelection[]>>();
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
  ): boolean => {
    const source = entry.source;
    const flags =
      (source.skinBinding !== undefined ? 1 : 0) |
      (source.probeBlendRecord !== undefined ? 2 : 0) |
      (isReflectedTransform(source.transform.world) ? 4 : 0) |
      (source.spriteInstances !== undefined ? 8 : 0) |
      (oitAccumulateDraw ? 16 : 0);
    const passKey = selectedPass === undefined ? NO_SELECTED_PASS : SELECTED_PASS;
    let byPass = drawPipelines.get(submeshMaterial);
    const candidates = byPass?.get(passKey);
    if (candidates !== undefined)
      for (const cached of candidates)
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
          return true;
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
    );
    // A fallback without a material pipeline entry may still be pending.
    if (
      !resolved ||
      pipelineRequests.reported ||
      pipelineSelection.pipeline === null ||
      pipelineSelection.material === null
    )
      return resolved;
    const selection: DrawPipelineSelection = {
      flags,
      layout: entry.mesh.layoutProjection,
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
    };
    if (byPass === undefined) {
      byPass = new Map();
      drawPipelines.set(submeshMaterial, byPass);
    }
    if (candidates === undefined) byPass.set(passKey, [selection]);
    else candidates.push(selection);
    return true;
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
  if (resolveMaterialBindGroup === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'geometry drawing has material bindings',
      hint: 'use preparation-only mode without a render pass or supply the draw material resolver',
    });

  // Rebuilt per source and owned by this invocation, including nested recording.
  const drawIndicesScratch: (number | undefined)[] = [];
  // Per-entity draw state: the entity's physical mesh address and fold, plus
  // the mesh binding and base instance draws its first surviving draw
  // prepares for every later submesh pass of the same entity.
  let entityMeshSlot = 0;
  let entityFold: FoldBucket | undefined;
  let entityDrawIndices: readonly (number | undefined)[] | undefined;
  let entityMeshBinding: ReturnType<typeof meshSsboBufferBinding> | undefined;
  let entityInstanceDraws: readonly GeometryInstanceDraw[] | undefined;
  let entityDirectMeshGroup = meshBindGroup;
  let entitySkinTask: SkinTaskBinding | undefined;
  let group2DynamicOffsets: readonly number[] = meshGroup2DynamicOffsets;

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
    i: number,
    submission: NonNullable<ReturnType<NonNullable<typeof c.pointsLines>['submission']>>,
    style: NonNullable<RenderableSnapshot['pointsLines']>['style'],
  ): void => {
    bindStencilReference(entry.stencilReference ?? 0);
    const pointsLinesOffset = (c.pointsLines?.slot(entry) ?? 0) * POINTS_LINES_VIEW_SLOT_STRIDE;
    // Like a transparent submesh, a blended point/line draw belongs to the
    // LDR blend sub-pass only; drawing it here too would blend it twice.
    const pointsLinesMaterial = drawMaterial(c, i);
    if (
      splitLdrSprite &&
      (pointsLinesMaterial.transparent === true ||
        pointsLinesMaterial.renderState?.blend !== undefined)
    )
      return;
    const pointsLinesBindGroup = resolveMaterialBindGroup(
      materialSlotIndices.at(i)?.[0] ?? 0,
      pointsLinesMaterial,
      entry.source.entityKey,
      entry.world ?? c.world,
      POINTS_LINES_MATERIAL_SHADER_ID,
    );
    const pointsLinesPipelineEntry = resolveMaterialPipeline(
      POINTS_LINES_MATERIAL_SHADER_ID,
      geometryRenderStateForTopology('line-list', {
        ...pointsLinesMaterial.renderState,
        cullMode: 'none',
      }),
      'triangle-list',
      'uint32',
      undefined,
      colorFormatOverride,
      submission.layoutProjection,
      undefined,
      pointsLinesFragmentEntry(style),
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
    // Expanded geometry owns different buffers from the source mesh.
    // Keep the ordinary draw state honest for the next CPU survivor.
    lastVertexBuffer = null;
    lastIndexBuffer = null;
    materialGroup1DynamicOffsets[0] = meshSsboBufferBinding(
      pipelineState.materialUniformBuffer,
      materialUniformSlot(c.runtime, pointsLinesMaterial) * MATERIAL_PER_ENTITY_STRIDE,
    ).byteOffset;
    pass.setBindGroup(1, pointsLinesBindGroup, materialGroup1DynamicOffsets, 0, 1);
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
    prepareMeshDraw(c, entry, entityFold !== undefined);
    pass.setBindGroup(2, pointsLinesMeshGroup, meshGroup2DynamicOffsets);
    const pointsLinesInstancesBg =
      resolveIdentityInstanceDraws()[0]?.instanceBindGroup ??
      resolveGeometryInstancesBindGroup(c, identityInstanceBuffer, undefined);
    pass.setBindGroup(3, pointsLinesInstancesBg);
    bindingState.instancesBuffer = identityInstanceBuffer;
    bindingState.instanceBindGroup = pointsLinesInstancesBg;
    bindingState.probeOffset = -1;
    recordPointsLinesDraw(pass, submission.plan);
    c.onRenderableDraw?.(entry);
    pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);
    lastViewOffset = viewBindGroupDynamicOffset;
  };

  // GPU ownership is per submesh. Prepare CPU buffers only after the exact
  // claim, material-pass and transparency filters leave a draw.
  const entityMeshSsboBinding = (): ReturnType<typeof meshSsboBufferBinding> =>
    (entityMeshBinding ??= meshSsboBufferBinding(
      pipelineState.meshStorageBuffer,
      entityMeshSlot * MESH_PER_ENTITY_STRIDE,
    ));

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
    if (entry.mesh.vertexBuffer !== lastVertexBuffer) {
      pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      lastVertexBuffer = entry.mesh.vertexBuffer;
    }
    // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
    // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
    // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
    if (
      entry.mesh.indexed &&
      entry.mesh.indexBuffer !== lastIndexBuffer &&
      entry.mesh.indexBuffer !== null
    ) {
      pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
      lastIndexBuffer = entry.mesh.indexBuffer;
    }
    const prepared =
      entityFold === undefined
        ? resolveGeometryInstanceBuffer(c, entry, resolveIdentityInstanceDraws(), false)
        : foldInstanceDraws(c, entityFold, entry.renderableIndex);
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
  const bindSubmeshMaterial = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    i: number,
    sourceSlot: number,
    submeshMaterial: MaterialSnapshot,
    selectedShaderId: string | undefined,
  ): BindGroup => {
    const materialSlot =
      materialSlotIndices.at(i)?.[sourceSlot] ?? materialSlotIndices.at(i)?.[0] ?? 0;
    const perSubmeshBg =
      c.profilePhase === undefined
        ? resolveMaterialBindGroup(
            materialSlot,
            submeshMaterial,
            entry.source.entityKey,
            entry.world ?? c.world,
            selectedShaderId,
          )
        : profileGeometrySegment(c, passKind, 'material-bind-groups', () =>
            resolveMaterialBindGroup(
              materialSlot,
              submeshMaterial,
              entry.source.entityKey,
              entry.world ?? c.world,
              selectedShaderId,
            ),
          );
    materialGroup1DynamicOffsets[0] = meshSsboByteOffset(
      pipelineState.materialUniformBuffer,
      materialUniformSlot(c.runtime, submeshMaterial) * MATERIAL_PER_ENTITY_STRIDE,
    );
    pass.setBindGroup(1, perSubmeshBg, materialGroup1DynamicOffsets, 0, 1);
    return perSubmeshBg;
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
    const resolvedInstanceDraws = probeBlendAvailable
      ? resolveGeometryInstanceBuffer(c, entry, resolveIdentityInstanceDraws(), true)
      : entityInstanceDraws;
    if (resolvedInstanceDraws == null) return null;
    const compactDrawIndex = submeshDrawIndex(entityDrawIndices, smIdx);
    const compactDraw =
      compactDrawIndex === undefined ? undefined : entry.source.gpuDrivenDraws?.[compactDrawIndex];
    const sourceDrawItemIndex =
      compactDrawIndex === undefined || compactDraw === undefined
        ? smIdx
        : gpuDrivenSourceDrawItemIndex(compactDraw, compactDrawIndex);
    const instanceDraws =
      submeshMaterial.surfaceModel === 'single-layer-medium' && passKind === 'forward'
        ? resolveSurfaceDirectInstanceDraws(c, entry, sourceDrawItemIndex, resolvedInstanceDraws)
        : resolvedInstanceDraws;
    if (instanceDraws === null) return null;
    if (passKind !== 'deferred' || c.visibleSurface === undefined) return instanceDraws;
    return instanceDraws.map((draw) => ({
      ...draw,
      firstInstance:
        sourceDrawItemIndex * (entry.source.instances?.instanceCount ?? 1) +
        (draw.firstInstanceOrdinal ?? 0),
    }));
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
  let submittedRange: ReturnType<typeof submeshRange>;
  let submittedInstances: readonly GeometryInstanceDraw[];
  let presentedFacts: RenderableDrawReceipt | undefined;
  let presentedHasPass = false;
  const recordPreparedSubmesh = (
    draw: GeometryInstanceDraw,
    command: 'draw' | 'draw-indexed',
    range: import('../device/gpu-residency').MeshGpuRange,
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
      presentedFacts = Object.freeze(facts);
      presentedHasPass = hasPass;
    }
    recordPresented(submittedEntry, submittedSubmesh, presentedFacts, submittedFold);
    if (surfacePass === undefined || draw.surfaceFrameBase === undefined) return;
    c.frameState.surfaceSubmissionObservation?.record(surfacePass, {
      kind: command,
      count: range.count,
      first: range.first,
      instanceCount: draw.instanceCount,
      firstInstance: 0,
      surfaceFrameBase: draw.surfaceFrameBase,
      memberIds: draw.surfaceMemberIds ?? [],
      pipelineIdentity: getOpaqueResourceIdentity(submittedPipeline as object),
      ...(submittedMaterialPipeline?.receipt === undefined
        ? {}
        : {
            receiptIdentity: submittedMaterialPipeline.receipt.identity,
            receiptGeneration: submittedMaterialPipeline.receipt.generation,
          }),
    });
  };
  const submitPreparedSubmesh = (): void => {
    submitSubmeshDraws(
      pass,
      bindingState,
      submittedPipeline,
      submittedInstances,
      submittedEntry.mesh.indexed,
      submittedRange.count,
      submittedRange.first,
      submittedRange.baseVertex,
      recordPreparedSubmesh,
    );
  };

  /** Bind the resolved pipeline's groups and submit one submesh pass's draws. */
  const submitSubmeshPass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    smIdx: number,
    submeshMaterial: MaterialSnapshot,
    selectedPass: DispatchEntry | undefined,
    perSubmeshBg: BindGroup,
    meshBinding: ReturnType<typeof meshSsboBufferBinding>,
  ): void => {
    const {
      pipeline: smPipelineHandle,
      material: materialPipelineEntry,
      probeBlend: probeBlendAvailable,
      viewOffset,
      shader: smMaterialShaderId,
    } = pipelineSelection;
    if (viewOffset !== lastViewOffset) {
      pass.setBindGroup(0, viewBindGroup as BindGroup, [viewOffset, 0]);
      lastViewOffset = viewOffset;
    }
    if (smPipelineHandle === null) {
      markPipelinePreparationPending(c.frameState, {
        code: 'material-pipeline-preparation',
        worldId: entry.source.worldId,
        entity: entry.source.entityKey,
        pass: passKind,
        ...(smMaterialShaderId === undefined ? {} : { shader: smMaterialShaderId.slice(0, 256) }),
      });
      return;
    }
    const instanceDraws = submeshInstanceDraws(entry, smIdx, submeshMaterial, probeBlendAvailable);
    if (instanceDraws === null) return;
    const materialGroup2Contract = materialPipelineEntry?.group2Contract;
    if (materialGroup2Contract === undefined) return;
    const group2BindGroup = selectSubmeshGroup2(entry, materialGroup2Contract, meshBinding);
    if (group2BindGroup === null) return;
    const fold = entityFold;
    prepareMeshDraw(c, entry, fold !== undefined);
    pass.setBindGroup(2, group2BindGroup, group2DynamicOffsets);
    const range = submeshRange(entry.mesh, smIdx);

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
    profileGeometrySegment(c, passKind, 'draw-submit', submitPreparedSubmesh);
    recordIblPipelineBinding(c, submeshMaterial, smPipelineHandle, perSubmeshBg);
  };

  /** Record one selected material pass of a submesh; false aborts the entity. */
  const recordSubmeshPass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    i: number,
    smIdx: number,
    sm: import('./frame-snapshot').ValidatedRenderable['mesh']['submeshes'][number],
    submeshMaterial: MaterialSnapshot,
    selectedPass: DispatchEntry | undefined,
  ): boolean => {
    // Temporal projects the selected material's alpha/motion contract,
    // not its authored Forward entry points or color outputs.
    const vertexEntry = passKind === 'temporal' ? undefined : selectedPass?.vertexEntry;
    let fragmentEntry =
      passKind === 'temporal'
        ? undefined
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
    const meshBinding = entityMeshSsboBinding();
    if (entityInstanceDraws === undefined && !bindEntityGeometry(entry, meshBinding)) return false;
    const perSubmeshBg = bindSubmeshMaterial(
      entry,
      i,
      sm.materialSlot,
      submeshMaterial,
      selectedShaderId,
    );
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
    );
    if (resolvedPipeline)
      submitSubmeshPass(entry, smIdx, submeshMaterial, selectedPass, perSubmeshBg, meshBinding);
    return true;
  };

  /** Record every selected material pass of one submesh; false aborts the entity. */
  const recordSubmesh = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    i: number,
    smIdx: number,
  ): boolean => {
    const sm = entry.mesh.submeshes[smIdx];
    if (sm === undefined) return true;
    const submeshMaterial = drawMaterial(c, i, sm.materialSlot);
    if (!rendersSelectedMaterial(matchedMaterials, entry.renderableIndex, submeshMaterial))
      return true;
    if (gpuDrivenOwnsSubmesh(c, entry, submeshDrawIndex(entityDrawIndices, smIdx), passKind))
      return true;
    const draws = submeshMaterialDraws(
      selectedDispatch,
      materialPasses.get(entry.renderableIndex),
      submeshMaterial,
      matchedMaterials?.get(entry.renderableIndex),
    );
    if (!isMaterialDrawList(draws))
      return recordSubmeshPass(entry, i, smIdx, sm, submeshMaterial, draws);
    for (const selectedPass of draws) {
      if (!recordSubmeshPass(entry, i, smIdx, sm, submeshMaterial, selectedPass)) return false;
    }
    return true;
  };

  const recordEntry = (i: number): void => {
    const entry = validatedOrdered[i];
    if (entry === undefined) return;
    const fold = c.foldDispatchPlan?.headBuckets.get(i);
    const meshSlot = meshDrawSlot(entry, fold !== undefined);
    // The typed transparent pass uses this common draw owner. Consume the
    // same fold plan as the legacy sprite pass, including coverage/depth draws.
    if (c.foldDispatchPlan?.skipIndices.has(i) === true) return;
    const pointsLines = entry.source.pointsLines;
    const pointsLinesSubmission =
      pointsLines === undefined ? undefined : c.pointsLines?.submission(entry);
    if (pointsLines !== undefined && pointsLinesSubmission?.plan.drawCount !== 1) return;
    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedMaterials !== null && !matchedMaterials.has(entry.renderableIndex)) return;
    // D-2 generalised feat-20260625 M2 / w7: entities whose EVERY submesh is
    // transparent draw in the separate LDR blend sub-pass, never here. A
    // mixed mesh draws its opaque submeshes here; the per-submesh filter
    // skips the transparent ones.
    if (
      selectedDispatch === undefined &&
      splitLdrSprite &&
      everyMaterialSlotTransparent(c, materialSlotIndices.at(i))
    )
      return;
    entityMeshSlot = meshSlot;
    entityFold = fold;
    entityMeshBinding = undefined;
    entityInstanceDraws = undefined;
    entityDirectMeshGroup = meshBindGroup;
    entitySkinTask = undefined;
    if (pointsLinesSubmission !== undefined && pointsLines !== undefined) {
      recordPointsLines(entry, i, pointsLinesSubmission, pointsLines.style);
      return;
    }
    // Dispatch counter bump — sprite folds into the same unlit bucket; the
    // bench reads sprite render counts via the transparent bucket length.
    dispatchCounts.unlit += 1;
    entityDrawIndices = gpuDrivenDrawIndicesBySubmesh(entry.source, entry.mesh, drawIndicesScratch);
    // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
    // Each submesh carries its own topology and material slot.
    for (const smIdx of entry.submeshIndices ?? entry.mesh.submeshes.keys()) {
      if (!recordSubmesh(entry, i, smIdx)) return;
    }
  };

  // A capture may sort against a different camera. Follow its selected dispatch
  // while retaining the original row index for material slots and GPU payloads.
  const drawOrder =
    selectedDispatch !== undefined && c.foldDispatchPlan == null && prepared?.ordered !== true
      ? dispatchDrawOrder(validatedOrdered, materialPasses)
      : undefined;
  for (let ordinal = 0; ordinal < validatedOrdered.length; ordinal++) {
    recordEntry(drawOrder?.[ordinal] ?? ordinal);
  }
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
      byMaterial = new FirstEntryMap();
      materialPasses.set(dispatch.renderableIndex, byMaterial);
    }
    includeMaterialPass(byMaterial, dispatch, temporal);
  }
  return materialPasses;
}

/** Selected-dispatch order first, then the remaining rows in validated order. */
function dispatchDrawOrder(
  validatedOrdered: readonly ValidatedRenderable[],
  materialPasses: Pick<MaterialPassLookup, 'size' | 'keys'>,
): number[] | undefined {
  // The retained phase normally publishes rows in this exact dispatch order.
  // Equal complete keys prove the ordinal loop already follows the selected
  // commands; no reverse index or second draw-order array is required.
  if (materialPasses.size === validatedOrdered.length) {
    let ordinal = 0;
    for (const key of materialPasses.keys()) {
      if (validatedOrdered[ordinal]?.renderableIndex !== key) break;
      ordinal += 1;
    }
    if (ordinal === validatedOrdered.length) return undefined;
  }
  const remaining = new Map<number, number>();
  for (let index = 0; index < validatedOrdered.length; index++)
    remaining.set((validatedOrdered[index] as ValidatedRenderable).renderableIndex, index);
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

function rendersSelectedMaterial(
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  renderableIndex: number,
  material: MaterialSnapshot,
): boolean {
  if (matchedMaterials === null) return true;
  return matchedMaterials.get(renderableIndex)?.has(material.materialHandle ?? 0) === true;
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
  byMaterial: FirstEntryMap<number, DispatchEntry | DispatchEntry[]> | undefined,
  material: MaterialSnapshot,
  matchedHandles: ReadonlySet<number> | undefined,
): DispatchEntry | readonly (DispatchEntry | undefined)[] {
  if (selectedDispatch === undefined) return DEFAULT_MATERIAL_DRAWS;
  const handle = material.materialHandle ?? 0;
  const selected = byMaterial?.get(handle);
  if (
    selected === undefined &&
    material.surfaceModel === 'single-layer-medium' &&
    matchedHandles?.has(handle) === true
  )
    return DEFAULT_MATERIAL_DRAWS;
  return selected ?? EMPTY_MATERIAL_DRAWS;
}

function isMaterialDrawList(
  draws: DispatchEntry | readonly (DispatchEntry | undefined)[],
): draws is readonly (DispatchEntry | undefined)[] {
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

/**
 * Resolve the per-entity @group(3) instance buffers for the geometry pass.
 *
 * @internal
 */
function uploadInstanceRanges(
  c: InstanceBufferContext,
  inst: NonNullable<RenderableSnapshot['instances']>,
  buffer: Buffer,
  ranges: readonly { readonly start: number; readonly end: number }[],
  storageBacked: boolean,
  sourceOffsetInstances = 0,
  previousInst: NonNullable<RenderableSnapshot['temporal']>['previousInstances'] = undefined,
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
          ),
        ),
      )
      .unwrap();
  const strideBytes =
    (storageBacked ? INSTANCE_STORAGE_STRIDE_FLOATS : 16) * Float32Array.BYTES_PER_ELEMENT;
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(inst.instanceCount, range.start));
    const end = Math.max(start, Math.min(inst.instanceCount, range.end));
    if (end <= start) continue;
    const source = inst.transforms.subarray(
      (sourceOffsetInstances + start) * 16,
      (sourceOffsetInstances + end) * 16,
    );
    // A generation-bearing previous collection is kept whole so a compacted
    // or reordered current range can resolve its real prior ordinal. Without
    // identity proof, keep the old range-local shape and let the packer seed
    // on count mismatch rather than pairing an unrelated slot.
    // One immutable generation column on both sides is the ordinal identity
    // mapping: pair range-locally without building a generation index.
    const sameGenerations =
      inst.generations !== undefined && previousInst?.generations === inst.generations;
    const hasIdentityProof =
      !sameGenerations && inst.generations !== undefined && previousInst?.generations !== undefined;
    const previousSource = hasIdentityProof
      ? previousInst?.transforms
      : previousInst?.transforms.subarray(
          (sourceOffsetInstances + start) * 16,
          (sourceOffsetInstances + end) * 16,
        );
    const currentGenerations = sameGenerations
      ? undefined
      : inst.generations?.subarray(sourceOffsetInstances + start, sourceOffsetInstances + end);
    const previousGenerations = sameGenerations
      ? undefined
      : hasIdentityProof
        ? previousInst?.generations
        : previousInst?.generations?.subarray(
            sourceOffsetInstances + start,
            sourceOffsetInstances + end,
          );
    const payload = storageBacked
      ? packInstanceStorageBuffer(
          world.frameArena.alloc(Float32Array, source.length * 2).unwrap(),
          source,
          previousSource,
          currentGenerations,
          previousGenerations,
        )
      : source;
    const written = c.runtime.device.queue.writeBuffer(buffer, start * strideBytes, payload);
    if (!written.ok) {
      c.runtime.errorRegistry.fire(written.error);
      return { ok: false, ranges: uploadedRanges, bytes: uploadedBytes };
    }
    uploadedRanges.push({ start, end });
    uploadedBytes += payload.byteLength;
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
    readonly lane: 'direct-storage' | 'chunked-storage' | 'direct-uniform' | 'chunked-uniform';
    readonly requestedBytes: number;
    readonly supportedBytes: number | undefined;
    readonly uploadRanges: readonly { readonly start: number; readonly end: number }[];
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

function instanceChunksForOwner(c: InstanceBufferContext, ownerKey: number) {
  const owners = c.frameState.instanceBufferChunks;
  if (owners === undefined) return undefined;
  let chunks = owners.get(ownerKey);
  if (chunks === undefined) {
    chunks = new Map<InstanceBufferChunkKey, InstanceBufferCacheEntry>();
    owners.set(ownerKey, chunks);
  }
  return chunks;
}

function clearInstanceChunksForOwner(c: InstanceBufferContext, ownerKey: number): void {
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
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
        detail: { maxStorageBufferBindingSize: cap, requestedBytes: strideBytes },
      }),
    );
    return null;
  }
  const ownerKey = instanceCollectionCacheKey(entry.source.worldId, inst);
  const chunks = instanceChunksForOwner(c, ownerKey);
  const activeKeys = new Set<number>();
  const draws: GeometryInstanceDraw[] = [];
  const uploadedRanges: { start: number; end: number }[] = [];
  let uploadedBytes = 0;
  const previousInstances = entry.source.temporal?.previousInstances;
  const pairing = instancePreviousPairing(inst, previousInstances);
  for (let start = 0; start < inst.instanceCount; start += chunkCapacity) {
    const end = Math.min(inst.instanceCount, start + chunkCapacity);
    const count = end - start;
    activeKeys.add(start);
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
      );
      for (const range of upload.ranges) {
        uploadedRanges.push({ start: range.start + start, end: range.end + start });
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
  retireNumericInstanceChunks(c, chunks, activeKeys);
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

export function resolveGeometryInstanceBuffer(
  c: InstanceBufferContext,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
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
    return resolveChunkedUniformInstanceDraws(c, entry, inst, probeBinding);
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
): readonly GeometryInstanceDraw[] {
  return resolveSpriteInstanceDraws(c, entry).map(({ buffer, count, firstInstanceOrdinal }) =>
    probeBoundInstanceDraw(c, buffer, undefined, count, firstInstanceOrdinal),
  );
}

function resolveInstanceProbeBinding(
  c: InstanceBufferContext,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  useProbeBlend: boolean,
): InstanceProbeBinding {
  if (!useProbeBlend || !c.runtime.device.caps.storageBuffer) return undefined;
  const record = entry.source.probeBlendRecord;
  if (record === undefined)
    return {
      buffer: ensureProbeBlendRecordBuffer(c.runtime.device, c.frameState, undefined),
      offset: 0,
    };
  return resolveProbeBlendBuffer(
    c,
    record,
    worldEntityKey(entry.source.worldId, entry.source.entityKey),
  );
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
  activeKeys: ReadonlySet<number>,
): void {
  for (const [key, stale] of chunks ?? []) {
    if (typeof key === 'string' || activeKeys.has(key)) continue;
    destroyInstanceBuffer(c, stale.buffer);
    chunks?.delete(key);
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  inst: NonNullable<RenderableSnapshot['instances']>,
  probeBinding: InstanceProbeBinding,
): readonly GeometryInstanceDraw[] | null {
  const chunks = instanceChunksForOwner(c, instanceCollectionCacheKey(entry.source.worldId, inst));
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
    active = { ...withUploadedRevision(active, inst.revision, undefined), usedFrame: frame };
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  inst: NonNullable<RenderableSnapshot['instances']>,
  probeBinding: InstanceProbeBinding,
): readonly GeometryInstanceDraw[] | null {
  const chunks = instanceChunksForOwner(c, instanceCollectionCacheKey(entry.source.worldId, inst));
  const activeKeys = new Set<number>();
  const draws: GeometryInstanceDraw[] = [];
  const uploaded: { ranges: { start: number; end: number }[]; bytes: number } = {
    ranges: [],
    bytes: 0,
  };
  for (let start = 0; start < inst.instanceCount; start += MAX_UNIFORM_INSTANCES) {
    const count = Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start);
    activeKeys.add(start);
    const active = resolveUniformInstanceChunk(c, entry, inst, chunks, start, uploaded);
    if (active === null) return null;
    draws.push(probeBoundInstanceDraw(c, active.buffer.handle, probeBinding, count, start));
  }
  retireNumericInstanceChunks(c, chunks, activeKeys);
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
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
    const upload = uploadInstanceRanges(
      c,
      inst,
      active.buffer.handle,
      plan.ranges,
      false,
      start,
      entry.source.temporal?.previousInstances,
    );
    for (const range of upload.ranges) {
      uploaded.ranges.push({ start: range.start + start, end: range.end + start });
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
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
  // The cache is keyed by worldEntityKey(worldId, cacheKey) + collectionId so
  // separate worlds cannot alias their instance buffers.
  const entityCacheKey = instanceCollectionCacheKey(entry.source.worldId, inst);
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
  entityCacheKey: number,
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  inst: NonNullable<RenderableSnapshot['instances']>,
  active: InstanceBufferCacheEntry,
  activeIsNew: boolean,
  requestedBytes: number,
): InstanceBufferCacheEntry | null {
  const { runtime, frameState } = c;
  const uniformFallback = runtime.device.caps.storageBuffer === false;
  const entityCacheKey = instanceCollectionCacheKey(entry.source.worldId, inst);
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
  let uploadRanges: readonly { readonly start: number; readonly end: number }[] = [];
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
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
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
      worldId: entry.source.worldId,
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
  entityKey?: number,
): { readonly buffer: Buffer; readonly offset: number } {
  const { runtime, frameState } = c;
  if (record === undefined) throw new Error('probe blend record is required for probe allocation');
  if (entityKey === undefined) throw new Error('probe blend record requires an entity key');
  const buffer = ensureProbeBlendRecordBuffer(runtime.device, frameState, [
    { cacheKey: entityKey, record },
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
                    value: { buffer: probeBuffer, offset: 0, size: PROBE_BLEND_RECORD_BYTE_SIZE },
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
