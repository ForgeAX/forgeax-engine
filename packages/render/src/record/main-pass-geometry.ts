import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from '../assembly/device-feature-admission';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import type { RenderResourceScope } from '../publication/resource-scope';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { FirstEntryMap } from './first-entry-map';
import { clusteredMeshSlotBindGroup, meshSlotBindGroup } from './frame-lighting';
import type { ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';
import { resolveSpriteInstancesBuffer } from './sprite-instance-buffer';
// @forgeax/engine-runtime - RenderSystem record stage: main-pass geometry draws.
// feat-20260704 M5/w31: further-split from main-pass.ts (AC-05 <=1500 lines/file).
// recordGeometryDraws + resolveGeometryInstanceBuffer, moved verbatim.

import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { STANDARD_TEXTURE_MASK_OVERRIDE } from '@forgeax/engine-shader';
import {
  ok,
  type ParamSchemaEntry,
  type PassKind,
  type PrimitiveTopology,
  type Result,
} from '@forgeax/engine-types';
import {
  MaterialSampledTextureBudgetExceededError,
  type VertexColorVariantConflictError,
} from '../errors/render';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { createHdrpSkinUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import {
  type InstanceCollectionFailureCode,
  instancePreviousPairing,
  planInstanceUpload,
} from '../instances';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import {
  classifyOitDraw,
  OIT_FRAGMENT_ENTRY,
  OIT_PREMULTIPLIED_FRAGMENT_ENTRY,
  oitAccumulateRenderState,
} from '../oit/eligibility';
import {
  createPbrSkinMeshBindGroupEntries,
  isStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  materialBindGroupLayoutIdentity,
  pbrSkinMeshDynamicOffsets,
  physicalTextureFields,
  SKIN_MATERIAL_SHADER_ID,
  SKIN_UNCOVERED_GBUFFER_ENTRY,
} from '../pbr-pipeline';
import {
  renderStateHash,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';
import type { PointsLinesRecordPlan } from '../points-lines/record';
import { POINTS_LINES_MATERIAL_SHADER_ID, pointsLinesFragmentEntry } from '../points-lines/record';
import type { RenderRecordPhase } from '../render-contract';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { PROBE_BLEND_RECORD_BYTE_SIZE, probeBlendRecordOffset } from '../scene/probe-blend-record';
import type { SurfacePassName } from '../surface/submission-observation';
import { createFoldedDrawRecorder, resolveFoldInstanceBuffer } from './fold-instance-buffer';
import {
  getOpaqueResourceIdentity,
  instanceCollectionCacheKey,
  worldEntityKey,
} from './frame-snapshot';
import {
  geometryRenderStateForTopology,
  isEntityFullyTransparent,
  selectGeometryPipeline,
  selectMaterialGroup2,
} from './main-pass-material';
import {
  getOrCreateFromChain,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  INSTANCE_UBO_FULL_ARRAY_BYTES,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  MESH_UBO_FULL_ARRAY_BYTES,
  packInstanceStorageBuffer,
} from './mesh-ssbo';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import type {
  _InternalRenderPipelineContext,
  MaterialShaderPipelineEntry,
  RenderSystemInternals,
} from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-context';
import { selectForwardFragmentEntry } from './standard-opaque-entry';
import {
  POINTS_LINES_VIEW_SLOT_STRIDE,
  translucentFogComposition,
  translucentViewOffset,
  writePointsLinesViewUbo,
} from './view-ubo';

const DEFAULT_MATERIAL_DRAWS: readonly undefined[] = Object.freeze([undefined]);
const EMPTY_MATERIAL_DRAWS: readonly DispatchEntry[] = Object.freeze([]);

/** Compared only within one renderable/material: omitted slots share its Surface owner. */
export function sameOpaqueTemporalDraw(a: DispatchEntry, b: DispatchEntry): boolean {
  return (
    ((isStandardPbrMaterialShader(a.materialShaderId) &&
      a.materialShaderId === b.materialShaderId) ||
      (a.tags.SurfaceKind === 'standard' &&
        b.tags.SurfaceKind === 'standard' &&
        a.tags.SurfaceModule === b.tags.SurfaceModule &&
        a.tags.GeometryVariant === b.tags.GeometryVariant)) &&
    a.renderState?.blend === undefined &&
    b.renderState?.blend === undefined &&
    a.renderState?.stencil === undefined &&
    b.renderState?.stencil === undefined &&
    a.stencilReference === b.stencilReference &&
    renderStateHash(a.renderState) === renderStateHash(b.renderState)
  );
}

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
  readonly surfaceFrameBase?: number;
  readonly surfaceMemberIds?: readonly string[];
};

type DirectSurfaceLayoutKind = 'surface-direct-pbr' | 'surface-direct-cluster-pbr';

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

function materialDiagnosticsEnabled(): boolean {
  if (typeof globalThis !== 'object' || globalThis === null || !('process' in globalThis)) {
    return false;
  }
  const processValue = (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process;
  return processValue?.env?.FORGEAX_MATERIAL_DIAGNOSTICS === '1';
}

type MaterialPipelineLookup = {
  readonly materialShaderId: string;
  readonly isHdrTarget: boolean;
  readonly renderStateKey: string;
  readonly topology: PrimitiveTopology;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly variantSet: string | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly passKind: PassKind;
  readonly layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection;
  readonly sampleCount: number;
  readonly colorFormatOverride: GPUTextureFormat | undefined;
  readonly additionalColorFormatsKey: string | undefined;
  readonly textureMask: number | undefined;
  readonly layoutKind: DirectSurfaceLayoutKind | undefined;
  readonly handle: MaterialShaderPipelineEntry | null;
};

type GeometryRecordProfileSegment = 'material-bind-groups' | 'pipeline-selection' | 'draw-submit';

type GeometryRenderState = ReturnType<typeof geometryRenderStateForTopology>;

/** Coverage is a dedicated temporal material variant, not a color/alpha tap. */
export function variantSetForCoveragePass(
  variantSet: string | undefined,
  coverageOnly: boolean,
): string | undefined {
  if (!coverageOnly) return variantSet;
  if (variantSet?.includes('COVERAGE_ONLY=true')) return variantSet;
  // A published definesKey spells every axis (sorted), including the color
  // producer's COVERAGE_ONLY=false; flip it in place to keep the key canonical.
  if (variantSet?.includes('COVERAGE_ONLY=false')) {
    return variantSet.replace('COVERAGE_ONLY=false', 'COVERAGE_ONLY=true');
  }
  return variantSet === undefined || variantSet === ''
    ? 'COVERAGE_ONLY=true'
    : `${variantSet}+COVERAGE_ONLY=true`;
}

export function isHdrGeometryTarget(
  tonemapActive: boolean,
  colorFormatOverride: GPUTextureFormat | undefined,
): boolean {
  return colorFormatOverride === undefined
    ? tonemapActive
    : colorFormatOverride === 'rgba16float' || colorFormatOverride === 'rgba32float';
}

function gpuDrivenDrawIndicesBySubmesh(
  source: RenderableSnapshot,
  mesh: _InternalRenderPipelineContext['validatedOrdered'][number]['mesh'],
): ReadonlyMap<number, number> | undefined {
  const draws = source.gpuDrivenDraws;
  if (draws === undefined || draws.length === 0) return undefined;
  const indices = new Map<number, number>();
  let hasStableSourceIdentity = false;
  for (const [compactIndex, draw] of draws.entries()) {
    const drawItemIndex = draw.drawItemIndex;
    if (drawItemIndex === undefined) continue;
    hasStableSourceIdentity = true;
    if (mesh.submeshes[drawItemIndex] !== undefined) indices.set(drawItemIndex, compactIndex);
  }
  if (hasStableSourceIdentity) return indices;

  // Legacy snapshots predating drawItemIndex are matched by their compact
  // geometry facts. New extracted snapshots never take this path.
  let nonIndexedFirst = 0;
  let drawCursor = 0;
  for (const [submeshIndex, submesh] of mesh.submeshes.entries()) {
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
      indices.set(submeshIndex, drawCursor);
      drawCursor += 1;
    }
  }
  return indices;
}

// One diagnostic per material and renderer: an exceeded material stays
// exceeded every frame, so repeating the event would only flood the registry.
const SAMPLED_TEXTURE_BUDGET_REPORTS = new WeakMap<object, Set<number>>();

function reportSampledTextureBudgetExceeded(
  runtime: Pick<RenderSystemInternals, 'errorRegistry' | 'device'>,
  material: Pick<MaterialSnapshot, 'materialHandle'>,
  conflicts: readonly string[],
): void {
  const materialHandle = material.materialHandle ?? -1;
  let reported = SAMPLED_TEXTURE_BUDGET_REPORTS.get(runtime.errorRegistry);
  if (reported === undefined) {
    reported = new Set();
    SAMPLED_TEXTURE_BUDGET_REPORTS.set(runtime.errorRegistry, reported);
  }
  if (reported.has(materialHandle)) return;
  reported.add(materialHandle);
  runtime.errorRegistry.fire(
    new MaterialSampledTextureBudgetExceededError({
      materialHandle,
      limit: runtime.device.limits.maxSampledTexturesPerShaderStage ?? 0,
      required: STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      conflicts,
    }),
  );
}

function recordIblPipelineBinding(
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

const SHARED_BOOT_MATERIAL_SHADER_IDS = new Set([
  'forgeax::default-unlit',
  'forgeax::default-shadow-caster',
  'forgeax::sprite',
  'forgeax::sprite-lit',
  'forgeax::default-sprite',
  'forgeax::msdf-text',
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
]);

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
  if (SHARED_BOOT_MATERIAL_SHADER_IDS.has(materialShaderId) && !hasStandardPhysicalMaps) {
    return undefined;
  }
  return materialBindGroupLayoutIdentity(materialShaderId, materialParamSchema);
}

/**
 * Resolve the depth contract for a geometry pass without changing the base
 * material state. Temporal scene-data shares the main pass depth attachment:
 * it is read-only and accepts the equal depth produced by the shared raster
 * projection, while motion varyings remain unjittered. It rejects fragments behind the visible
 * surface.
 */
export function geometryRenderStateForPass(
  base: GeometryRenderState,
  passKind: PassKind,
  coverageOnly = false,
): GeometryRenderState {
  if (passKind !== 'temporal') return base;
  const state = { ...base };
  delete state.outputs;
  return {
    ...state,
    colorWriteMask: 15,
    depthWriteEnabled: coverageOnly,
    depthCompare: 'less-equal' as const,
  };
}

/**
 * Transparent depth is an authored medium policy. A transparent pass with no
 * explicit depth-write bit remains read-only, which keeps alpha smoke and
 * ordinary blending from becoming an opaque occluder; water or a cutout-like
 * medium can opt in by setting the bit on its own pass state.
 */
export function authoredTransparentDepthWrite(
  transparent: boolean | undefined,
  renderState: MaterialSnapshot['renderState'],
): boolean {
  return (
    (transparent === true || renderState?.blend !== undefined) &&
    renderState?.depthWriteEnabled === true
  );
}

function geometryRecordPhase(
  passKind: PassKind,
  segment: GeometryRecordProfileSegment,
): RenderRecordPhase {
  const pass = passKind === 'deferred' ? 'g-buffer' : 'forward';
  return `record/graph-execute/${pass}/${segment}` as RenderRecordPhase;
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
  indexCount: number,
  vertexCount: number,
  indexOffset: number,
  baseVertex: number,
  onDraw?: (draw: GeometryInstanceDraw, command: 'draw' | 'draw-indexed') => void,
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
    if (indexed) {
      pass.drawIndexed(
        indexCount,
        instanceDraw.instanceCount,
        indexOffset,
        baseVertex,
        instanceDraw.firstInstance ?? 0,
      );
    } else {
      pass.draw(vertexCount, instanceDraw.instanceCount, 0, instanceDraw.firstInstance ?? 0);
    }
    onDraw?.(instanceDraw, indexed ? 'draw-indexed' : 'draw');
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

export function resolveGeometryMaterialVariantSet(
  shaderId: string,
  projection: import('@forgeax/engine-geometry').VertexLayoutProjection,
  variantSet: string | undefined,
  fixedArtifact: boolean,
): Result<string | undefined, VertexColorVariantConflictError> {
  // Builtin sprite variants own the region ABI; mesh color axes would erase the explicit all-true key.
  if (shaderId === 'forgeax::sprite' || shaderId === 'forgeax::sprite-lit') {
    return ok(variantSet);
  }
  if (fixedArtifact) return ok(undefined);
  return variantSetFromVertexLayoutProjection(projection, variantSet);
}

/**
 * feat-20260704 M3/w19: per-entity geometry (main colour) draw loop, extracted
 * verbatim from recordMainPass. Walks `c.validatedOrdered`, selects the
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
  materialSlotIndices: readonly (readonly number[])[],
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
  selectedDispatch?: readonly DispatchEntry[],
  colorFormats: readonly GPUTextureFormat[] = [],
  coverageOnly = false,
  fragmentEntryPoint?: string,
  surfacePass?: SurfacePassName,
  transparentDepthWrite = false,
  oit?: 'accumulate' | 'residual',
  preparationPassMatches?: (
    pass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>,
    material: MaterialSnapshot,
  ) => boolean,
  skipPreparationDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
): void {
  const recordPresented = createFoldedDrawRecorder(c);
  const {
    runtime,
    pipelineState,
    frameState,
    bindGroupCounts,
    dispatchCounts,
    tonemapActive,
    msaaActive,
    validatedOrdered,
    splitLdrSprite,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
  } = c;
  // A material usually selects one pass. Keep that dispatch directly and
  // allocate a pass list only when another distinct draw actually exists.
  const materialPasses = new Map<number, FirstEntryMap<number, DispatchEntry | DispatchEntry[]>>();
  for (const dispatch of selectedDispatch ?? EMPTY_MATERIAL_DRAWS) {
    let byMaterial = materialPasses.get(dispatch.renderableIndex);
    if (byMaterial === undefined) {
      byMaterial = new FirstEntryMap();
      materialPasses.set(dispatch.renderableIndex, byMaterial);
    }
    const passes = byMaterial.get(dispatch.materialHandle);
    if (passes === undefined) byMaterial.set(dispatch.materialHandle, dispatch);
    else if (Array.isArray(passes)) {
      let duplicate = false;
      if (passKind === 'temporal') {
        for (const previous of passes) {
          if (sameOpaqueTemporalDraw(previous, dispatch)) {
            duplicate = true;
            break;
          }
        }
      }
      if (!duplicate) passes.push(dispatch);
    } else if (passKind !== 'temporal' || !sameOpaqueTemporalDraw(passes, dispatch)) {
      byMaterial.set(dispatch.materialHandle, [passes, dispatch]);
    }
  }
  const diagnosticsEnabled = materialDiagnosticsEnabled();
  const colorFormatOverride = c.transparentColorFormat as GPUTextureFormat | undefined;
  // The prepared Standard topology is the frame authority. A bind-group
  // identity is only a resource result; using it to infer the shader lane
  // would silently fall back to URP when the clustered resource is missing.
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  // A no-tone frame may still render into a graph-owned floating-point target
  // (the linear-LDR route). Shader variants must follow the attachment's
  // numeric domain rather than the camera's tone-map switch, otherwise the
  // LDR/OETF fragment entry point is encoded once here and again by the
  // output transform.
  const isHdrTarget = isHdrGeometryTarget(tonemapActive, colorFormatOverride);
  const withCoverageVariant = (variantSet: string | undefined): string | undefined =>
    variantSetForCoveragePass(variantSet, coverageOnly);
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
  const profilePhase = c.profilePhase;
  const materialGroup1DynamicOffsets = new Uint32Array(1);
  const meshGroup2DynamicOffsets = [0];
  let lastStencilReference: number | null = null;
  let lastViewOffset = viewBindGroupDynamicOffset;
  const viewOffsetForBlend = (blend: GPUBlendState | undefined): number => {
    const composition = c.translucentFog === true ? translucentFogComposition(blend) : undefined;
    return composition === undefined
      ? viewBindGroupDynamicOffset
      : translucentViewOffset(composition);
  };
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
  const materialPipelineLookupCache = new Map<string, Map<string, MaterialPipelineLookup[]>>();
  // Attachment formats are pass-owned. Reuse their immutable projection and
  // comparison keys across every material lookup in this geometry pass.
  let additionalColorFormats: readonly GPUTextureFormat[] | undefined;
  let additionalColorFormatsKey: string | undefined;
  let standardFallbackFormats: readonly GPUTextureFormat[] | undefined;
  const recordOcclusionCandidate = (draw: () => void): void => {
    draw();
  };
  const resolveMaterialPipeline = (
    materialShaderId: string,
    renderState: MaterialSnapshot['renderState'],
    topology: PrimitiveTopology,
    indexFormat: 'uint16' | 'uint32',
    variantSet: string | undefined,
    colorFormat: GPUTextureFormat | undefined,
    layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection,
    vertexEntry?: string,
    fragmentEntry?: string,
    textureMask?: number,
    layoutKind?: DirectSurfaceLayoutKind,
    pipelinePreparation = false,
  ): MaterialShaderPipelineEntry | null => {
    const baseVariantSet = withCoverageVariant(variantSet);
    // Skinned Standard has no visible-surface variant: deformed draws publish no
    // rows, so its uncovered entry fills the identity target with row 0.
    const skinnedVisibleSurface =
      c.visibleSurface !== undefined &&
      passKind === 'deferred' &&
      isStandardPbrSkinMaterialShader(materialShaderId) &&
      (fragmentEntry === undefined || fragmentEntry === 'fs_gbuffer');
    if (skinnedVisibleSurface) fragmentEntry = SKIN_UNCOVERED_GBUFFER_ENTRY;
    const pipelineVariantSet =
      c.visibleSurface === undefined || skinnedVisibleSurface
        ? baseVariantSet
        : `${baseVariantSet ? `${baseVariantSet}+` : ''}VISIBLE_SURFACE_AVAILABLE=true`;
    // Deferred targets follow the graph's ordered GBuffer contract, including
    // an admitted temporal-v1 attachment. Forward fallback remains an extra
    // output only for its Standard producer; other forward shaders keep their
    // own single-target contract.
    const outputs = renderState?.outputs;
    if (
      outputs !== undefined &&
      (outputs.length !== colorFormats.length ||
        outputs.some((output, index) => output.format !== colorFormats[index]))
    ) {
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'material outputs match the graph attachments in location order',
        hint: `bind ${outputs.map((output) => `${output.name}:${output.format}`).join(', ')}; received ${colorFormats.join(', ')}`,
      });
    }
    // The OIT accumulation pass carries accum + weight; both OIT fragment
    // entries write both locations.
    let reflectionFallbackFormats: readonly GPUTextureFormat[] | undefined;
    let reflectionFallbackFormatsKey: string | undefined;
    if (outputs !== undefined || oit === 'accumulate' || passKind === 'deferred') {
      if (additionalColorFormats === undefined) {
        additionalColorFormats = colorFormats.slice(1);
        additionalColorFormatsKey = additionalColorFormats.join(',');
      }
      reflectionFallbackFormats = additionalColorFormats;
      reflectionFallbackFormatsKey = additionalColorFormatsKey;
    } else if (
      materialShaderId === 'forgeax::default-standard-pbr' &&
      c.reflectionFallbackColorFormat !== undefined
    ) {
      standardFallbackFormats ??= [c.reflectionFallbackColorFormat];
      reflectionFallbackFormats = standardFallbackFormats;
      reflectionFallbackFormatsKey = c.reflectionFallbackColorFormat;
    }
    const renderStateKey = renderStateHash(renderState);
    const shaderLookupCache = materialPipelineLookupCache.get(materialShaderId);
    const cachedLookups = shaderLookupCache?.get(renderStateKey);
    if (cachedLookups !== undefined) {
      for (const cached of cachedLookups) {
        if (
          cached.isHdrTarget === isHdrTarget &&
          cached.renderStateKey === renderStateKey &&
          cached.topology === topology &&
          cached.indexFormat === indexFormat &&
          cached.variantSet === pipelineVariantSet &&
          cached.vertexEntry === vertexEntry &&
          cached.fragmentEntry === fragmentEntry &&
          cached.textureMask === textureMask &&
          cached.layoutKind === layoutKind &&
          cached.passKind === passKind &&
          cached.layoutProjection.digest === layoutProjection.digest &&
          cached.sampleCount === sampleCount &&
          cached.colorFormatOverride === colorFormat &&
          cached.additionalColorFormatsKey === reflectionFallbackFormatsKey
        ) {
          return cached.handle;
        }
      }
    }
    // Published Surface artifacts carry both direct and scene-index modules.
    // The boot artifact may be the scene-index specialization selected by the
    // retained producer, so a direct slot-3 layout must still resolve the
    // explicit capability key. This keeps the module source, entry point and
    // pipeline layout on the same GPU_DRIVEN_SCENE_INDEX_AVAILABLE=false ABI.
    const resolvedVariantSetResult = resolveGeometryMaterialVariantSet(
      materialShaderId,
      layoutProjection,
      pipelineVariantSet,
      runtime.getMaterialArtifact?.(materialShaderId) !== undefined && layoutKind === undefined,
    );
    if (!resolvedVariantSetResult.ok) {
      runtime.errorRegistry.fire(resolvedVariantSetResult.error);
      return null;
    }
    const resolvedVariantSet = resolvedVariantSetResult.value;
    const fallbackVariantSet =
      materialShaderId !== 'forgeax::default-standard-pbr'
        ? resolvedVariantSet
        : c.reflectionFallbackColorFormat !== undefined && resolvedVariantSet === ''
          ? ''
          : `${resolvedVariantSet === undefined || resolvedVariantSet === '' ? '' : `${resolvedVariantSet}+`}REFLECTION_FALLBACK_AVAILABLE=${c.reflectionFallbackColorFormat !== undefined}`;
    const resolvePipeline = () =>
      (pipelinePreparation
        ? (runtime.prepareMaterialShaderPipelineEntry ?? runtime.getMaterialShaderPipelineEntry)
        : runtime.getMaterialShaderPipelineEntry)?.(
        materialShaderId,
        isHdrTarget,
        renderState,
        topology,
        indexFormat,
        fallbackVariantSet,
        passKind,
        undefined,
        sampleCount,
        colorFormat,
        undefined,
        undefined,
        undefined,
        layoutProjection,
        undefined,
        layoutKind,
        undefined,
        reflectionFallbackFormats,
        vertexEntry,
        fragmentEntry,
        undefined,
        textureMask === undefined ? undefined : { [STANDARD_TEXTURE_MASK_OVERRIDE]: textureMask },
      ) ?? null;
    const handle =
      profilePhase === undefined
        ? resolvePipeline()
        : profileGeometrySegment(c, passKind, 'pipeline-selection', resolvePipeline);
    // A null handle is a transient async-build signal (`rhi-not-available`),
    // not a stable pipeline result. Do not memoize it in this frame's lookup:
    // caching the first pending lookup would turn a one-frame shader warm-up
    // into a permanent skip for every later frame in a tight smoke loop. The
    // owning runtime cache remains the SSOT; retrying here is bounded by the
    // existing per-frame draw path and preserves the explicit skip-draw
    // recovery while the pipeline becomes ready.
    if (handle !== null) {
      const nextLookup: MaterialPipelineLookup = {
        materialShaderId,
        isHdrTarget,
        renderStateKey,
        topology,
        indexFormat,
        variantSet: pipelineVariantSet,
        vertexEntry,
        fragmentEntry,
        passKind,
        layoutProjection,
        sampleCount,
        colorFormatOverride: colorFormat,
        additionalColorFormatsKey: reflectionFallbackFormatsKey,
        textureMask,
        layoutKind,
        handle,
      };
      if (shaderLookupCache === undefined) {
        materialPipelineLookupCache.set(
          materialShaderId,
          new Map([[renderStateKey, [nextLookup]]]),
        );
      } else if (cachedLookups === undefined) {
        shaderLookupCache.set(renderStateKey, [nextLookup]);
      } else {
        cachedLookups.push(nextLookup);
      }
    }
    return handle;
  };

  const pipelineSelection: {
    pipeline: RenderPipeline | null;
    material: MaterialShaderPipelineEntry | null;
    probeBlend: boolean;
    viewOffset: number;
    shader: string | undefined;
  } = { pipeline: null, material: null, probeBlend: false, viewOffset: 0, shader: undefined };
  const resolveDrawPipeline = (
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
    pipelinePreparation = false,
  ): boolean => {
    const isSkinEntry = entry.source.skin !== undefined;
    const probeBlendRecordAvailable =
      runtime.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    const smMaterialShaderId =
      selectedPass !== undefined
        ? selectedShaderId
        : entry.source.skin !== undefined
          ? isStandardPbrSkinMaterialShader(submeshMaterial.materialShaderId)
            ? submeshMaterial.materialShaderId
            : SKIN_MATERIAL_SHADER_ID
          : submeshMaterial.materialShaderId;
    const shaderArtifact =
      smMaterialShaderId === undefined
        ? undefined
        : runtime.getMaterialShaderArtifact?.(smMaterialShaderId, {
            deformation: isSkinEntry ? 'skin' : 'rigid',
            address: 'direct',
            clustered: clusteredLighting,
            vertexColorAvailable: entry.mesh.layoutProjection.attributes.some(
              (attribute) => attribute.key === 'color',
            ),
          });
    const cookedProbeBlend =
      shaderArtifact !== undefined && requiresProbeBlendRecord(shaderArtifact);
    const probeBlendAvailable =
      runtime.device.caps.storageBuffer &&
      (cookedProbeBlend ||
        (probeBlendRecordAvailable &&
          (isStandardPbrMaterialShader(smMaterialShaderId) ||
            submeshMaterial.surfaceModel === 'single-layer-medium')));
    const isSpriteShader =
      smMaterialShaderId === 'forgeax::sprite' || smMaterialShaderId === 'forgeax::sprite-lit';
    // Preserve the dedicated sprite-pass state when the linear-LDR graph
    // routes a sprite through this generic geometry path. Negative scale
    // flips winding, so back-face culling would erase the quad.
    const basePipelineRenderState = isSpriteShader
      ? {
          ...selectedRenderState,
          depthWriteEnabled: false,
          depthCompare: 'less-equal' as const,
          cullMode: 'none' as const,
          blend: selectedRenderState?.blend ?? SPRITE_PREMULTIPLIED_ALPHA_BLEND,
        }
      : geometryRenderStateForTopology(smTopology, selectedRenderState);
    let pipelineRenderState = geometryRenderStateForPass(
      basePipelineRenderState,
      passKind,
      coverageOnly,
    );
    if (
      transparentDepthWrite &&
      passKind === 'forward' &&
      (submeshMaterial.transparent === true || selectedRenderState?.blend !== undefined)
    ) {
      pipelineRenderState = {
        ...pipelineRenderState,
        depthWriteEnabled: authoredTransparentDepthWrite(
          submeshMaterial.transparent,
          selectedRenderState,
        ),
        depthCompare: 'less-equal',
      };
    }
    // Fog composition follows the authored blend, before OIT replaces it.
    const viewOffset = viewOffsetForBlend(pipelineRenderState?.blend);
    if (oitAccumulateDraw) pipelineRenderState = oitAccumulateRenderState(pipelineRenderState);
    let smPipelineHandle: typeof pipelineState.unlitPipeline;
    let materialPipelineEntry: MaterialShaderPipelineEntry | null = null;
    if (smMaterialShaderId === undefined || smMaterialShaderId === 'forgeax::default-unlit') {
      const unlitShaderId = smMaterialShaderId ?? 'forgeax::default-unlit';
      const unlitProjectionVariantResult = variantSetFromVertexLayoutProjection(
        entry.mesh.layoutProjection,
        undefined,
      );
      if (!unlitProjectionVariantResult.ok) {
        runtime.errorRegistry.fire(unlitProjectionVariantResult.error);
        return false;
      }
      const unlitHasColor = unlitProjectionVariantResult.value === 'VERTEX_COLOR_AVAILABLE=true';
      const unlitVariantSet = standardStorageVariantSet(
        runtime.device.caps.storageBuffer,
        unlitHasColor,
      );
      const unlitRsp = resolveMaterialPipeline(
        unlitShaderId,
        pipelineRenderState,
        smTopology,
        entry.mesh.indexFormat,
        unlitVariantSet,
        colorFormatOverride,
        entry.mesh.layoutProjection,
        vertexEntry,
        fragmentEntry,
        submeshMaterial.standardTextureMask,
        undefined,
        pipelinePreparation,
      );
      materialPipelineEntry = unlitRsp;
      smPipelineHandle =
        unlitRsp?.pipeline ??
        (colorFormatOverride === undefined
          ? selectGeometryPipeline(pipelineState, isHdrTarget, msaaActive)
          : null);
    } else if (smMaterialShaderId !== undefined) {
      // feat-20260609 M4.5 / w38 (D-11): the variantSet handed to
      // getMaterialShaderPipeline MUST mirror the boot-time
      // `definesKey` rule at createRenderer.ts:2483-2485 (sortedEntries
      // .every(v=>v===true) ? '' : 'A=v+...'). manifest variant.definesKey
      // is `''` for the all-true variant, so HDRP (both axes true) must
      // pass the canonical empty key to hit that variant via
      // findVariantByKey. Passing the expanded form would produce a
      // miss and silently fall back to the registered default WGSL,
      // creating a layout/binding mismatch under HDRP.
      //
      // URP path passes the explicit expanded form because the URP
      // variant's manifest definesKey IS that exact non-empty string
      // (CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true)
      // -- the canonical-empty rule only applies to the all-true case.
      const hasVertexColor = entry.mesh.layoutProjection.attributes.some(
        (attribute) => attribute.key === 'color',
      );
      // The all-true HDRP variant uses the canonical empty key only when
      // every variant axis is true. A plain mesh adds the geometry-owned
      // VERTEX_COLOR_AVAILABLE=false axis, so retain the two capability
      // axes explicitly or the selector would silently choose the URP
      // group(2) layout for an HDRP cluster bind group.
      const capabilityVariantSet = standardTopologyVariantSet(
        c.standardLighting,
        runtime.device.caps.storageBuffer,
        hasVertexColor,
        probeBlendAvailable,
      );
      const transmissionAdmission = standardTransmissionAdmission(
        submeshMaterial,
        runtime.device.limits.maxSampledTexturesPerShaderStage,
      );
      if (transmissionAdmission?.kind === 'exceeded')
        reportSampledTextureBudgetExceeded(
          runtime,
          submeshMaterial,
          transmissionAdmission.conflicts,
        );
      const transmissionAvailable =
        transmissionAdmission !== undefined && transmissionAdmission.kind !== 'exceeded';
      const materialCapabilityVariantSet =
        transmissionAvailable && !capabilityVariantSet.includes('TRANSMISSION_AVAILABLE=')
          ? `${capabilityVariantSet}+TRANSMISSION_AVAILABLE=true`
          : capabilityVariantSet;
      // Regular sprite keeps the boot-selected artifact; SpriteInstances
      // uses the explicit empty key for PER_INSTANCE_REGION=true. Sprite-lit
      // is different: the typed Standard transparent lane records it here,
      // so its shader must follow the frame-owned cluster topology or local
      // lights disappear while the ordinary sprite path remains direct.
      const variantSet = isSpriteShader
        ? smMaterialShaderId === 'forgeax::sprite-lit'
          ? `${materialCapabilityVariantSet}+PER_INSTANCE_REGION=${entry.source.spriteInstances !== undefined}`
          : entry.source.spriteInstances !== undefined
            ? ''
            : undefined
        : authoredVariantSet === undefined
          ? materialCapabilityVariantSet
          : `${materialCapabilityVariantSet}+${authoredVariantSet}`;
      // Draws on the unfogged View slot skip the translucent fog chain.
      const forwardFragmentEntry = selectForwardFragmentEntry({
        passKind,
        fragmentEntry,
        oitAccumulate: oitAccumulateDraw,
        viewOffset,
        atmosphereCapture: c.capturedAtmosphere !== undefined,
      });
      const cachedPipeline = resolveMaterialPipeline(
        smMaterialShaderId,
        pipelineRenderState,
        smTopology,
        entry.mesh.indexFormat,
        variantSet,
        colorFormatOverride,
        entry.mesh.layoutProjection,
        vertexEntry,
        forwardFragmentEntry,
        submeshMaterial.standardTextureMask,
        submeshMaterial.surfaceModel === 'single-layer-medium' && passKind === 'forward'
          ? capabilityVariantSet.includes('CLUSTER_FORWARD_AVAILABLE=true')
            ? 'surface-direct-cluster-pbr'
            : 'surface-direct-pbr'
          : undefined,
        pipelinePreparation,
      );
      // feat-20260615-pipeline-spec-ssot M6-T1: cache miss resolves to
      // null uniformly across URP / HDRP / skin shaders. Charter P3
      // explicit failure: the pre-M6 URP-path silent fallback to the
      // boot-time `pipelineState.standardPipeline*` (M4.5-followup w43)
      // masked real PipelineSpecError build failures behind a
      // layout-compatible-but-wrong PSO. The per-submesh
      // `if (smPipelineHandle === null) continue` skip-draw (which
      // already covered HDRP-active and skin miss paths) is now the
      // single uniform recovery shape -- one frame of skip-draw on
      // first-touch, then the cached PSO flows in once the async
      // build resolves. The pre-loop skin-PSO probe still skips the
      // entire entry on first-submesh probe miss; this site only
      // fires on per-submesh topology variance miss.
      materialPipelineEntry = cachedPipeline;
      smPipelineHandle = cachedPipeline?.pipeline ?? null;
    } else {
      smPipelineHandle = selectGeometryPipeline(pipelineState, isHdrTarget, msaaActive);
    }
    pipelineSelection.pipeline = smPipelineHandle;
    pipelineSelection.material = materialPipelineEntry;
    pipelineSelection.probeBlend = probeBlendAvailable;
    pipelineSelection.viewOffset = viewOffset;
    pipelineSelection.shader = smMaterialShaderId;
    return true;
  };

  if (preparationPassMatches !== undefined) {
    for (const entry of c.pipelinePreparationEntries ?? []) {
      const passes = entry.source.pipelinePreparation ?? [];
      const authoredVariantSet = variantSetFromDefines(passes.at(-1)?.defines);
      for (const [submeshIndex, sm] of entry.mesh.submeshes.entries()) {
        if (skipPreparationDraw?.(entry, submeshIndex)) continue;
        const material = entry.source.materials[sm.materialSlot] ?? entry.source.material;
        for (const preparedPass of entry.source.pipelinePreparation ?? []) {
          const selectedPass = preparedPass;
          if (
            selectedPass.materialHandle !== (material.materialHandle ?? 0) ||
            !preparationPassMatches(selectedPass, material)
          )
            continue;
          let fragmentEntry =
            passKind === 'temporal'
              ? undefined
              : (fragmentEntryPoint ?? selectedPass.fragmentEntry);
          let accumulate = false;
          if (oit !== undefined) {
            const eligibility = classifyOitDraw({
              materialShaderId: selectedPass.materialShaderId,
              skinned: entry.source.skin !== undefined,
              renderState: selectedPass.renderState,
              fragmentEntry,
            });
            if (eligibility.eligible !== (oit === 'accumulate')) continue;
            accumulate = eligibility.eligible;
            if (eligibility.eligible)
              fragmentEntry = eligibility.premultiplied
                ? OIT_PREMULTIPLIED_FRAGMENT_ENTRY
                : OIT_FRAGMENT_ENTRY;
          }
          const resolved = resolveDrawPipeline(
            entry,
            sm.topology,
            material,
            selectedPass,
            selectedPass.materialShaderId,
            selectedPass.renderState,
            passKind === 'temporal' ? undefined : selectedPass.vertexEntry,
            fragmentEntry,
            accumulate,
            authoredVariantSet,
            true,
          );
          // A fallback visible pipeline does not qualify an explicitly requested authored PSO.
          if (!resolved || pipelineSelection.material === null)
            markPipelinePreparationPending(frameState, {
              code: 'material-pipeline-preparation',
              worldId: entry.source.worldId,
              entity: entry.source.entityKey,
              pass: passKind,
              ...(selectedPass.materialShaderId === undefined
                ? {}
                : { shader: selectedPass.materialShaderId.slice(0, 256) }),
            });
        }
      }
    }
  }

  // Preparation shares the exact resolver but never opens or binds a raster pass.
  if (pass === undefined) return;
  if (resolveMaterialBindGroup === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'geometry drawing has material bindings',
      hint: 'use preparation-only mode without a render pass or supply the draw material resolver',
    });

  entries: for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;
    // The typed transparent pass uses this common draw owner. Consume the
    // same fold plan as the legacy sprite pass, including coverage/depth draws.
    if (c.foldDispatchPlan?.skipIndices.has(i) === true) continue;
    // Points/Lines share the Standard geometry pass. Their retained source
    // is prepared once by the renderer owner, while this loop remains the
    // sole pass/draw submission owner and preserves the authored topology.
    const pointsLinesSubmission = c.pointsLines?.prepare(entry, clusteredLighting);
    if (entry.source.pointsLines !== undefined && pointsLinesSubmission?.plan.drawCount !== 1)
      continue;

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedMaterials !== null && !matchedMaterials.has(entry.renderableIndex)) continue;

    // D-2 generalised feat-20260625 M2 / w7: transparent entities are
    // dispatched in the separate sub-pass (bgra8unorm unorm view,
    // loadOp=load) so they must NOT be drawn here in the geometry pass
    // (bgra8unorm-srgb sRGB view, loadOp=clear). In the HDR path
    // (tonemapActive=true) or when there are no transparent entries,
    // splitLdrSprite=false and this guard is a no-op. Post-w13 the
    // legacy shadingModel arm is gone; transparent is the single SSOT
    // mirrored on `computeSplitLdrSprite`.
    //
    // feat-city-glb Bug 5 (per-submesh transparency): only skip the WHOLE
    // entity here when EVERY submesh is transparent (the sprite / fully-
    // transparent-mesh fast path, byte-identical to the pre-fix behavior for
    // single-material entities). A mixed mesh (opaque road submesh + BLEND
    // decal submesh) is NOT skipped at the entity level; its opaque submeshes
    // draw here and the per-submesh loop below skips the transparent ones
    // (they are drawn in the blend sub-pass instead).
    if (selectedDispatch === undefined && splitLdrSprite && isEntityFullyTransparent(entry.source))
      continue;

    const pipelineTag: 'unlit' = 'unlit';

    if (pointsLinesSubmission !== undefined && entry.source.pointsLines !== undefined) {
      const stencilReference = entry.stencilReference ?? 0;
      if (stencilReference !== lastStencilReference) {
        pass.setStencilReference(stencilReference);
        lastStencilReference = stencilReference;
      }
      // Like a transparent submesh, a blended point/line draw belongs to the
      // LDR blend sub-pass only; drawing it here too would blend it twice.
      if (
        splitLdrSprite &&
        (entry.source.material.transparent === true ||
          entry.source.material.renderState?.blend !== undefined)
      )
        continue;
      const pointsLinesMaterial: MaterialSnapshot = {
        ...entry.source.material,
        materialShaderId: POINTS_LINES_MATERIAL_SHADER_ID,
        materialParamSchema:
          runtime.getParamSchema?.(POINTS_LINES_MATERIAL_SHADER_ID) ??
          entry.source.material.materialParamSchema,
      };
      const materialSlot = materialSlotIndices[i]?.[0] ?? 0;
      const pointsLinesBindGroup = resolveMaterialBindGroup(
        materialSlot,
        pointsLinesMaterial,
        entry.source.entityKey,
        entry.world ?? c.world,
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
        pointsLinesSubmission.layoutProjection,
        undefined,
        pointsLinesFragmentEntry(entry.source.pointsLines.style),
      );
      if (pointsLinesPipelineEntry === null) continue;
      const pointsLinesPipeline = pointsLinesPipelineEntry.pipeline;
      if (pipelineState.pointsLinesViewBuffer === undefined) continue;
      writePointsLinesViewUbo(
        runtime.device.queue,
        pipelineState.pointsLinesViewBuffer,
        c.camera,
        c.targetW,
        c.targetH,
        entry.source.transform.world,
        entry.source.pointsLines.style,
        i * POINTS_LINES_VIEW_SLOT_STRIDE,
      );
      pass.setBindGroup(
        0,
        viewBindGroup as BindGroup,
        new Uint32Array([
          viewOffsetForBlend(pointsLinesMaterial.renderState?.blend),
          i * POINTS_LINES_VIEW_SLOT_STRIDE,
        ]),
        0,
        2,
      );
      pass.setPipeline(pointsLinesPipeline);
      bindingState.pipeline = pointsLinesPipeline;
      pass.setVertexBuffer(0, pointsLinesSubmission.vertexBuffer);
      pass.setIndexBuffer(pointsLinesSubmission.indexBuffer, 'uint32');
      // Expanded geometry owns different buffers from the source mesh.
      // Keep the ordinary draw state honest for the next CPU survivor.
      lastVertexBuffer = null;
      lastIndexBuffer = null;
      materialGroup1DynamicOffsets[0] = meshSsboBufferBinding(
        pipelineState.materialUniformBuffer,
        materialSlot * MATERIAL_PER_ENTITY_STRIDE,
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
              i * MESH_PER_ENTITY_STRIDE,
            );
      meshGroup2DynamicOffsets[0] = meshSsboBufferBinding(
        pipelineState.meshStorageBuffer,
        i * MESH_PER_ENTITY_STRIDE,
      ).byteOffset;
      if (pointsLinesMeshGroup === null) continue;
      pass.setBindGroup(2, pointsLinesMeshGroup, meshGroup2DynamicOffsets);
      const pointsLinesInstancesBg =
        resolveIdentityInstanceDraws()[0]?.instanceBindGroup ??
        resolveGeometryInstancesBindGroup(c, identityInstanceBuffer, undefined);
      pass.setBindGroup(3, pointsLinesInstancesBg);
      bindingState.instancesBuffer = identityInstanceBuffer;
      bindingState.instanceBindGroup = pointsLinesInstancesBg;
      bindingState.probeOffset = -1;
      recordOcclusionCandidate(() => recordPointsLinesDraw(pass, pointsLinesSubmission.plan));
      c.onRenderableDraw?.(entry);
      pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);
      lastViewOffset = viewBindGroupDynamicOffset;
      continue;
    }

    // Dispatch counter bump — sprite folds into the same 2-bucket
    // surface for now (`pipelineDispatchCounts.{unlit, standard}`
    // mirror the original 2-pipeline scope; sprite-bucket counters
    // can land in a follow-up if AI users need them separately).
    // sprite entries do not bump either counter — the bench (M-4)
    // can read sprite render counts via the transparent bucket
    // length instead.
    if (pipelineTag === 'unlit') dispatchCounts.unlit += 1;

    const fold = c.foldDispatchPlan?.headBuckets.get(i);
    let baseInstanceDraws: readonly GeometryInstanceDraw[] | undefined;

    // feat-20260611 R2 / M8 / w28 (IS-14): skin entries need a 3-binding
    // group(2) BG matching `pbr-skin-pl` (binding 0 mesh-array UBO +
    // binding 1 current palette UBO + binding 2 previous palette UBO).
    // Building this here -- not in the
    // `meshBindGroup` factory above -- because the binding-shape
    // (1-entry vs 3-entry) is per-entry, not per-frame. URP / HDRP
    // entries keep using `meshGroup2` (1-entry mesh-array or HDRP
    // unified). The skin-variant cache key includes both buffer
    // identities so a future allocator-driven palette buffer rotation
    // invalidates the BG without manual eviction.
    //
    // PSO-availability gate: only swap to the skin BG when (a) the
    // skin pipeline layout itself was built (charter P3 fail-stop on
    // BGL-build failure), AND (b) the skin PSO cache returns a non-null
    // pipeline for this entry. Without (b), the per-submesh selector
    // below falls back to URP `standardPipeline` (`pbr-pl` layout,
    // 1-entry mesh-array BGL); binding the 3-entry skin BG against
    // that pipeline reproduces the exact `pbr-mesh-array-bgl ... does
    // not match layout pbr-skin-mesh-array-bgl` device error R1
    // captured. Mirrors the uniform null skip-draw pattern (M6-T1).
    let group2BindGroup: BindGroup = meshGroup2 as BindGroup;
    // feat-20260612-skin-palette-per-frame-upload M3 / m3-2: dyn-offset
    // tuple follows the skin group2 offset contract. Defaults to the
    // length-1 non-skin shape; the skin branch below re-computes with the
    // per-entity `entry.source.skin.byteOffset` cursor.
    const meshBinding = meshSsboBufferBinding(
      pipelineState.meshStorageBuffer,
      i * MESH_PER_ENTITY_STRIDE,
    );
    const directMeshGroup =
      pipelineState.meshStorageBuffer.pages === undefined
        ? meshBindGroup
        : meshSlotBindGroup(
            runtime.device,
            c.frameState,
            pipelineState,
            c.bindGroupCounts,
            i * MESH_PER_ENTITY_STRIDE,
          );
    meshGroup2DynamicOffsets[0] = meshBinding.byteOffset;
    let group2DynamicOffsets: readonly number[] = meshGroup2DynamicOffsets;
    const isSkinEntry = entry.source.skin !== undefined;
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-3 + M6: the
    // record stage reads the GPU buffer reference through
    // `entry.source.skin.buffer` (per-slice carrier set at extract time
    // by allocateSlice). On the storage path every slice carries the
    // same shared buffer pointer, so the BG cache key collapses to one
    // entry per frame (miss=1 + hit=N-1). On the uniform fallback path
    // each slice carries its own per-entity 16320 B UBO, so the BG
    // cache key naturally splits per entity (one BG per buffer pointer)
    // -- there is no shared-buffer assumption to break under
    // 16 KiB UBO cap. Charter P3 explicit failure preserved: skin
    // entries skip when the pipeline layout is missing OR the slice
    // failed to allocate (no buffer field). dynOffset[1] = byteOffset
    // is 0 on the uniform path (entry already covers the full buffer)
    // and walks 0, 1536, 3072, ... on the storage path.
    const skinAllocator = pipelineState.skinPaletteAllocator;
    const skinSlice = entry.source.skin;
    // The selected pipeline owns group(2). Resolve the palette binding lazily
    // for each submesh: one mesh may mix direct and clustered skin programs.
    const skinBindGroupFor = (
      contract: MaterialShaderPipelineEntry['group2Contract'],
    ): BindGroup | null => {
      if (skinAllocator === null || skinSlice === undefined) return null;
      if (contract !== 'skin' && contract !== 'skin-cluster') return null;
      const layout =
        contract === 'skin-cluster'
          ? pipelineState.hdrpSkinMeshBindGroupLayout
          : pipelineState.pbrSkinMeshBindGroupLayout;
      if (layout === null) return null;
      const hdrpBuffers =
        contract === 'skin-cluster'
          ? getOrCreateHdrpBuffers(runtime, frameState.installedPipelineConfig?.clusterGrid)
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
          skinSlice.buffer,
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
              skinSlice.buffer,
              skinAllocator.bindingWindowBytes,
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
            entries: createPbrSkinMeshBindGroupEntries(
              meshBinding.buffer,
              meshBindSize,
              skinSlice.buffer,
              skinAllocator.bindingWindowBytes,
            ),
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
    };
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@fallback sprite
    // bucket): sprite entries get a per-entity material BindGroup so
    // each sprite carries its own texture binding at @group(1) @binding(2).
    // Bindings 3..6 (metallicRoughness sampler/texture + normal
    // sampler/texture) bind `pipelineState.defaultSampler` +
    // `pipelineState.defaultWhiteTextureView` placeholders (D-1
    // candidate b — zero new GPU resource; the 1x1 white view was
    // already provisioned for unlit / standard fallback so the sprite
    // path adds 4 binding references, no new resource code).
    //
    // Missing-texture fallback (AC-18 path 4 + R7 isolation): when the
    // sprite texture has no GPU view, the binding uses
    // `defaultWhiteTextureView` as the fallback texture and the
    // material UBO upload above wrote debug-pink colorTint so the
    // sprite is visually distinct. The warn-once + RhiError surface
    // fires inside the upload loop. R7 isolation: this does NOT change
    // the existing unlit / standard bucket missing-texture handling —
    // those keep their silent-white fallback (a future
    // `feat-future-pbr-missing-texture-fallback-explicit` will retrofit).
    // bug-20260610 layer 7d: BG is per-submesh — each iteration of
    // the submesh draw loop below builds (or cache-hits) a BG with
    // matsForRebind[smIdx]'s 5 textureViews (baseColor / MR / normal /
    // emissive / occlusion). Cache key is 14-handle-id only (entityKey
    // dropped) so identical-material submeshes / entities dedup
    // globally. Sprite path is unchanged (single spriteBg, sprite
    // per-submesh OOS-1). The non-sprite branch leaves perSubmeshBg
    // declared but null; the submesh loop reassigns it per iteration
    // and the source-grep gate in skylight-fallback-path.test.ts /
    // systems.unit.test.ts continues to match
    // `setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b` on the in-loop call.
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-1
    // candidate b): the sprite-specific BG construction is gone — sprite
    // materials reuse the same per-submesh BG path PBR / unlit use. The
    // 7-entry BGL is byte-for-byte shared (binding 0 = Material UBO,
    // 1 = baseColorSampler, 2 = baseColorTexture, 3-6 = filler samplers /
    // textureViews). Sprite's "no metallic/normal/emissive/occlusion
    // texture" simply falls through to `defaultWhite` / `defaultNormal`
    // — the same placeholders the unlit path already used. The generic
    // branch below builds the per-submesh BG.
    let perSubmeshBg: BindGroup | null = null;
    const gpuDrivenDrawIndices = gpuDrivenDrawIndicesBySubmesh(entry.source, entry.mesh);
    const gpuOwnedDraws = c.gpuDrivenDrawReceipts?.ownedDraws.get(entry.source);
    // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
    // Each submesh carries its own topology, so pipeline selection is per-submesh.
    // Vertex/index buffers and bind groups are set once (shared across all submeshes).
    // feat-20260608 M5 amend / w16-a: the material UBO bind (group=1)
    // ALSO moves into the loop -- the j-th submesh sees the j-th
    // material slot via dynamic offset (entitySlotStart + j) * 256.
    const matsForRebind = entry.source.materials;
    for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
      const sm = entry.mesh.submeshes[smIdx];
      if (sm === undefined) continue;
      const matSlotIdx = sm.materialSlot;
      const submeshMaterial = matsForRebind[matSlotIdx] ?? entry.source.material;
      const compactDrawIndex = gpuDrivenDrawIndices?.get(smIdx);
      if (matchedMaterials !== null) {
        const materialHandles = matchedMaterials.get(entry.renderableIndex);
        const materialHandle = submeshMaterial.materialHandle ?? 0;
        if (materialHandles === undefined || !materialHandles.has(materialHandle)) continue;
      }
      if (
        (passKind === 'forward' ||
          passKind === 'deferred' ||
          (passKind === 'temporal' &&
            (entry.source.lods?.length ?? 0) > 0 &&
            entry.source.skin === undefined &&
            isStandardPbrMaterialShader(submeshMaterial.materialShaderId))) &&
        compactDrawIndex !== undefined &&
        gpuOwnedDraws?.[compactDrawIndex] === true
      ) {
        continue;
      }
      const selectedMaterialPasses = materialPasses
        .get(entry.renderableIndex)
        ?.get(submeshMaterial.materialHandle ?? 0);
      const draws =
        selectedDispatch === undefined ||
        (selectedMaterialPasses === undefined &&
          submeshMaterial.surfaceModel === 'single-layer-medium' &&
          matchedMaterials?.get(entry.renderableIndex)?.has(submeshMaterial.materialHandle ?? 0))
          ? DEFAULT_MATERIAL_DRAWS
          : (selectedMaterialPasses ?? EMPTY_MATERIAL_DRAWS);
      const drawList: readonly (DispatchEntry | undefined)[] | undefined = Array.isArray(draws)
        ? draws
        : undefined;
      const singleDraw = drawList === undefined ? (draws as DispatchEntry) : undefined;
      for (let drawIndex = 0; drawIndex < (drawList?.length ?? 1); drawIndex++) {
        const selectedPass = drawList === undefined ? singleDraw : drawList[drawIndex];
        // Temporal projects the selected material's alpha/motion contract,
        // not its authored Forward entry points or color outputs.
        const vertexEntry = passKind === 'temporal' ? undefined : selectedPass?.vertexEntry;
        let fragmentEntry =
          passKind === 'temporal' ? undefined : (fragmentEntryPoint ?? selectedPass?.fragmentEntry);
        const selectedShaderId =
          selectedPass === undefined
            ? submeshMaterial.materialShaderId
            : selectedPass.materialShaderId;
        const selectedRenderState =
          selectedPass === undefined ? submeshMaterial.renderState : selectedPass.renderState;
        // Weighted blended OIT splits one transparent set into the eligible
        // accumulation draws and the residual sorted draws. Both passes use
        // the same classifier as the frame's inspection facts.
        let oitAccumulateDraw = false;
        if (oit !== undefined) {
          const eligibility = classifyOitDraw({
            materialShaderId: selectedShaderId,
            skinned: isSkinEntry,
            renderState: selectedRenderState,
            fragmentEntry,
          });
          if (eligibility.eligible !== (oit === 'accumulate')) continue;
          if (eligibility.eligible) {
            oitAccumulateDraw = true;
            fragmentEntry = eligibility.premultiplied
              ? OIT_PREMULTIPLIED_FRAGMENT_ENTRY
              : OIT_FRAGMENT_ENTRY;
          }
        }
        const selectedStencil =
          (selectedPass === undefined ? entry.stencilReference : selectedPass.stencilReference) ??
          0;
        if (selectedStencil !== lastStencilReference) {
          pass.setStencilReference(selectedStencil);
          lastStencilReference = selectedStencil;
        }
        // feat-city-glb Bug 5 (per-submesh transparency): in the LDR split, a
        // transparent submesh is drawn in the blend sub-pass (non-sRGB view),
        // NOT here in the sRGB geometry pass. Skip it. Opaque submeshes of the
        // same (mixed) mesh still draw here. Single-material / fully-opaque
        // meshes are unaffected (their submesh materials are not transparent).
        if (
          splitLdrSprite &&
          (selectedPass === undefined
            ? submeshMaterial.transparent === true
            : selectedRenderState?.blend !== undefined)
        ) {
          continue;
        }
        // GPU ownership is per submesh. Prepare CPU buffers only after the
        // exact claim, material-pass and transparency filters leave a draw.
        if (baseInstanceDraws === undefined) {
          if (entry.mesh.vertexBuffer !== lastVertexBuffer) {
            pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
            lastVertexBuffer = entry.mesh.vertexBuffer;
          }
          // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
          // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
          // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
          if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIndexBuffer) {
            if (entry.mesh.indexBuffer !== null) {
              pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
              lastIndexBuffer = entry.mesh.indexBuffer;
            }
          }

          const foldBuffer = fold === undefined ? null : resolveFoldInstanceBuffer(c, fold, i);
          const prepared =
            fold === undefined
              ? resolveGeometryInstanceBuffer(c, entry, resolveIdentityInstanceDraws(), false)
              : foldBuffer === null
                ? null
                : [
                    {
                      instanceBuffer: foldBuffer,
                      instanceBindGroup: resolveGeometryInstancesBindGroup(
                        c,
                        foldBuffer,
                        undefined,
                      ),
                      probeOffset: -1,
                      instanceCount: fold.bucketSize,
                    },
                  ];
          if (prepared === null) continue entries;
          baseInstanceDraws = prepared;
        }
        // bug-20260610 layer 7d: per-submesh BG construction. Texture
        // views resolve from `matsForRebind[smIdx]` so the j-th submesh
        // sees its own materials[j] textures (baseColor / MR / normal /
        // emissive / occlusion). Pick slot j when materials.length covers
        // smIdx; otherwise fall back to slot 0 (count-mismatch already
        // filtered by extract; this guard handles the materials.length=1
        // single-material path mapped over multi-submesh meshes safely).
        // This BG drops entityKey: identical-texture-set submeshes
        // (whether on the same entity or different ones) share one BG via
        // the shaderId-outer `materialBgShared` cache. The 14 handle
        // objects form the WeakMap chain and fully discriminate the
        // binding state since sampler/textureView/buffer handle identities
        // are stable across frames.
        //
        // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13:
        // sprite materials now use the same per-submesh BG construction
        // (the sprite-specific BG branch above is deleted; sprite per-
        // submesh single-slot is still enforced via materialSlotIndices
        // and the sprite-shaped paramSnapshot fills the PBR-shaped BGL
        // bindings via fallback textures for the 4 unused slots).
        // feat-city-glb Bug 5: per-submesh material BG assembly extracted to
        // the shared `buildPerSubmeshMaterialBg` closure (also called by the
        // LDR blend sub-pass). Resolves the shader's user-region textures
        // (baseColor/MR/normal + a custom Nth texture), emissive/occlusion
        // injection, and Skylight merge; deduped cross-entity via the
        // shaderId-outer `materialBgShared` cache.
        const materialSlot =
          materialSlotIndices[i]?.[matSlotIdx] ?? materialSlotIndices[i]?.[0] ?? 0;
        const processValue = (
          globalThis as {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process;
        if (
          processValue?.env?.FORGEAX_MATERIAL_PIPELINE_DIAGNOSTICS === '1' &&
          (submeshMaterial.materialShaderId === 'forgeax::default-standard-pbr' ||
            submeshMaterial.materialShaderId === 'forgeax::pbr-skin')
        ) {
          console.error(
            `[render-material] draw receipt: ${JSON.stringify({
              entityIndex: entry.renderableIndex,
              materialSlot,
              materialHandle: submeshMaterial.materialHandle,
              clearcoat: submeshMaterial.paramSnapshot?.clearcoat,
              shader: submeshMaterial.materialShaderId,
            })}`,
          );
        }
        perSubmeshBg =
          profilePhase === undefined
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
        materialGroup1DynamicOffsets[0] = meshSsboBufferBinding(
          pipelineState.materialUniformBuffer,
          materialSlot * MATERIAL_PER_ENTITY_STRIDE,
        ).byteOffset;
        pass.setBindGroup(1, perSubmeshBg, materialGroup1DynamicOffsets, 0, 1);
        const smTopology = sm.topology;
        const resolvedPipeline = resolveDrawPipeline(
          entry,
          smTopology,
          submeshMaterial,
          selectedPass,
          selectedShaderId,
          selectedRenderState,
          vertexEntry,
          fragmentEntry,
          oitAccumulateDraw,
          entry.variantSet,
        );
        if (!resolvedPipeline) continue;
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
          if (diagnosticsEnabled) {
            console.error(
              `[render-material] draw skipped: ${JSON.stringify({
                entityKey: entry.source.entityKey,
                materialHandle: submeshMaterial.materialHandle,
                shader: smMaterialShaderId,
                reason: 'pipeline-unavailable',
              })}`,
            );
          }
          continue;
        }
        // Standard and authored Surface share the ProbeBlend ABI. Resolve
        // this per submesh so mixed unlit/lit meshes cannot cross layouts.
        const resolvedInstanceDraws = probeBlendAvailable
          ? resolveGeometryInstanceBuffer(c, entry, resolveIdentityInstanceDraws(), true)
          : baseInstanceDraws;
        if (resolvedInstanceDraws === null) continue;
        const compactDraw =
          compactDrawIndex === undefined
            ? undefined
            : entry.source.gpuDrivenDraws?.[compactDrawIndex];
        const sourceDrawItemIndex =
          compactDrawIndex === undefined || compactDraw === undefined
            ? smIdx
            : gpuDrivenSourceDrawItemIndex(compactDraw, compactDrawIndex);
        let instanceDraws =
          submeshMaterial.surfaceModel === 'single-layer-medium' && passKind === 'forward'
            ? resolveSurfaceDirectInstanceDraws(
                c,
                entry,
                sourceDrawItemIndex,
                resolvedInstanceDraws,
              )
            : resolvedInstanceDraws;
        if (instanceDraws === null) continue;
        if (passKind === 'deferred' && c.visibleSurface !== undefined) {
          instanceDraws = instanceDraws.map((draw) => ({
            ...draw,
            firstInstance:
              sourceDrawItemIndex * (entry.source.instances?.instanceCount ?? 1) +
              (draw.firstInstanceOrdinal ?? 0),
          }));
        }
        const materialGroup2Contract = materialPipelineEntry?.group2Contract;
        if (materialGroup2Contract === undefined) continue;
        const entryMeshGroup2 =
          materialGroup2Contract === 'cluster' &&
          pipelineState.meshStorageBuffer.pages !== undefined
            ? clusteredMeshSlotBindGroup(c, i * MESH_PER_ENTITY_STRIDE)
            : meshGroup2;
        const selectedGroup = isSkinEntry
          ? skinBindGroupFor(materialGroup2Contract)
          : selectMaterialGroup2(entryMeshGroup2, directMeshGroup, materialGroup2Contract);
        if (selectedGroup === null) continue;
        group2BindGroup = selectedGroup;
        group2DynamicOffsets = isSkinEntry
          ? pbrSkinMeshDynamicOffsets(meshBinding.byteOffset, skinSlice?.byteOffset ?? 0)
          : meshGroup2DynamicOffsets;
        if (diagnosticsEnabled && submeshMaterial.textureHandles !== undefined) {
          console.error(
            `[render-material] draw submitted: ${JSON.stringify({
              entityKey: entry.source.entityKey,
              materialHandle: submeshMaterial.materialHandle,
              shader: smMaterialShaderId,
              textureHandles: [...submeshMaterial.textureHandles.entries()].map(
                ([field, handle]) => ({
                  field,
                  handle,
                }),
              ),
              skin: isSkinEntry
                ? {
                    group2Contract: materialGroup2Contract,
                    paletteBufferReady: skinSlice?.buffer !== undefined,
                    paletteByteOffset: skinSlice?.byteOffset,
                    dynamicOffsets: [...group2DynamicOffsets],
                  }
                : undefined,
              pipelineReady: true,
            })}`,
          );
        }
        pass.setBindGroup(2, group2BindGroup, group2DynamicOffsets);
        const physicalRange = entry.mesh.lodRanges?.[0]?.[smIdx];
        const indexCount = physicalRange?.count ?? sm.indexCount;
        const indexOffset = physicalRange?.first ?? sm.indexOffset;
        const baseVertex = physicalRange?.baseVertex ?? 0;

        if (profilePhase === undefined) {
          recordOcclusionCandidate(() =>
            submitSubmeshDraws(
              pass,
              bindingState,
              smPipelineHandle,
              instanceDraws,
              entry.mesh.indexed,
              indexCount,
              sm.vertexCount,
              indexOffset,
              baseVertex,
              (draw, command) => {
                recordPresented(
                  entry,
                  smIdx,
                  {
                    lane: 'cpu',
                    ready: true,
                    pipeline: smPipelineHandle,
                    materialSlot: matSlotIdx,
                    ...(selectedPass === undefined ? {} : { passIndex: selectedPass.passIndex }),
                    unsupportedLineage:
                      passKind !== 'forward' ||
                      fold !== undefined ||
                      entry.source.instances !== undefined ||
                      entry.source.skin !== undefined ||
                      draw.instanceCount !== 1,
                    ...(smMaterialShaderId === undefined ? {} : { programKey: smMaterialShaderId }),
                  },
                  fold,
                );
                if (surfacePass === undefined || draw.surfaceFrameBase === undefined) return;
                c.frameState.surfaceSubmissionObservation?.record(surfacePass, {
                  kind: command,
                  count: entry.mesh.indexed ? indexCount : sm.vertexCount,
                  first: entry.mesh.indexed ? indexOffset : 0,
                  instanceCount: draw.instanceCount,
                  firstInstance: 0,
                  surfaceFrameBase: draw.surfaceFrameBase,
                  memberIds: draw.surfaceMemberIds ?? [],
                  pipelineIdentity: getOpaqueResourceIdentity(smPipelineHandle as object),
                  ...(materialPipelineEntry?.receipt === undefined
                    ? {}
                    : {
                        receiptIdentity: materialPipelineEntry.receipt.identity,
                        receiptGeneration: materialPipelineEntry.receipt.generation,
                      }),
                });
              },
            ),
          );
        } else {
          profileGeometrySegment(c, passKind, 'draw-submit', () =>
            recordOcclusionCandidate(() =>
              submitSubmeshDraws(
                pass,
                bindingState,
                smPipelineHandle,
                instanceDraws,
                entry.mesh.indexed,
                indexCount,
                sm.vertexCount,
                indexOffset,
                baseVertex,
                (draw, command) => {
                  recordPresented(
                    entry,
                    smIdx,
                    {
                      lane: 'cpu',
                      ready: true,
                      pipeline: smPipelineHandle,
                      materialSlot: matSlotIdx,
                      ...(selectedPass === undefined ? {} : { passIndex: selectedPass.passIndex }),
                      unsupportedLineage:
                        passKind !== 'forward' ||
                        fold !== undefined ||
                        entry.source.instances !== undefined ||
                        entry.source.skin !== undefined ||
                        draw.instanceCount !== 1,
                      ...(smMaterialShaderId === undefined
                        ? {}
                        : { programKey: smMaterialShaderId }),
                    },
                    fold,
                  );
                  if (surfacePass === undefined || draw.surfaceFrameBase === undefined) return;
                  c.frameState.surfaceSubmissionObservation?.record(surfacePass, {
                    kind: command,
                    count: entry.mesh.indexed ? indexCount : sm.vertexCount,
                    first: entry.mesh.indexed ? indexOffset : 0,
                    instanceCount: draw.instanceCount,
                    firstInstance: 0,
                    surfaceFrameBase: draw.surfaceFrameBase,
                    memberIds: draw.surfaceMemberIds ?? [],
                    pipelineIdentity: getOpaqueResourceIdentity(smPipelineHandle as object),
                    ...(materialPipelineEntry?.receipt === undefined
                      ? {}
                      : {
                          receiptIdentity: materialPipelineEntry.receipt.identity,
                          receiptGeneration: materialPipelineEntry.receipt.generation,
                        }),
                  });
                },
              ),
            ),
          );
        }
        if (diagnosticsEnabled && perSubmeshBg !== null) {
          recordIblPipelineBinding(c, submeshMaterial, smPipelineHandle, perSubmeshBg);
        }
      }
    }
  }
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
      ? packInstanceStorageBuffer(source, previousSource, currentGenerations, previousGenerations)
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

export function reportInstanceResidency(
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
    residentGeneration: c.runtime.deviceScope.generation,
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
    chunks = new Map<number, InstanceBufferCacheEntry>();
    owners.set(ownerKey, chunks);
  }
  return chunks;
}

function clearInstanceChunksForOwner(c: InstanceBufferContext, ownerKey: number): void {
  const owners = c.frameState.instanceBufferChunks;
  const chunks = owners?.get(ownerKey);
  if (chunks === undefined) return;
  for (const [start, entry] of chunks) {
    if (!entry.buffer.isDestroyed) {
      const destroyed = entry.buffer.destroy();
      if (!destroyed.ok) c.runtime.errorRegistry.fire(destroyed.error);
    }
    chunks.delete(start);
  }
  owners?.delete(ownerKey);
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
  if (chunks !== undefined) {
    for (const [key, stale] of chunks.entries()) {
      if (activeKeys.has(key)) continue;
      if (!stale.buffer.isDestroyed) {
        const destroyed = stale.buffer.destroy();
        if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
      }
      chunks.delete(key);
    }
  }
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
  const { runtime, pipelineState, frameState } = c;
  const inst = entry.source.instances;
  if (entry.source.spriteInstances !== undefined) {
    const { buffer, count } = resolveSpriteInstancesBuffer(
      c,
      entry,
      pipelineState.identityInstanceBuffer,
      0,
    );
    return count === 0
      ? []
      : [
          {
            instanceBuffer: buffer,
            instanceBindGroup: resolveGeometryInstancesBindGroup(c, buffer, undefined),
            probeOffset: -1,
            instanceCount: count,
          },
        ];
  }
  const probeBinding =
    !useProbeBlend || !runtime.device.caps.storageBuffer
      ? undefined
      : entry.source.probeBlendRecord === undefined
        ? { buffer: ensureProbeBlendRecordBuffer(runtime.device, frameState, undefined), offset: 0 }
        : resolveProbeBlendBuffer(
            c,
            entry.source.probeBlendRecord,
            worldEntityKey(entry.source.worldId, entry.source.entityKey),
          );
  if (inst === undefined) {
    const identity = identityInstanceDraws[0];
    if (identity === undefined) return null;
    return [
      {
        ...identity,
        instanceBindGroup: resolveGeometryInstancesBindGroup(
          c,
          pipelineState.identityInstanceBuffer,
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
  const entityCacheKey = instanceCollectionCacheKey(entry.source.worldId, inst);
  const revision = inst.revision;
  const sameRevision = (cached: InstanceBufferCacheEntry): boolean =>
    revision === undefined
      ? cached.uploadedRevision === undefined
      : cached.uploadedRevision === revision;
  const fullRange = [{ start: 0, end: inst.instanceCount }] as const;
  let instanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
  let instanceCount = 1;
  {
    // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w13:
    // caps.storageBuffer===false -> uniform fallback with 128-instance
    // cap (128 * 64B = 8192B < WebGL2 min 16384B UBO limit).
    // caps.storageBuffer===true -> existing storage buffer path unchanged.
    const uniformFallback = runtime.device.caps.storageBuffer === false;
    let instanceBufferUsage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;

    if (uniformFallback && inst.instanceCount > MAX_UNIFORM_INSTANCES) {
      const ownerKey = instanceCollectionCacheKey(entry.source.worldId, inst);
      const chunks = instanceChunksForOwner(c, ownerKey);
      const activeKeys = new Set<number>();
      const draws: GeometryInstanceDraw[] = [];
      const uniformStrideBytes = 16 * Float32Array.BYTES_PER_ELEMENT;
      const uploadedRanges: { start: number; end: number }[] = [];
      let uploadedBytes = 0;
      for (let start = 0; start < inst.instanceCount; start += MAX_UNIFORM_INSTANCES) {
        const count = Math.min(MAX_UNIFORM_INSTANCES, inst.instanceCount - start);
        activeKeys.add(start);
        const payloadBytes = count * uniformStrideBytes;
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
              inst.instanceCount * uniformStrideBytes,
              MAX_UNIFORM_INSTANCES * uniformStrideBytes,
            );
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
        const needsUpload = activeIsNew || !sameRevision(active);
        const plan = planInstanceUpload({
          activeIsNew,
          resident: active,
          current: inst,
          pairing: 'no-previous-lane',
          window: { start, end: start + count },
        });
        if (needsUpload && plan.ranges.length > 0) {
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
            uploadedRanges.push({ start: range.start + start, end: range.end + start });
          }
          uploadedBytes += upload.bytes;
          if (!upload.ok) {
            reportInstanceFailure(
              c,
              inst,
              {
                code: 'queue-write-buffer-failed',
                expected: 'the renderer-owned instance uniform buffer accepts the dirty range',
                hint: 'retry after the active device is healthy or recover the renderer',
              },
              inst.instanceCount * uniformStrideBytes,
              MAX_UNIFORM_INSTANCES * uniformStrideBytes,
            );
            return null;
          }
        }
        if (needsUpload) {
          const published =
            revision === undefined
              ? active
              : withUploadedRevision(active, revision, plan.motionRows);
          active = published;
          chunks?.set(start, published);
        }
        draws.push({
          instanceBuffer: active.buffer.handle,
          instanceBindGroup: resolveGeometryInstancesBindGroup(
            c,
            active.buffer.handle,
            probeBinding?.buffer,
          ),
          ...(probeBinding?.buffer === undefined ? {} : { probeBuffer: probeBinding.buffer }),
          probeOffset: probeBinding?.offset ?? -1,
          instanceCount: count,
          firstInstanceOrdinal: start,
        });
      }
      if (chunks !== undefined) {
        for (const [key, stale] of chunks.entries()) {
          if (activeKeys.has(key)) continue;
          if (!stale.buffer.isDestroyed) {
            const destroyed = stale.buffer.destroy();
            if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
          }
          chunks.delete(key);
        }
      }
      reportInstanceResidency(c, inst, {
        lane: 'chunked-uniform',
        requestedBytes: inst.instanceCount * uniformStrideBytes,
        supportedBytes: MAX_UNIFORM_INSTANCES * uniformStrideBytes,
        uploadRanges: uploadedRanges,
        uploadedBytes,
      });
      return draws;
    }
    if (uniformFallback) {
      instanceBufferUsage = GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
    }

    {
      // Cap-gate (LimitExceededDetail single emit point — feat-20260514
      // M3 / w15 anchor): `requestedBytes <= maxStorageBufferBindingSize`.
      // Derive the size from the authoring count; storage packing is deferred
      // until uploadInstanceRanges confirms a new or dirty resident.
      const requestedBytes =
        inst.instanceCount *
        (uniformFallback ? 16 : INSTANCE_STORAGE_STRIDE_FLOATS) *
        Float32Array.BYTES_PER_ELEMENT;
      const cap = runtime.device.limits.maxStorageBufferBindingSize;
      if (!uniformFallback && typeof cap === 'number' && cap > 0 && requestedBytes > cap) {
        const chunked = resolveStorageInstanceChunks(
          c,
          entry,
          inst,
          cap,
          probeBinding?.buffer,
          probeBinding?.offset ?? -1,
        );
        return chunked;
      } else {
        // Look up the cached GPU buffer or create a fresh one when the
        // archetype version bumped or the byte length changed.
        // entityCacheKey is the worldEntityKey + collectionId namespace.
        const cached = frameState.instanceBuffers.get(entityCacheKey);
        let active: InstanceBufferCacheEntry | null = null;
        let activeIsNew = false;
        if (
          cached !== undefined &&
          cached.uploadedArchVersion === inst.archVersion &&
          cached.uploadedByteLength === requestedBytes
        ) {
          active = cached;
        } else if (requestedBytes > 0) {
          const bufRes = runtime.device.createBuffer({
            size: uniformFallback ? INSTANCE_UBO_FULL_ARRAY_BYTES : requestedBytes,
            usage: instanceBufferUsage,
            mappedAtCreation: false,
          });
          if (!bufRes.ok) {
            runtime.errorRegistry.fire(bufRes.error);
            reportInstanceFailure(c, inst, bufRes.error, requestedBytes, cap);
            return null;
          } else {
            // feat-20260619 M4 / F12: destroy the old cached buffer
            // before replacing it with the new one (D-6).
            if (cached !== undefined && !cached.buffer.isDestroyed) {
              const r = cached.buffer.destroy();
              if (!r.ok) runtime.errorRegistry.fire(r.error);
            }
            const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
            active = {
              buffer: newBuffer,
              uploadedArchVersion: inst.archVersion,
              uploadedByteLength: requestedBytes,
            };
            activeIsNew = true;
            if (active !== null) {
              // Keep the collection identity in the worldEntityKey namespace.
              frameState.instanceBuffers.set(entityCacheKey, active);
            }
          }
        }
        if (active !== null) {
          const previousInstances = entry.source.temporal?.previousInstances;
          const pairing = uniformFallback
            ? 'no-previous-lane'
            : instancePreviousPairing(inst, previousInstances);
          const needsUpload =
            activeIsNew ||
            !sameRevision(active) ||
            (pairing === 'none' && active.uploadedMotionRows?.length !== 0);
          const plan = planInstanceUpload({
            activeIsNew,
            resident: active,
            current: inst,
            pairing,
            window: fullRange[0],
          });
          const ranges = plan.ranges;
          let uploadRanges: readonly { readonly start: number; readonly end: number }[] = [];
          let uploadedBytes = 0;
          if (needsUpload && ranges.length > 0) {
            const upload = uploadInstanceRanges(
              c,
              inst,
              active.buffer.handle,
              ranges,
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
                uniformFallback
                  ? MAX_UNIFORM_INSTANCES * Float32Array.BYTES_PER_ELEMENT * 16
                  : typeof cap === 'number'
                    ? cap
                    : undefined,
              );
              return null;
            }
          }
          if (needsUpload) {
            const published = withUploadedRevision(active, revision, plan.motionRows);
            frameState.instanceBuffers.set(entityCacheKey, published);
            active = published;
          }
          instanceBuffer = active.buffer.handle;
          instanceCount = Math.max(1, inst.instanceCount);
          reportInstanceResidency(c, inst, {
            lane: uniformFallback ? 'direct-uniform' : 'direct-storage',
            requestedBytes,
            supportedBytes: uniformFallback
              ? MAX_UNIFORM_INSTANCES * Float32Array.BYTES_PER_ELEMENT * 16
              : typeof cap === 'number'
                ? cap
                : undefined,
            uploadRanges,
            uploadedBytes,
          });
          clearInstanceChunksForOwner(c, entityCacheKey);
        }
      }
      // The cache write above is keyed by worldEntityKey(worldId, cacheKey)
      // so separate worlds cannot alias their instance buffers.
    }
  }
  return [
    {
      instanceBuffer,
      instanceBindGroup: resolveGeometryInstancesBindGroup(c, instanceBuffer, probeBinding?.buffer),
      ...(probeBinding?.buffer === undefined ? {} : { probeBuffer: probeBinding.buffer }),
      probeOffset: probeBinding?.offset ?? -1,
      instanceCount,
    },
  ];
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
