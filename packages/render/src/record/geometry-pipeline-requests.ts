import {
  deriveVertexLayoutProjectionFromMask,
  type VertexLayoutProjection,
  vertexLayoutHasColor,
} from '@forgeax/engine-geometry';
import { withSupportedLeanInputs } from '@forgeax/engine-shader';
import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from '../assembly/device-feature-admission';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import type { MaterialShaderArtifactRequest } from '../assembly/material/assembly';
import {
  MaterialPipelineRequestCache,
  type MaterialPipelineRequestFacts,
} from '../assembly/material/pipeline-request-cache';
import { isDepthVelocityEntry } from '../gpu-driven/raster-selection';
import {
  classifyOitDraw,
  OIT_FRAGMENT_ENTRY,
  OIT_PREMULTIPLIED_FRAGMENT_ENTRY,
} from '../oit/eligibility';
import {
  POINTS_LINES_MATERIAL_SHADER_ID,
  POINTS_LINES_VERTEX_LAYOUT,
  pointsLinesFragmentEntry,
} from '../points-lines/record';
import type { PointsLinesStyle } from '../points-lines/snapshot';
import { PREDEPTH_FRAGMENT_ENTRY, predepthCoversMaterial } from '../predepth-coverage';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { MaterialFrame } from '../scene/material-dispatch';
import { recordingDrawPose, recordingDrawReflected } from './draw-row-pages';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';
import { detectNineSliceScaleTooSmall } from './main-pass-material';
import { selectStandardForwardScreenEntry } from './standard-opaque-entry';

// Shared exact geometry PSO request producer.

import { type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  type MaterialRenderState,
  type MaterialSurfacePassKind,
  ok,
  type PassKind,
  type PrimitiveTopology,
  type Result,
  SINGLE_LAYER_WATER_PASS_OUTPUTS,
} from '@forgeax/engine-types';
import { materialPipelineArtifactRequest } from '../assembly/material/pipeline-helpers';
import {
  MaterialSampledTextureBudgetExceededError,
  RendererContractFailureError,
  type VertexColorVariantConflictError,
} from '../errors/render';
import { maskedInEarlyPassVariantSet, materialAlphaMask } from '../material-alpha-mask';
import {
  clippingCapRenderState,
  derivedRenderState,
  reflectedRenderState,
  seededDepthRenderState,
} from '../material-render-state';
import {
  colorlessFormat,
  colorlessFragmentEntry,
  effectiveStandardShadowReception,
  effectiveStandardSurfaceDiscards,
  materialAbiRasterConstants,
  standardSurfaceDiscardMask,
} from '../material-stage-constants';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import { oitAccumulateRenderState } from '../oit/eligibility';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  SKIN_MATERIAL_SHADER_ID,
  SKIN_UNCOVERED_GBUFFER_ENTRY,
} from '../pbr-pipeline';
import {
  pipelineStripIndexFormat,
  renderStateHash,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';

import type { RenderRecordPhase } from '../render-contract';
import type { DispatchEntry, MaterialSnapshot } from '../render-system-extract';
import { admitsInlineSsr, withInlineSsrVariant } from '../ssr/admission';
import { geometryRenderStateForTopology, selectGeometryPipeline } from './main-pass-material';
import type {
  _InternalRenderPipelineContext,
  MaterialShaderPipelineEntry,
  RecordProfileRunner,
  RenderSystemInternals,
} from './render-context';
import { selectForwardFragmentEntry } from './standard-opaque-entry';
import { materialFogViewOffset, translucentFogComposition } from './view-ubo';

/** Compute-produced vertices keep the source mesh's interleaved ABI. */
export function drawVertexLayout(entry: ValidatedRenderable) {
  const layout = entry.mesh.layoutProjection;
  return entry.source.gpuVertexSource === undefined || layout.streams === undefined
    ? layout
    : deriveVertexLayoutProjectionFromMask(layout.mask).unwrap();
}

/** Resolve the material artifact key from the draw's declared shader family. */
function geometryMaterialVariantSet(
  shaderId: string | undefined,
  isSpriteShader: boolean,
  clusteredLighting: boolean,
  storageBuffer: boolean,
  perInstance: boolean,
  capabilities: string,
  authored: string | undefined,
): string | undefined {
  return isSpriteShader
    ? shaderId === 'forgeax::sprite-lit' || (!storageBuffer && clusteredLighting)
      ? `${capabilities}+PER_INSTANCE_REGION=${perInstance}`
      : perInstance
        ? ''
        : undefined
    : authored === undefined
      ? capabilities
      : `${capabilities}+${authored}`;
}

type DirectSurfaceLayoutKind =
  | 'surface-direct-pbr'
  | 'surface-direct-cluster-pbr'
  | 'scene-direct-unlit'
  | 'scene-direct-cluster-unlit';

/** Direct medium color and motion programs share the same frame address ABI. */
function directMediumLayoutKind(
  surfaceModel: MaterialSnapshot['surfaceModel'],
  passKind: PassKind,
  clusteredLighting: boolean,
): DirectSurfaceLayoutKind | undefined {
  return surfaceModel === 'single-layer-medium' &&
    (passKind === 'forward' || passKind === 'temporal')
    ? clusteredLighting
      ? 'surface-direct-cluster-pbr'
      : 'surface-direct-pbr'
    : undefined;
}

type GeometryRenderState = ReturnType<typeof geometryRenderStateForTopology>;

/** Device and draw facts have a closed domain. Only authored axes extend these keys. */
const DRAW_CAPABILITY_VARIANTS = Array.from({ length: 3 * 32 }, (_, key) => {
  const base = standardTopologyVariantSet(
    (key & 8) !== 0 ? { kind: 'clustered' } : undefined,
    (key & 4) !== 0,
    (key & 1) !== 0,
    (key & 2) !== 0,
  );
  const withTransmission = (key & 16) !== 0 ? `${base}+TRANSMISSION_AVAILABLE=true` : base;
  const alpha = key >> 5;
  return alpha === 0 ? withTransmission : `${withTransmission}+ALPHA_MASK=${alpha === 2}`;
});

function drawCapabilityVariant(
  clustered: boolean,
  storage: boolean,
  vertexColor: boolean,
  probeBlend: boolean,
  transmission: boolean,
  canonical: boolean,
  alphaMask: boolean,
): string {
  const key =
    Number(vertexColor) |
    (Number(probeBlend) << 1) |
    (Number(storage) << 2) |
    (Number(clustered) << 3) |
    (Number(transmission) << 4) |
    ((canonical ? (alphaMask ? 2 : 1) : 0) << 5);
  return DRAW_CAPABILITY_VARIANTS[key] as string;
}

const UNLIT_DRAW_VARIANTS = Array.from({ length: 32 }, (_, key) => {
  const color = (key & 1) !== 0;
  const storage = (key & 2) !== 0;
  const textureCluster = (key & 4) !== 0;
  const direct = (key & 8) !== 0;
  const base = textureCluster
    ? standardTopologyVariantSet({ kind: 'clustered' }, false, color)
    : direct
      ? `STORAGE_BUFFER_AVAILABLE=${storage}+VERTEX_COLOR_AVAILABLE=${color}`
      : standardStorageVariantSet(storage, color);
  return `${base}${direct ? '+GPU_SCENE_DIRECT=true' : ''}+ALPHA_MASK=${(key & 16) !== 0}`;
});

/** The unadorned lookup options are immutable and shared across Pass recordings. */
const DRAW_ARTIFACT_REQUESTS: readonly MaterialShaderArtifactRequest[] = Array.from(
  { length: 32 },
  (_, key) =>
    Object.freeze({
      deformation: (key & 8) !== 0 ? 'skin' : 'rigid',
      address: 'direct',
      surfaceDiscards: standardSurfaceDiscardMask(false, (key & 16) !== 0),
      clustered: (key & 4) !== 0,
      alphaMask: (key & 2) !== 0,
      vertexColorAvailable: (key & 1) !== 0,
    } satisfies MaterialShaderArtifactRequest),
);

/** Select binary coverage for a temporal-family raster request. */
export function variantSetForCoveragePass(
  variantSet: string | undefined,
  coverageOnly: boolean,
): string | undefined {
  if (!coverageOnly) return variantSet;
  // Coverage has its own alpha and hash gates, independent of the color axis.
  if (variantSet?.includes('ALPHA_MASK=true')) {
    variantSet = variantSet.replace('ALPHA_MASK=true', 'ALPHA_MASK=false');
  }
  if (variantSet?.includes('COVERAGE_ONLY=true')) return variantSet;
  // A published definesKey spells every axis (sorted), including the color
  // producer's COVERAGE_ONLY=false; flip it in place to keep the key canonical.
  // Coverage programs keep the general vertex inputs (permutation rules).
  if (variantSet?.includes('COVERAGE_ONLY=false')) {
    return withSupportedLeanInputs(variantSet.replace('COVERAGE_ONLY=false', 'COVERAGE_ONLY=true'));
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
  surfacePass?: MaterialSurfacePassKind,
  fragmentEntry?: string,
  opaqueDepthPrimed = false,
): GeometryRenderState {
  if (passKind !== 'temporal' && surfacePass !== 'velocity') {
    if (!opaqueDepthPrimed) return base;
    const compare = base?.depthCompare ?? 'less';
    if (compare !== 'less' && compare !== 'greater') return base;
    return derivedRenderState(base, 'opaque-depth-primed', (state) => ({
      ...state,
      depthCompare: compare === 'less' ? 'less-equal' : 'greater-equal',
    }));
  }
  if (
    passKind === 'temporal' &&
    fragmentEntry === 'fs_temporal_depth' &&
    base?.alphaToCoverageEnabled === true
  )
    return derivedRenderState(base, 'temporal', temporalState);
  if (passKind === 'temporal' && isDepthVelocityEntry(fragmentEntry))
    return derivedRenderState(base, 'temporal-depth-prepass', temporalDepthPrepassState);
  return derivedRenderState(
    base,
    coverageOnly ? 'temporal-coverage' : 'temporal',
    coverageOnly ? temporalCoverageState : temporalState,
  );
}

function selectForwardSsrVariant(
  variant: string | undefined,
  enabled: boolean,
  passKind: PassKind,
  colorCount: number,
  coverage: boolean,
  shader: string,
): string | undefined {
  return enabled &&
    passKind === 'forward' &&
    colorCount > 0 &&
    !coverage &&
    (isStandardPbrMaterialShader(shader) || shader.startsWith('forgeax::standard-terrain'))
    ? withInlineSsrVariant(variant)
    : variant;
}

/**
 * Receiver shape and modifier-free lighting are independent per-frame facts:
 * forward Standard colour draws select each source-level axis. Masked and
 * visible-surface variants keep the general receiver, matching the rows the
 * publication keeps.
 */
function withFrameLightingVariant(
  variantSet: string | undefined,
  frameAxes: string | undefined,
  materialShaderId: string,
): string | undefined {
  if (
    frameAxes === undefined ||
    materialShaderId !== 'forgeax::default-standard-pbr' ||
    (variantSet ?? '').includes('ALPHA_MASK=true') ||
    (variantSet ?? '').includes('VISIBLE_SURFACE_AVAILABLE=true')
  )
    return variantSet;
  return variantSet ? `${variantSet}+${frameAxes}` : frameAxes;
}

function temporalPassState(base: GeometryRenderState, coverageOnly: boolean): GeometryRenderState {
  const state = { ...base };
  delete state.outputs;
  return {
    ...state,
    colorWriteMask: 15,
    depthWriteEnabled: coverageOnly,
    depthCompare: 'less-equal' as const,
  };
}
const opaqueDepthState = (state: GeometryRenderState): GeometryRenderState => ({
  ...state,
  colorWriteMask: 0,
});
const temporalState = (base: GeometryRenderState) => temporalPassState(base, false);
const temporalCoverageState = (base: GeometryRenderState) => temporalPassState(base, true);
const temporalDepthPrepassState = (base: GeometryRenderState): GeometryRenderState => ({
  ...temporalPassState(base, false),
  depthWriteEnabled: base?.depthWriteEnabled ?? true,
  depthCompare: base?.depthCompare ?? 'less',
});
const spriteState = (state: GeometryRenderState): GeometryRenderState => ({
  ...state,
  depthWriteEnabled: false,
  depthCompare: 'less-equal' as const,
  cullMode: 'none' as const,
  blend: state?.blend ?? SPRITE_PREMULTIPLIED_ALPHA_BLEND,
});
const transparentDepthState = (depthWriteEnabled: boolean) => (state: GeometryRenderState) => ({
  ...state,
  depthWriteEnabled,
  depthCompare: 'less-equal' as const,
});
const transparentDepthWriteState = transparentDepthState(true);
const transparentDepthReadState = transparentDepthState(false);

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

/** Only actual PSO dependencies; no encoder, frame plans, Surface storage or lighting buffers. */
export type PipelineRequestRuntime = Pick<
  RenderSystemInternals,
  | 'device'
  | 'shaderRegistry'
  | 'errorRegistry'
  | 'metrics'
  | 'getMaterialArtifact'
  | 'getMaterialShaderArtifact'
  | 'getMaterialShaderPipeline'
  | 'getMaterialShaderPipelineEntry'
  | 'prepareMaterialShaderPipeline'
  | 'prepareMaterialShaderPipelineEntry'
>;

/** The selected pass's shader, else the material's (skinned draws keep a Standard skin program). */
function drawMaterialShaderId(
  entry: ValidatedRenderable,
  passSelected: boolean,
  selectedShaderId: string | undefined,
  material: MaterialSnapshot,
): string | undefined {
  if (passSelected) return selectedShaderId;
  if (entry.source.skinBinding === undefined) return material.materialShaderId;
  return isStandardPbrSkinMaterialShader(material.materialShaderId)
    ? material.materialShaderId
    : SKIN_MATERIAL_SHADER_ID;
}

/** A forward pass without color attachments is the depth-only scene prepass. */
function isColorlessForwardPass(passKind: PassKind, colorFormats: readonly unknown[]): boolean {
  return passKind === 'forward' && colorFormats.length === 0;
}

function viewSurfaceDiscards(
  artifact: MaterialShaderArtifact | undefined,
  clipping: { readonly planes: readonly unknown[] } | undefined,
): number | undefined {
  return effectiveStandardSurfaceDiscards(
    artifact,
    standardSurfaceDiscardMask(false, (clipping?.planes.length ?? 0) > 0),
  );
}

function prepassFragmentEntry(
  colorless: boolean,
  variantSet: string | undefined,
  artifact: MaterialShaderArtifact | undefined,
  surfaceDiscards: number | undefined,
  fragmentEntry: string | undefined,
  alphaToCoverageEnabled: boolean,
): string | null | undefined {
  return colorlessFragmentEntry(
    colorless,
    variantSet,
    artifact?.receipt,
    surfaceDiscards,
    fragmentEntry,
    artifact?.program,
    alphaToCoverageEnabled,
  );
}

/** All PipelineState members consumed by the pure geometry request producer. */
export type GeometryPipelineRequestState = Pick<
  _InternalRenderPipelineContext['pipelineState'],
  | 'unlitPipeline'
  | 'unlitPipelineHdr'
  | 'unlitPipelineMsaa'
  | 'unlitPipelineHdrMsaa'
  | 'standardPbrShaderUvSetCount'
  | 'gpuDrivenInstancesBindGroupLayout'
>;

export interface GeometryPipelineRequestContext {
  readonly runtime: PipelineRequestRuntime;
  readonly pipelineState: GeometryPipelineRequestState;
  readonly lightingKind: 'no-local-lights' | 'clustered' | undefined;
  readonly clipping: _InternalRenderPipelineContext['camera']['clipping'];
  readonly visibleSurface: boolean;
  readonly capturedAtmosphere: boolean;
  readonly reflectionFallbackColorFormat: GPUTextureFormat | undefined;
  readonly translucentFog: boolean;
  readonly viewFog?: boolean | undefined;
  readonly vertexHeightFog?: boolean | undefined;
  readonly viewShadows?: boolean | undefined;
  readonly splitLdrSprite: boolean;
  readonly transparentColorFormat: GPUTextureFormat | undefined;
  readonly warnedNineSliceScaleEntities: Set<number>;
  /** The frame's directional shadow qualifies for the one-cascade Vogel receiver. */
  readonly directionalShadowSimple?: boolean;
  readonly leanLighting?: boolean;
  readonly forwardInlineSsr?: boolean;
  readonly waterInfoFormat?: 'rgba16float' | 'rgba32float';
}
/** Normal recording projects its own facts into the same narrow producer input. */
export function geometryPipelineRequestContext(
  c: Pick<
    _InternalRenderPipelineContext,
    | 'runtime'
    | 'pipelineState'
    | 'standardLighting'
    | 'camera'
    | 'visibleSurface'
    | 'capturedAtmosphere'
    | 'reflectionFallbackColorFormat'
    | 'translucentFog'
    | 'viewFog'
    | 'vertexHeightFog'
    | 'viewShadows'
    | 'splitLdrSprite'
    | 'transparentColorFormat'
    | 'frameState'
    | 'directionalShadowSimple'
    | 'leanLighting'
    | 'waterInfoFormat'
  >,
): GeometryPipelineRequestContext {
  const ssr = c.frameState.ssrSpatialAdmission;
  return {
    runtime: c.runtime,
    pipelineState: c.pipelineState,
    lightingKind: c.standardLighting?.kind,
    clipping: c.camera.clipping,
    visibleSurface: c.visibleSurface !== undefined,
    capturedAtmosphere: c.capturedAtmosphere !== undefined,
    reflectionFallbackColorFormat: c.reflectionFallbackColorFormat,
    translucentFog: c.translucentFog === true,
    viewFog: c.viewFog,
    vertexHeightFog: c.vertexHeightFog,
    viewShadows: c.viewShadows,
    splitLdrSprite: c.splitLdrSprite,
    transparentColorFormat: c.transparentColorFormat,
    warnedNineSliceScaleEntities: c.frameState.warnedNineSliceScaleEntities,
    directionalShadowSimple: c.directionalShadowSimple === true,
    leanLighting: c.leanLighting === true,
    forwardInlineSsr:
      ssr?.status === 'admitted' &&
      admitsInlineSsr(c.runtime.device, c.pipelineState.extendedLightingAvailable, ssr),
    ...(c.waterInfoFormat === undefined ? {} : { waterInfoFormat: c.waterInfoFormat }),
  };
}
export interface GeometryPipelineRequestOptions {
  readonly passKind: PassKind;
  readonly sampleCount: number;
  readonly colorFormats: readonly GPUTextureFormat[];
  readonly coverageOnly: boolean;
  readonly tonemapActive: boolean;
  readonly msaaActive: boolean;
  readonly viewBindGroupDynamicOffset: number;
  readonly transparentDepthWrite: boolean;
  /** Forward opaque over the exact prepass depth (see seededDepthRenderState). */
  readonly seededDepth?: boolean;
  readonly depthPrepass?: boolean;
  readonly opaqueDepthPrimed?: boolean;
  readonly surfacePass?: MaterialSurfacePassKind;
  readonly oit: 'accumulate' | 'residual' | undefined;
}

/** A canonical Standard draw over the exact prepass depth: masked ones test `equal`. */
function seededGeometryRenderState(
  seeded: boolean,
  state: MaterialRenderState | undefined,
  shaderId: string | undefined,
  alphaMask: boolean,
): MaterialRenderState | undefined {
  if (!seeded) return state;
  const masked = isCanonicalStandardPbrMaterialShader(shaderId) && alphaMask;
  return seededDepthRenderState(state, masked);
}

/** The opaque program a seeded draw selects (maskedInEarlyPassVariantSet); unseeded keeps its own. */
function seededDrawVariantSet(
  seededDepth: boolean,
  transparent: boolean | undefined,
  oitAccumulateDraw: boolean,
  variantSet: string | undefined,
  unseeded: MaterialRenderState | undefined,
  seeded: MaterialRenderState | undefined,
  fragmentEntry: string | undefined,
): string | undefined {
  const seededOpaque = seededDepth && transparent !== true && !oitAccumulateDraw;
  return seededOpaque
    ? maskedInEarlyPassVariantSet(variantSet, unseeded, seeded, fragmentEntry)
    : variantSet;
}

/** One exact request producer for normal recording and explicit candidate demand. */
export function createGeometryPipelineRequests(
  c: GeometryPipelineRequestContext,
  options: GeometryPipelineRequestOptions,
  profile?: RecordProfileRunner,
  profilePhase?: RenderRecordPhase,
  workspace?: {
    readonly materialPipelines: MaterialPipelineRequestCache<MaterialShaderPipelineEntry>;
    readonly materialFacts: MaterialPipelineRequestFacts;
  },
) {
  const { runtime, pipelineState } = c;
  const {
    passKind,
    sampleCount,
    colorFormats,
    coverageOnly,
    tonemapActive,
    msaaActive,
    viewBindGroupDynamicOffset,
    transparentDepthWrite,
    seededDepth = false,
    depthPrepass = false,
    opaqueDepthPrimed = false,
    surfacePass,
    oit,
  } = options;
  const colorFormatOverride = c.transparentColorFormat as GPUTextureFormat | undefined;
  const clusteredLighting = c.lightingKind === 'clustered';
  const isHdrTarget = isHdrGeometryTarget(tonemapActive, colorFormatOverride);
  const frameLightingAxes =
    passKind !== 'deferred' &&
    !coverageOnly &&
    (c.directionalShadowSimple === true || c.leanLighting === true)
      ? `DIRECTIONAL_SHADOW_SIMPLE=${c.directionalShadowSimple === true}+LEAN_LIGHTING=${c.leanLighting === true}`
      : undefined;
  const withCoverageVariant = (variantSet: string | undefined) =>
    variantSetForCoveragePass(variantSet, coverageOnly && surfacePass !== 'velocity');
  const viewOffsetForBlend = (blend: GPUBlendState | undefined, fog?: boolean): number => {
    const composition =
      c.translucentFog === true && fog !== false ? translucentFogComposition(blend) : undefined;
    const dataOnly =
      coverageOnly ||
      surfacePass === 'depth' ||
      surfacePass === 'visibility' ||
      surfacePass === 'coverage' ||
      surfacePass === 'depth-velocity' ||
      surfacePass === 'shadow' ||
      surfacePass === 'velocity' ||
      surfacePass === 'nearest-layer';
    return materialFogViewOffset(
      viewBindGroupDynamicOffset,
      c.vertexHeightFog === true,
      dataOnly ? false : fog,
      composition,
    );
  };
  // The pass owns one selection per distinct physical request and issuing factory.
  const materialPipelines =
    workspace?.materialPipelines ??
    new MaterialPipelineRequestCache<MaterialShaderPipelineEntry>(Infinity);
  const lookupFacts = workspace?.materialFacts ?? [];
  // The pass owns one ordered additional-target sequence for all of its draws.
  let additionalColorFormats: readonly GPUTextureFormat[] | undefined;
  const colorless = isColorlessForwardPass(passKind, colorFormats);
  function submitMaterialPipeline(
    factory: PipelineRequestRuntime['getMaterialShaderPipelineEntry'],
    materialShaderId: string,
    renderState: MaterialSnapshot['renderState'],
    topology: PrimitiveTopology,
    indexFormat: GPUIndexFormat,
    fallbackVariantSet: string | undefined,
    colorFormat: GPUTextureFormat | undefined,
    layoutProjection: VertexLayoutProjection,
    vertexEntry: string | undefined,
    fragmentEntry: string | undefined,
    textureMask: number | undefined,
    layoutKind: DirectSurfaceLayoutKind | undefined,
    reflectionFallbackFormats: readonly GPUTextureFormat[] | undefined,
    viewShadows: boolean | undefined,
    waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
    shaderArtifact: MaterialShaderArtifact | undefined,
    surfaceDiscards: number | undefined,
  ): MaterialShaderPipelineEntry | null {
    return (
      factory?.(
        materialShaderId,
        isHdrTarget,
        renderState,
        topology,
        indexFormat,
        fallbackVariantSet,
        passKind,
        undefined,
        sampleCount,
        colorlessFormat(colorless, colorFormat),
        undefined,
        undefined,
        undefined,
        layoutProjection,
        undefined,
        layoutKind,
        undefined,
        reflectionFallbackFormats,
        vertexEntry,
        prepassFragmentEntry(
          colorless,
          fallbackVariantSet,
          shaderArtifact,
          surfaceDiscards,
          fragmentEntry,
          renderState?.alphaToCoverageEnabled === true,
        ),
        undefined,
        materialAbiRasterConstants(
          textureMask,
          surfaceDiscards,
          effectiveStandardShadowReception(shaderArtifact, viewShadows),
        ),
        waterInfoFormat,
      ) ?? null
    );
  }

  // Select the instrumentation at the pass boundary. Plain requests send
  // their operands directly to the backend without an action or argument array.
  const submit =
    profile === undefined || profilePhase === undefined
      ? submitMaterialPipeline
      : (...args: Parameters<typeof submitMaterialPipeline>) =>
          profile(profilePhase, () => submitMaterialPipeline(...args));

  function issueMaterialPipeline(
    factory: PipelineRequestRuntime['getMaterialShaderPipelineEntry'],
    materialShaderId: string,
    renderState: MaterialSnapshot['renderState'],
    topology: PrimitiveTopology,
    indexFormat: GPUIndexFormat,
    pipelineVariantSet: string | undefined,
    colorFormat: GPUTextureFormat | undefined,
    layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection,
    vertexEntry: string | undefined,
    fragmentEntry: string | undefined,
    textureMask: number | undefined,
    layoutKind: DirectSurfaceLayoutKind | undefined,
    reflectionFallbackFormats: readonly GPUTextureFormat[] | undefined,
    viewShadows: boolean | undefined,
    waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
  ): MaterialShaderPipelineEntry | null {
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
      drawPipelineReported = true;
      runtime.errorRegistry.fire(resolvedVariantSetResult.error);
      return null;
    }
    const resolvedVariantSet = resolvedVariantSetResult.value;
    const fallbackVariantSet = !isCanonicalStandardPbrMaterialShader(materialShaderId)
      ? resolvedVariantSet
      : c.reflectionFallbackColorFormat !== undefined && resolvedVariantSet === ''
        ? ''
        : `${resolvedVariantSet === undefined || resolvedVariantSet === '' ? '' : `${resolvedVariantSet}+`}REFLECTION_FALLBACK_AVAILABLE=${c.reflectionFallbackColorFormat !== undefined}`;
    const shaderArtifact = runtime.getMaterialShaderArtifact?.(
      materialShaderId,
      materialPipelineArtifactRequest(fallbackVariantSet, passKind, layoutProjection, layoutKind),
    );
    const surfaceDiscards = viewSurfaceDiscards(shaderArtifact, c.clipping);
    return submit(
      factory,
      materialShaderId,
      renderState,
      topology,
      indexFormat,
      fallbackVariantSet,
      colorFormat,
      layoutProjection,
      vertexEntry,
      fragmentEntry,
      textureMask,
      layoutKind,
      reflectionFallbackFormats,
      viewShadows,
      waterInfoFormat,
      shaderArtifact,
      surfaceDiscards,
    );
  }
  // The simple receiver is an optimization of the general one; the general
  // row draws every frame correctly. A pending receiver or lighting
  // specialization falls back to that full program for the current draw.
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
    waterInfoFormat?: 'rgba16float' | 'rgba32float',
  ): MaterialShaderPipelineEntry | null => {
    const baseVariantSet = withCoverageVariant(variantSet);
    // Skinned Standard has no visible-surface variant: deformed draws publish no
    // rows, so its uncovered entry fills the identity target with row 0.
    const skinnedVisibleSurface =
      c.visibleSurface &&
      passKind === 'deferred' &&
      isStandardPbrSkinMaterialShader(materialShaderId) &&
      (fragmentEntry === undefined ||
        fragmentEntry === 'fs_gbuffer' ||
        fragmentEntry === 'fs_gbuffer_compact');
    if (skinnedVisibleSurface && fragmentEntry !== 'fs_gbuffer_compact')
      fragmentEntry = SKIN_UNCOVERED_GBUFFER_ENTRY;
    const visibleVariantSet =
      !c.visibleSurface || skinnedVisibleSurface
        ? baseVariantSet
        : `${baseVariantSet ? `${baseVariantSet}+` : ''}VISIBLE_SURFACE_AVAILABLE=true`;
    const generalVariantSet = selectForwardSsrVariant(
      visibleVariantSet,
      c.forwardInlineSsr === true,
      passKind,
      colorFormats.length,
      coverageOnly,
      materialShaderId,
    );
    let pipelineVariantSet = withFrameLightingVariant(
      generalVariantSet,
      frameLightingAxes,
      materialShaderId,
    );
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
    if (
      outputs !== undefined ||
      oit === 'accumulate' ||
      passKind === 'deferred' ||
      (isCanonicalStandardPbrMaterialShader(materialShaderId) &&
        c.reflectionFallbackColorFormat !== undefined)
    ) {
      if (additionalColorFormats === undefined) {
        additionalColorFormats = colorFormats.slice(1);
      }
      reflectionFallbackFormats = additionalColorFormats;
    }
    const renderStateKey = renderStateHash(renderState);
    const viewShadows = c.viewShadows;
    const layoutDigest = layoutProjection.digest;
    const stripIndexFormat = pipelineStripIndexFormat(topology, indexFormat);
    for (;;) {
      const factory =
        pipelinePreparation || passKind === 'forward' || passKind === 'deferred'
          ? (runtime.prepareMaterialShaderPipelineEntry ?? runtime.getMaterialShaderPipelineEntry)
          : runtime.getMaterialShaderPipelineEntry;
      lookupFacts[0] = materialShaderId;
      lookupFacts[1] = renderStateKey;
      lookupFacts[2] = topology;
      lookupFacts[3] = stripIndexFormat;
      lookupFacts[4] = pipelineVariantSet;
      lookupFacts[5] = vertexEntry;
      lookupFacts[6] = fragmentEntry;
      lookupFacts[7] = layoutDigest;
      lookupFacts[8] = colorFormat;
      lookupFacts[9] = viewShadows;
      lookupFacts[10] = reflectionFallbackFormats;
      lookupFacts[11] = textureMask;
      lookupFacts[12] = layoutKind;
      lookupFacts[13] = waterInfoFormat;
      lookupFacts[14] = factory;
      const previous = materialPipelines.get(lookupFacts);
      if (previous !== undefined) return previous;
      // Artifact lookup, profiling and the backend can issue nested requests.
      const issued = materialPipelines.captureFacts(lookupFacts);
      const handle = issueMaterialPipeline(
        factory,
        materialShaderId,
        renderState,
        topology,
        indexFormat,
        pipelineVariantSet,
        colorFormat,
        layoutProjection,
        vertexEntry,
        fragmentEntry,
        textureMask,
        layoutKind,
        reflectionFallbackFormats,
        viewShadows,
        waterInfoFormat,
      );
      // A pending specialization may be ready on the next draw in this same pass.
      if (handle !== null) materialPipelines.set(issued, handle);
      if (handle !== null || pipelineVariantSet === generalVariantSet) return handle;
      // A pending lighting specialization can use the general receiver for this draw.
      drawPipelineReported = true;
      // Each result is installed under the variant the device actually accepted.
      pipelineVariantSet = generalVariantSet;
    }
  };

  /** The actual expanded primitive request shared by preparation and drawing. */
  const resolvePointsLinesPipeline = (
    material: MaterialSnapshot,
    style: PointsLinesStyle | undefined,
    layout: import('@forgeax/engine-geometry').VertexLayoutProjection,
    preparation = false,
  ): MaterialShaderPipelineEntry | null =>
    resolveMaterialPipeline(
      POINTS_LINES_MATERIAL_SHADER_ID,
      geometryRenderStateForTopology('line-list', { ...material.renderState, cullMode: 'none' }),
      'triangle-list',
      'uint32',
      undefined,
      colorFormatOverride,
      layout,
      undefined,
      pointsLinesFragmentEntry(style),
      undefined,
      undefined,
      preparation,
    );

  // True when the current resolution reported or observed per-draw facts; such
  // a selection is resolved again for each draw instead of being reused.
  let drawPipelineReported = false;
  const pipelineSelection: {
    pipeline: RenderPipeline | null;
    material: MaterialShaderPipelineEntry | null;
    probeBlend: boolean;
    viewOffset: number;
    shader: string | undefined;
    variantSet: string | undefined;
    /** The pipeline reads the slot's GPU Scene rows instead of packed instances. */
    sceneDirect: boolean;
    /** The last draw does not take part in this pass (no pipeline requested). */
    skipped: boolean;
  } = {
    pipeline: null,
    material: null,
    probeBlend: false,
    viewOffset: 0,
    shader: undefined,
    variantSet: undefined,
    sceneDirect: false,
    skipped: false,
  };
  /**
   * Default-unlit draws pick the packed-instance program, or the GPU Scene
   * direct program when the slot is resident; null reports a layout failure.
   */
  const resolveUnlitPipeline = (
    indexFormat: GPUIndexFormat,
    layout: VertexLayoutProjection,
    unlitHasColor: boolean,
    smMaterialShaderId: string | undefined,
    smTopology: PrimitiveTopology,
    submeshMaterial: MaterialSnapshot,
    pipelineRenderState: MaterialSnapshot['renderState'],
    vertexEntry: string | undefined,
    fragmentEntry: string | undefined,
    pipelinePreparation: boolean,
    sceneDirect: boolean,
    alphaMask: boolean,
  ): MaterialShaderPipelineEntry | null => {
    const shaderId = smMaterialShaderId ?? 'forgeax::default-unlit';
    const storage = runtime.device.caps.storageBuffer;
    const textureCluster = !storage && clusteredLighting;
    let sceneLayout: DirectSurfaceLayoutKind | undefined;
    // A resident slot can read the Scene rows. Texture-backed clustered
    // devices keep the cluster group(2) in that direct layout.
    if (sceneDirect && vertexEntry === undefined) {
      sceneLayout = textureCluster ? 'scene-direct-cluster-unlit' : 'scene-direct-unlit';
    }
    for (;;) {
      const direct = sceneLayout !== undefined;
      const variantKey =
        Number(unlitHasColor) |
        (Number(storage) << 1) |
        (Number(textureCluster) << 2) |
        (Number(direct) << 3) |
        (Number(alphaMask) << 4);
      const entry = resolveMaterialPipeline(
        shaderId,
        pipelineRenderState,
        smTopology,
        indexFormat,
        UNLIT_DRAW_VARIANTS[variantKey],
        colorFormatOverride,
        layout,
        vertexEntry,
        fragmentEntry,
        submeshMaterial.standardTextureMask,
        sceneLayout,
        pipelinePreparation,
      );
      // Publish the selection only after the backend has returned.
      if (entry !== null || !direct) {
        pipelineSelection.sceneDirect = direct;
        return entry;
      }
      // A pending direct pipeline keeps the packed-instance program for this draw.
      drawPipelineReported = true;
      sceneLayout = undefined;
    }
  };

  const resolveDrawArtifact = (
    vertexColorAvailable: boolean,
    smMaterialShaderId: string | undefined,
    alphaMask: boolean,
    authoredVariantSet: string | undefined,
    isSkinEntry: boolean,
  ): MaterialShaderArtifact | undefined => {
    if (smMaterialShaderId === undefined) return undefined;
    const key =
      Number(vertexColorAvailable) |
      (Number(alphaMask) << 1) |
      (Number(clusteredLighting) << 2) |
      (Number(isSkinEntry) << 3) |
      (Number((c.clipping?.planes.length ?? 0) > 0) << 4);
    const request = DRAW_ARTIFACT_REQUESTS[key] as MaterialShaderArtifactRequest;
    return runtime.getMaterialShaderArtifact?.(
      smMaterialShaderId,
      authoredVariantSet === undefined ? request : { ...request, variantSet: authoredVariantSet },
    );
  };

  const assertDrawForwardFog = (
    shaderArtifact: MaterialShaderArtifact | undefined,
    smMaterialShaderId: string | undefined,
    materialPipelineEntry: MaterialShaderPipelineEntry | null,
    pipelineRenderState: MaterialSnapshot['renderState'],
  ): void => {
    if (
      c.vertexHeightFog === true &&
      !coverageOnly &&
      (surfacePass === undefined || surfacePass === 'color') &&
      pipelineRenderState?.fog !== false
    ) {
      let contract =
        shaderArtifact?.program.forwardFog ??
        shaderArtifact?.receipt?.forwardFog ??
        materialPipelineEntry?.program?.forwardFog;
      if (contract === undefined) {
        const registry = runtime.shaderRegistry;
        const key = smMaterialShaderId ?? 'forgeax::default-unlit';
        const declaration = registry?.materialArtifactDeclaration(key);
        if (declaration?.kind === 'source') {
          contract = declaration.forwardFog ?? declaration.receipt?.forwardFog;
        } else {
          const registered = registry?.findMaterialArtifact(key);
          if (registered?.ok) contract = registered.value.program.forwardFog;
        }
      }
      if (contract !== 'height-vertex/1')
        throw new RendererContractFailureError(
          'draw',
          `material program ${smMaterialShaderId ?? 'forgeax::default-unlit'} must declare forwardFog: height-vertex/1 and apply vertex fog before blending, or author renderState.fog: false`,
        );
    }
  };

  const resolveDrawCoverage = (
    fragmentEntry: string | undefined,
    coveredByPredepth: boolean,
  ): string | undefined | false => {
    pipelineSelection.skipped = fragmentEntry === PREDEPTH_FRAGMENT_ENTRY && !coveredByPredepth;
    return pipelineSelection.skipped ? false : fragmentEntry;
  };

  function drawProbeBlend(
    shaderArtifact: ReturnType<typeof resolveDrawArtifact>,
    smMaterialShaderId: string | undefined,
    submeshMaterial: MaterialSnapshot,
    probeBlendRecordAvailable: boolean,
  ): boolean {
    return (
      !(
        coverageOnly &&
        surfacePass !== 'velocity' &&
        isCanonicalStandardPbrMaterialShader(smMaterialShaderId)
      ) &&
      runtime.device.caps.storageBuffer &&
      ((shaderArtifact !== undefined && requiresProbeBlendRecord(shaderArtifact)) ||
        (probeBlendRecordAvailable &&
          (isStandardPbrMaterialShader(smMaterialShaderId) ||
            submeshMaterial.surfaceModel === 'single-layer-medium' ||
            submeshMaterial.surfaceModel === 'single-layer-water')))
    );
  }

  function selectSpriteShader(
    shader: string | undefined,
    entry: ValidatedRenderable,
    submeshMaterial: MaterialSnapshot,
  ): boolean {
    if (shader !== 'forgeax::sprite' && shader !== 'forgeax::sprite-lit') return false;
    // Sprite draws observe their per-entity nine-slice scale on every draw.
    drawPipelineReported = true;
    const slices = submeshMaterial.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
    if (slices !== undefined)
      detectNineSliceScaleTooSmall(
        recordingDrawPose(entry),
        [slices[0] ?? 0, slices[1] ?? 0, slices[2] ?? 0, slices[3] ?? 0],
        entry.renderableIndex,
        c.warnedNineSliceScaleEntities,
        runtime.metrics,
      );
    return true;
  }

  // Surface pass and output contract belong to this pass; only the base state changes per draw.
  const waterSurface = surfacePass === 'nearest-layer' ? undefined : surfacePass;
  const waterStateKey = waterSurface === undefined ? undefined : `water-${waterSurface}`;
  const waterOutputs =
    waterSurface === undefined ? undefined : SINGLE_LAYER_WATER_PASS_OUTPUTS[waterSurface];
  function waterSurfaceState(state: GeometryRenderState): GeometryRenderState {
    if (waterOutputs === undefined) return state;
    return {
      ...state,
      outputs: waterOutputs,
      ...(waterSurface !== 'forward-color'
        ? {}
        : {
            blend: {
              color: {
                operation: 'add',
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
              },
              alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
            },
          }),
    };
  }

  function depthAndWaterState(
    pipelineRenderState: GeometryRenderState,
    surfaceModel: MaterialSnapshot['surfaceModel'],
  ): GeometryRenderState {
    if (depthPrepass && passKind !== 'temporal')
      pipelineRenderState = derivedRenderState(
        pipelineRenderState,
        'opaque-depth',
        opaqueDepthState,
      );
    if (surfaceModel === 'single-layer-water' && waterStateKey !== undefined)
      pipelineRenderState = derivedRenderState(
        pipelineRenderState,
        waterStateKey,
        waterSurfaceState,
      );
    return pipelineRenderState;
  }

  function transparentPassState(
    pipelineRenderState: GeometryRenderState,
    transparent: boolean | undefined,
    selectedRenderState: MaterialSnapshot['renderState'],
  ): GeometryRenderState {
    if (
      transparentDepthWrite &&
      passKind === 'forward' &&
      (transparent === true || selectedRenderState?.blend !== undefined)
    ) {
      pipelineRenderState = authoredTransparentDepthWrite(transparent, selectedRenderState)
        ? derivedRenderState(
            pipelineRenderState,
            'transparent-depth-write',
            transparentDepthWriteState,
          )
        : derivedRenderState(
            pipelineRenderState,
            'transparent-depth-read',
            transparentDepthReadState,
          );
    }
    return pipelineRenderState;
  }

  function drawTransmissionAvailable(submeshMaterial: MaterialSnapshot): boolean {
    const transmissionAdmission = standardTransmissionAdmission(
      submeshMaterial,
      runtime.device.limits.maxSampledTexturesPerShaderStage,
    );
    if (transmissionAdmission?.kind === 'exceeded') {
      drawPipelineReported = true;
      reportSampledTextureBudgetExceeded(runtime, submeshMaterial, transmissionAdmission.conflicts);
    }
    return transmissionAdmission !== undefined && transmissionAdmission.kind !== 'exceeded';
  }

  function drawWaterVariant(
    materialCapabilityVariantSet: string,
    hasWaterOwner: boolean,
    standardPbrMaterial: boolean,
    waterSystemInputs: boolean,
    waterInfoFormat: GeometryPipelineRequestContext['waterInfoFormat'],
  ): string {
    return hasWaterOwner && (standardPbrMaterial || waterSystemInputs)
      ? `${materialCapabilityVariantSet}+WATER_WAVES_AVAILABLE=true+WATER_INFO_RGBA16=${waterInfoFormat === 'rgba16float'}`
      : materialCapabilityVariantSet;
  }

  function standardWaterMaterial(shader: string, material: MaterialSnapshot): boolean {
    return (
      isStandardPbrMaterialShader(shader) ||
      material.surfaceModel === 'standard' ||
      material.waterDeformation !== undefined
    );
  }

  function drawWaterTargetFormat(
    waterOwner: ValidatedRenderable['source']['waterOwner'],
    standardPbrMaterial: boolean,
    waterSystemInputs: boolean,
  ): GeometryPipelineRequestContext['waterInfoFormat'] {
    return waterSystemInputs || (waterOwner !== undefined && standardPbrMaterial)
      ? (waterOwner?.targetFormat ?? c.waterInfoFormat)
      : undefined;
  }

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
    layout: VertexLayoutProjection,
    reflected: boolean,
    pipelinePreparation = false,
    sceneDirect = false,
    alphaMask = materialAlphaMask(submeshMaterial.paramSnapshot),
  ): boolean => {
    const isSkinEntry = entry.source.skinBinding !== undefined;
    const waterOwner = entry.source.waterOwner;
    const probeBlendRecordAvailable =
      runtime.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    const smMaterialShaderId = drawMaterialShaderId(
      entry,
      selectedPass !== undefined,
      selectedShaderId,
      submeshMaterial,
    );
    const sourceLayout = entry.mesh.layoutProjection;
    const hasVertexColor = vertexLayoutHasColor(sourceLayout);
    const shaderArtifact = resolveDrawArtifact(
      hasVertexColor,
      smMaterialShaderId,
      alphaMask,
      authoredVariantSet,
      isSkinEntry,
    );
    const coveredByPredepth =
      (seededDepth || fragmentEntry === PREDEPTH_FRAGMENT_ENTRY) &&
      predepthCoversMaterial(shaderArtifact, selectedRenderState);
    const coverageEntry = resolveDrawCoverage(fragmentEntry, coveredByPredepth);
    if (coverageEntry === false) return false;
    fragmentEntry = coverageEntry;
    const probeBlendAvailable = drawProbeBlend(
      shaderArtifact,
      smMaterialShaderId,
      submeshMaterial,
      probeBlendRecordAvailable,
    );
    const isSpriteShader = selectSpriteShader(smMaterialShaderId, entry, submeshMaterial);
    // Preserve the dedicated sprite-pass state when the linear-LDR graph
    // routes a sprite through this generic geometry path. Negative scale
    // flips winding, so back-face culling would erase the quad.
    const basePipelineRenderState = isSpriteShader
      ? derivedRenderState(selectedRenderState, 'sprite', spriteState)
      : geometryRenderStateForTopology(smTopology, selectedRenderState);
    let pipelineRenderState = geometryRenderStateForPass(
      reflectedRenderState(basePipelineRenderState, reflected),
      passKind,
      coverageOnly,
      surfacePass,
      fragmentEntry,
      opaqueDepthPrimed,
    );
    pipelineRenderState = depthAndWaterState(pipelineRenderState, submeshMaterial.surfaceModel);
    const unseededRenderState = pipelineRenderState;
    pipelineRenderState = seededGeometryRenderState(
      seededDepth && coveredByPredepth,
      pipelineRenderState,
      smMaterialShaderId,
      alphaMask,
    );
    pipelineRenderState = transparentPassState(
      pipelineRenderState,
      submeshMaterial.transparent,
      selectedRenderState,
    );
    if (isStandardPbrMaterialShader(smMaterialShaderId) && !isSkinEntry)
      pipelineRenderState = clippingCapRenderState(pipelineRenderState, c.clipping);
    // Fog composition follows the authored blend, before OIT replaces it.
    const viewOffset = viewOffsetForBlend(pipelineRenderState?.blend, pipelineRenderState?.fog);
    if (oitAccumulateDraw) pipelineRenderState = oitAccumulateRenderState(pipelineRenderState);
    let smPipelineHandle: typeof pipelineState.unlitPipeline;
    let materialPipelineEntry: MaterialShaderPipelineEntry | null = null;
    let sceneDirectSelected = false;
    let resolvedPipelineVariantSet: string | undefined;
    if (smMaterialShaderId === undefined || smMaterialShaderId === 'forgeax::default-unlit') {
      materialPipelineEntry = resolveUnlitPipeline(
        entry.mesh.indexFormat,
        layout,
        layout === sourceLayout ? hasVertexColor : vertexLayoutHasColor(layout),
        smMaterialShaderId,
        smTopology,
        submeshMaterial,
        pipelineRenderState,
        vertexEntry,
        fragmentEntry,
        pipelinePreparation,
        sceneDirect,
        alphaMask,
      );
      sceneDirectSelected = pipelineSelection.sceneDirect;
      smPipelineHandle =
        materialPipelineEntry?.pipeline ??
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
      // The all-true HDRP variant uses the canonical empty key only when
      // every variant axis is true. A plain mesh adds the geometry-owned
      // VERTEX_COLOR_AVAILABLE=false axis, so retain the two capability
      // axes explicitly or the selector would silently choose the URP
      // group(2) layout for an HDRP cluster bind group.
      const materialCapabilityVariantSet = drawCapabilityVariant(
        clusteredLighting,
        runtime.device.caps.storageBuffer,
        hasVertexColor,
        probeBlendAvailable,
        drawTransmissionAvailable(submeshMaterial),
        isCanonicalStandardPbrMaterialShader(smMaterialShaderId),
        alphaMask,
      );
      const standardPbrMaterial = standardWaterMaterial(smMaterialShaderId, submeshMaterial);
      const waterSystemInputs = shaderArtifact?.receipt?.systemInputs?.water === 'water-frame/3';
      const waterInfoFormat = drawWaterTargetFormat(
        waterOwner,
        standardPbrMaterial,
        waterSystemInputs,
      );
      const waterCapabilityVariantSet = drawWaterVariant(
        materialCapabilityVariantSet,
        waterOwner !== undefined,
        standardPbrMaterial,
        waterSystemInputs,
        waterInfoFormat,
      );
      const variantSet = geometryMaterialVariantSet(
        smMaterialShaderId,
        isSpriteShader,
        clusteredLighting,
        runtime.device.caps.storageBuffer,
        entry.source.spriteInstances !== undefined,
        waterCapabilityVariantSet,
        authoredVariantSet,
      );
      // Draws on the unfogged View slot skip the translucent fog chain.
      const forwardFragmentEntry = selectForwardFragmentEntry({
        passKind,
        fragmentEntry,
        oitAccumulate: oitAccumulateDraw,
        viewOffset,
        atmosphereCapture: c.capturedAtmosphere,
      });
      // A seeded masked draw meets the depth its own prepass alpha test wrote
      // (`equal`, no write), so it selects the program without the alpha
      // discard; that opaque key takes the simple receiver like any opaque draw.
      const drawVariantSet = seededDrawVariantSet(
        seededDepth && coveredByPredepth,
        submeshMaterial.transparent,
        oitAccumulateDraw,
        variantSet,
        unseededRenderState,
        pipelineRenderState,
        forwardFragmentEntry,
      );
      resolvedPipelineVariantSet = drawVariantSet;
      const cachedPipeline = resolveMaterialPipeline(
        smMaterialShaderId,
        pipelineRenderState,
        smTopology,
        entry.mesh.indexFormat,
        drawVariantSet,
        colorFormatOverride,
        layout,
        vertexEntry,
        forwardFragmentEntry,
        submeshMaterial.standardTextureMask,
        directMediumLayoutKind(submeshMaterial.surfaceModel, passKind, clusteredLighting),
        pipelinePreparation,
        waterInfoFormat,
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
    assertDrawForwardFog(
      shaderArtifact,
      smMaterialShaderId,
      materialPipelineEntry,
      pipelineRenderState,
    );
    pipelineSelection.pipeline = smPipelineHandle;
    pipelineSelection.material = materialPipelineEntry;
    pipelineSelection.probeBlend = probeBlendAvailable;
    pipelineSelection.viewOffset = viewOffset;
    pipelineSelection.shader = smMaterialShaderId;
    pipelineSelection.sceneDirect = sceneDirectSelected;
    pipelineSelection.variantSet = resolvedPipelineVariantSet;
    return true;
  };

  // Explicit preparation shares the exact draw resolver for one prepared pass.
  // Draws of one invocation that share every pipeline input share one
  // selection. Only a resolved pipeline without per-draw reports is reused, so
  // a pending build still retries on the next draw.

  return {
    resolveMaterialPipeline,
    resolvePointsLinesPipeline,
    resolveDrawPipeline,
    pipelineSelection,
    viewOffsetForBlend,
    get reported() {
      return drawPipelineReported;
    },
    set reported(value: boolean) {
      drawPipelineReported = value;
    },
  };
}

export type GeometryPipelinePassMatch = (
  pass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>,
  material: MaterialSnapshot,
) => boolean;
export type GeometryPipelinePreparationContext = GeometryPipelineRequestContext & {
  readonly materialFrame?: MaterialFrame;
  readonly pipelinePreparationEntries?: DrawRows;
  readonly frameState: {
    pipelinePreparationPending?: boolean;
    pipelinePreparationPendingReason?: import('../render-contract').FramePresentationPendingReason;
  };
};
/** Preparation calls the same producer as a normal draw without draw setup or GPU plans. */
export function prepareGeometryPipelineRequests(
  c: GeometryPipelinePreparationContext,
  options: GeometryPipelineRequestOptions & { readonly fragmentEntryPoint?: string },
  passMatches: GeometryPipelinePassMatch,
  skipDraw?: (entry: ValidatedRenderable, index: number) => boolean,
  requests = createGeometryPipelineRequests(c, options),
): void {
  const { resolveDrawPipeline, resolvePointsLinesPipeline, pipelineSelection } = requests;
  const { passKind, oit, fragmentEntryPoint } = options;
  const { frameState } = c;
  let rowLayout: VertexLayoutProjection | undefined;
  let reflected = false;
  const preparePass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    topology: PrimitiveTopology,
    material: MaterialSnapshot,
    selectedPass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>,
    authoredVariantSet: string | undefined,
  ): void => {
    let fragmentEntry =
      passKind === 'temporal'
        ? isDepthVelocityEntry(fragmentEntryPoint)
          ? fragmentEntryPoint
          : undefined
        : selectStandardForwardScreenEntry(fragmentEntryPoint, selectedPass.fragmentEntry);
    let accumulate = false;
    if (oit !== undefined) {
      const eligibility = classifyOitDraw({
        materialShaderId: selectedPass.materialShaderId,
        skinned: entry.source.skinBinding !== undefined,
        renderState: selectedPass.renderState,
        fragmentEntry,
      });
      if (eligibility.eligible !== (oit === 'accumulate')) return;
      accumulate = eligibility.eligible;
      if (eligibility.eligible)
        fragmentEntry = eligibility.premultiplied
          ? OIT_PREMULTIPLIED_FRAGMENT_ENTRY
          : OIT_FRAGMENT_ENTRY;
    }
    if (entry.source.pointsLines !== undefined) {
      if (
        resolvePointsLinesPipeline(
          material,
          entry.source.pointsLines.style,
          POINTS_LINES_VERTEX_LAYOUT,
          true,
        ) === null
      )
        markPipelinePreparationPending(frameState, {
          code: 'material-pipeline-preparation',
          entity: entry.source.entityKey,
          pass: passKind,
          shader: POINTS_LINES_MATERIAL_SHADER_ID,
        });
      return;
    }
    if (rowLayout === undefined) {
      rowLayout = drawVertexLayout(entry);
      reflected = recordingDrawReflected(entry);
    }
    const resolved = resolveDrawPipeline(
      entry,
      topology,
      material,
      selectedPass,
      selectedPass.materialShaderId,
      selectedPass.renderState,
      passKind === 'temporal' ? undefined : selectedPass.vertexEntry,
      fragmentEntry,
      accumulate,
      authoredVariantSet,
      rowLayout,
      reflected,
      true,
    );
    if (!resolved && pipelineSelection.skipped) return;
    // A fallback visible pipeline does not qualify an explicitly requested authored PSO.
    if (!resolved || pipelineSelection.material === null)
      markPipelinePreparationPending(frameState, {
        code: 'material-pipeline-preparation',
        entity: entry.source.entityKey,
        pass: passKind,
        ...(selectedPass.materialShaderId === undefined
          ? {}
          : { shader: selectedPass.materialShaderId.slice(0, 256) }),
      });
  };
  const preparePipelines = (passMatches: GeometryPipelinePassMatch): void => {
    for (const entry of c.pipelinePreparationEntries ?? []) {
      rowLayout = undefined;
      const passes = entry.source.pipelinePreparation ?? [];
      const authoredVariantSet = variantSetFromDefines(passes.at(-1)?.defines);
      let nextSubmeshIndex = 0;
      for (const sm of entry.mesh.submeshes) {
        const submeshIndex = nextSubmeshIndex++;
        if (skipDraw?.(entry, submeshIndex)) continue;
        const material = c.materialFrame?.get(
          entry.source.materials[sm.materialSlot] ?? entry.source.material,
        )?.snapshot;
        if (material === undefined)
          throw new Error('Pipeline preparation has no accepted material');
        for (const preparedPass of passes) {
          if (
            preparedPass.materialHandle !== (material.materialHandle ?? 0) ||
            !passMatches(preparedPass, material)
          )
            continue;
          preparePass(entry, sm.topology, material, preparedPass, authoredVariantSet);
        }
      }
    }
  };
  preparePipelines(passMatches);
}
