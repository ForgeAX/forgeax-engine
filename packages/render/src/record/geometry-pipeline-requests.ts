import { deriveVertexLayoutProjectionFromMask } from '@forgeax/engine-geometry';
import { withSupportedLeanInputs } from '@forgeax/engine-shader';
import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from '../assembly/device-feature-admission';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
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
import {
  PREDEPTH_FRAGMENT_ENTRY,
  predepthCoversMaterial,
  predepthFragmentEntry,
} from '../predepth-coverage';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { CapturedSceneTransform } from '../scene/captured-transform';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';
import { detectNineSliceScaleTooSmall } from './main-pass-material';
import { lacksSurfaceDataEntry, selectStandardForwardScreenEntry } from './standard-opaque-entry';

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
  renderStateHash,
  standardStorageVariantSet,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';

import type { DispatchEntry, MaterialSnapshot } from '../render-system-extract';
import { STANDARD_SURFACE_MSAA_NORMAL } from '../temporal/scene-data';
import { geometryRenderStateForTopology, selectGeometryPipeline } from './main-pass-material';
import type {
  _InternalRenderPipelineContext,
  MaterialShaderPipelineEntry,
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
  capabilityVariantSet: string,
): DirectSurfaceLayoutKind | undefined {
  return surfaceModel === 'single-layer-medium' &&
    (passKind === 'forward' || passKind === 'temporal')
    ? capabilityVariantSet.includes('CLUSTER_FORWARD_AVAILABLE=true')
      ? 'surface-direct-cluster-pbr'
      : 'surface-direct-pbr'
    : undefined;
}

type MaterialPipelineLookup = {
  readonly materialShaderId: string;
  readonly isHdrTarget: boolean;
  readonly topology: PrimitiveTopology;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly variantSet: string | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly passKind: PassKind;
  readonly layoutProjection: import('@forgeax/engine-geometry').VertexLayoutProjection;
  readonly sampleCount: number;
  readonly colorFormatOverride: GPUTextureFormat | undefined;
  readonly viewShadows: boolean | undefined;
  readonly additionalColorFormatsKey: string | undefined;
  readonly textureMask: number | undefined;
  readonly layoutKind: DirectSurfaceLayoutKind | undefined;
  readonly waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined;
  readonly handle: MaterialShaderPipelineEntry | null;
};

type MaterialPipelineLookupKey = Omit<MaterialPipelineLookup, 'handle'>;

function findMaterialPipelineLookup(
  lookups: readonly MaterialPipelineLookup[] | undefined,
  key: MaterialPipelineLookupKey,
): MaterialPipelineLookup | undefined {
  return lookups?.find(
    (cached) =>
      cached.isHdrTarget === key.isHdrTarget &&
      cached.topology === key.topology &&
      cached.indexFormat === key.indexFormat &&
      cached.variantSet === key.variantSet &&
      cached.vertexEntry === key.vertexEntry &&
      cached.fragmentEntry === key.fragmentEntry &&
      cached.textureMask === key.textureMask &&
      cached.layoutKind === key.layoutKind &&
      cached.waterInfoFormat === key.waterInfoFormat &&
      cached.passKind === key.passKind &&
      cached.layoutProjection.digest === key.layoutProjection.digest &&
      cached.sampleCount === key.sampleCount &&
      cached.colorFormatOverride === key.colorFormatOverride &&
      cached.viewShadows === key.viewShadows &&
      cached.additionalColorFormatsKey === key.additionalColorFormatsKey,
  );
}

type GeometryRenderState = ReturnType<typeof geometryRenderStateForTopology>;

/**
 * Engine-owned Standard roots declare the compile-time ALPHA_MASK axis;
 * authored programs fix it at cook time and do not declare it.
 */
function withStandardAlphaMaskAxis(
  variantSet: string,
  materialShaderId: Parameters<typeof isCanonicalStandardPbrMaterialShader>[0],
  paramSnapshot: Parameters<typeof materialAlphaMask>[0],
): string {
  return isCanonicalStandardPbrMaterialShader(materialShaderId)
    ? `${variantSet}+ALPHA_MASK=${materialAlphaMask(paramSnapshot)}`
    : variantSet;
}

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
  if (passKind === 'forward' && fragmentEntry === STANDARD_SURFACE_MSAA_NORMAL.fragmentEntryPoint)
    return derivedRenderState(base, 'standard-msaa-normal', msaaNormalState);
  if (passKind !== 'temporal' && surfacePass !== 'velocity') {
    if (!opaqueDepthPrimed) return base;
    const compare = base?.depthCompare ?? 'less';
    if (compare !== 'less' && compare !== 'greater') return base;
    return derivedRenderState(base, 'opaque-depth-primed', (state) => ({
      ...state,
      depthCompare: compare === 'less' ? 'less-equal' : 'greater-equal',
    }));
  }
  if (passKind === 'temporal' && fragmentEntry === 'fs_scene_velocity')
    return derivedRenderState(base, 'temporal-depth-prepass', temporalDepthPrepassState);
  return derivedRenderState(
    base,
    coverageOnly ? 'temporal-coverage' : 'temporal',
    coverageOnly ? temporalCoverageState : temporalState,
  );
}

/**
 * Receiver shape and modifier-free lighting are independent per-frame facts:
 * forward Standard colour draws select each source-level axis. Masked and
 * visible-surface variants keep the general receiver, matching the rows the
 * publication keeps.
 */
function withFrameLightingVariant(
  variantSet: string | undefined,
  frameSimple: boolean | undefined,
  leanLighting: boolean | undefined,
  passKind: PassKind,
  coverageOnly: boolean,
  materialShaderId: string,
): string | undefined {
  if (
    (frameSimple !== true && leanLighting !== true) ||
    passKind === 'deferred' ||
    coverageOnly ||
    materialShaderId !== 'forgeax::default-standard-pbr' ||
    (variantSet ?? '').includes('ALPHA_MASK=true') ||
    (variantSet ?? '').includes('VISIBLE_SURFACE_AVAILABLE=true')
  )
    return variantSet;
  return `${variantSet ? `${variantSet}+` : ''}DIRECTIONAL_SHADOW_SIMPLE=${frameSimple === true}+LEAN_LIGHTING=${leanLighting === true}`;
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
const temporalState = (base: GeometryRenderState) => temporalPassState(base, false);
const temporalCoverageState = (base: GeometryRenderState) => temporalPassState(base, true);
const temporalDepthPrepassState = (base: GeometryRenderState): GeometryRenderState => ({
  ...temporalPassState(base, false),
  depthWriteEnabled: base?.depthWriteEnabled ?? true,
  depthCompare: base?.depthCompare ?? 'less',
});
const msaaNormalState = (base: GeometryRenderState): GeometryRenderState => {
  const state = { ...base };
  delete state.blend;
  return {
    ...state,
    outputs: STANDARD_SURFACE_MSAA_NORMAL.outputs,
    colorWriteMask: 15,
    alphaToCoverageEnabled: false,
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
  };
};
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

/** Built-in Unlit / Standard programs declare the surface-data entry without an artifact. */
function outsideSurfaceDataPass(
  fragmentEntry: string | undefined,
  materialShaderId: string | undefined,
  artifact: MaterialShaderArtifact | undefined,
): boolean {
  const builtIn =
    materialShaderId === undefined ||
    materialShaderId === 'forgeax::default-unlit' ||
    isStandardPbrMaterialShader(materialShaderId);
  return lacksSurfaceDataEntry(fragmentEntry, materialShaderId, artifact?.program, builtIn);
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
  params: Parameters<typeof materialAlphaMask>[0],
): MaterialRenderState | undefined {
  if (!seeded) return state;
  const masked = isCanonicalStandardPbrMaterialShader(shaderId) && materialAlphaMask(params);
  return seededDepthRenderState(state, masked);
}

/** The opaque program a seeded draw selects (maskedInEarlyPassVariantSet); unseeded keeps its own. */
function seededDrawVariantSet(
  draw: {
    readonly seededDepth: boolean;
    readonly transparent: boolean | undefined;
    readonly oitAccumulateDraw: boolean;
  },
  variantSet: string | undefined,
  unseeded: MaterialRenderState | undefined,
  seeded: MaterialRenderState | undefined,
  fragmentEntry: string | undefined,
): string | undefined {
  const seededOpaque = draw.seededDepth && draw.transparent !== true && !draw.oitAccumulateDraw;
  return seededOpaque
    ? maskedInEarlyPassVariantSet(variantSet, unseeded, seeded, fragmentEntry)
    : variantSet;
}

/** One exact request producer for normal recording and explicit candidate demand. */
export function createGeometryPipelineRequests(
  c: GeometryPipelineRequestContext,
  options: GeometryPipelineRequestOptions,
  profile: <T>(action: () => T) => T = (action) => action(),
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
  const standardLighting = c.lightingKind === undefined ? undefined : { kind: c.lightingKind };
  const isHdrTarget = isHdrGeometryTarget(tonemapActive, colorFormatOverride);
  const withCoverageVariant = (variantSet: string | undefined) =>
    variantSetForCoveragePass(variantSet, coverageOnly && surfacePass !== 'velocity');
  const viewOffsetForBlend = (blend: GPUBlendState | undefined, fog?: boolean): number => {
    const composition =
      c.translucentFog === true && fog !== false ? translucentFogComposition(blend) : undefined;
    const dataOnly =
      coverageOnly ||
      surfacePass === 'depth' ||
      surfacePass === 'visibility' ||
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
  const materialPipelineLookupCache = new Map<string, Map<string, MaterialPipelineLookup[]>>();
  // Attachment formats are pass-owned. Reuse their immutable projection and
  // comparison keys across every material lookup in this geometry pass.
  let additionalColorFormats: readonly GPUTextureFormat[] | undefined;
  let additionalColorFormatsKey: string | undefined;
  // The simple receiver is an optimization of the general one; the general
  // row draws every frame correctly. A pending receiver or lighting
  // specialization falls back to that full program for the current draw.
  let frameSimple = c.directionalShadowSimple;
  let frameLean = c.leanLighting;
  let specializationRequested = false;
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
    const generalVariantSet =
      !c.visibleSurface || skinnedVisibleSurface
        ? baseVariantSet
        : `${baseVariantSet ? `${baseVariantSet}+` : ''}VISIBLE_SURFACE_AVAILABLE=true`;
    const pipelineVariantSet = withFrameLightingVariant(
      generalVariantSet,
      frameSimple,
      frameLean,
      passKind,
      coverageOnly,
      materialShaderId,
    );
    specializationRequested = pipelineVariantSet !== generalVariantSet;
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
    if (
      outputs !== undefined ||
      oit === 'accumulate' ||
      passKind === 'deferred' ||
      (isCanonicalStandardPbrMaterialShader(materialShaderId) &&
        c.reflectionFallbackColorFormat !== undefined)
    ) {
      if (additionalColorFormats === undefined) {
        additionalColorFormats = colorFormats.slice(1);
        additionalColorFormatsKey = additionalColorFormats.join(',');
      }
      reflectionFallbackFormats = additionalColorFormats;
      reflectionFallbackFormatsKey = additionalColorFormatsKey;
    }
    const renderStateKey = renderStateHash(renderState);
    const shaderLookupCache = materialPipelineLookupCache.get(materialShaderId);
    const cachedLookups = shaderLookupCache?.get(renderStateKey);
    const lookupKey: MaterialPipelineLookupKey = {
      materialShaderId,
      isHdrTarget,
      topology,
      indexFormat,
      variantSet: pipelineVariantSet,
      vertexEntry,
      fragmentEntry,
      passKind,
      layoutProjection,
      sampleCount,
      colorFormatOverride: colorFormat,
      viewShadows: c.viewShadows,
      additionalColorFormatsKey: reflectionFallbackFormatsKey,
      textureMask,
      layoutKind,
      waterInfoFormat,
    };
    const cached = findMaterialPipelineLookup(cachedLookups, lookupKey);
    if (cached !== undefined) return cached.handle;
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
    const colorless = isColorlessForwardPass(passKind, colorFormats);
    const resolvePipeline = () =>
      // Main color draws own missing-draw readiness; other getter callers retain their policy.
      (pipelinePreparation || passKind === 'forward' || passKind === 'deferred'
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
          effectiveStandardShadowReception(shaderArtifact, c.viewShadows),
        ),
        waterInfoFormat,
      ) ?? null;
    const handle = profile(resolvePipeline);
    // A null handle is a transient async-build signal (`rhi-not-available`),
    // not a stable pipeline result. Do not memoize it in this frame's lookup:
    // caching the first pending lookup would turn a one-frame shader warm-up
    // into a permanent skip for every later frame in a tight smoke loop. The
    // owning runtime cache remains the SSOT; retrying here is bounded by the
    // existing per-frame draw path and preserves the explicit skip-draw
    // recovery while the pipeline becomes ready.
    if (handle !== null) {
      const nextLookup: MaterialPipelineLookup = { ...lookupKey, handle };
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

  /**
   * A frame that turns simple (a light stops casting, a cascade setting drops
   * to one Vogel cascade) must not wait for the simple PSO: while it builds,
   * the draw binds the general receiver, which the boot path prewarms. The
   * fallback is never memoized under the simple key, so the simple row takes
   * over once its build resolves.
   */
  const resolveMaterialPipelineOrGeneral: typeof resolveMaterialPipeline = (...args) => {
    const handle = resolveMaterialPipeline(...args);
    if (handle !== null || !specializationRequested) return handle;
    frameSimple = false;
    frameLean = false;
    try {
      return resolveMaterialPipeline(...args);
    } finally {
      frameSimple = c.directionalShadowSimple;
      frameLean = c.leanLighting;
    }
  };

  /** The actual expanded primitive request shared by preparation and drawing. */
  const resolvePointsLinesPipeline = (
    material: MaterialSnapshot,
    style: PointsLinesStyle | undefined,
    layout: import('@forgeax/engine-geometry').VertexLayoutProjection,
    preparation = false,
  ): MaterialShaderPipelineEntry | null =>
    resolveMaterialPipelineOrGeneral(
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
    entry: import('./frame-snapshot').ValidatedRenderable,
    smMaterialShaderId: string | undefined,
    smTopology: PrimitiveTopology,
    submeshMaterial: MaterialSnapshot,
    pipelineRenderState: MaterialSnapshot['renderState'],
    vertexEntry: string | undefined,
    fragmentEntry: string | undefined,
    pipelinePreparation: boolean,
    sceneDirect: boolean,
  ): {
    readonly entry: MaterialShaderPipelineEntry | null;
    readonly sceneDirect: boolean;
  } | null => {
    const unlitShaderId = smMaterialShaderId ?? 'forgeax::default-unlit';
    const unlitProjectionVariantResult = variantSetFromVertexLayoutProjection(
      drawVertexLayout(entry),
      undefined,
    );
    if (!unlitProjectionVariantResult.ok) {
      drawPipelineReported = true;
      runtime.errorRegistry.fire(unlitProjectionVariantResult.error);
      return null;
    }
    const unlitHasColor = unlitProjectionVariantResult.value === 'VERTEX_COLOR_AVAILABLE=true';
    const resolveUnlit = (variantSet: string, layoutKind?: DirectSurfaceLayoutKind) =>
      resolveMaterialPipelineOrGeneral(
        unlitShaderId,
        pipelineRenderState,
        smTopology,
        entry.mesh.indexFormat,
        `${variantSet}+ALPHA_MASK=${materialAlphaMask(submeshMaterial.paramSnapshot)}`,
        colorFormatOverride,
        drawVertexLayout(entry),
        vertexEntry,
        fragmentEntry,
        submeshMaterial.standardTextureMask,
        layoutKind,
        pipelinePreparation,
      );
    // A slot already resident in the GPU Scene draws from its rows; a pending
    // build keeps the packed-instance pipeline for this draw.
    // Without storage the clustered unlit program keeps the cluster group(2);
    // direct draws then read the texture tables under that layout.
    const textureCluster = !runtime.device.caps.storageBuffer && clusteredLighting;
    if (sceneDirect && vertexEntry === undefined) {
      const direct = resolveUnlit(
        textureCluster
          ? `${standardTopologyVariantSet(standardLighting, false, unlitHasColor)}+GPU_SCENE_DIRECT=true`
          : `STORAGE_BUFFER_AVAILABLE=${runtime.device.caps.storageBuffer}+VERTEX_COLOR_AVAILABLE=${unlitHasColor}+GPU_SCENE_DIRECT=true`,
        textureCluster ? 'scene-direct-cluster-unlit' : 'scene-direct-unlit',
      );
      if (direct !== null) return { entry: direct, sceneDirect: true };
    }
    const unlitVariantSet = textureCluster
      ? standardTopologyVariantSet(standardLighting, false, unlitHasColor)
      : standardStorageVariantSet(runtime.device.caps.storageBuffer, unlitHasColor);
    return { entry: resolveUnlit(unlitVariantSet), sceneDirect: false };
  };

  const resolveDrawArtifact = (
    entry: ValidatedRenderable,
    smMaterialShaderId: string | undefined,
    submeshMaterial: MaterialSnapshot,
    authoredVariantSet: string | undefined,
    isSkinEntry: boolean,
  ): MaterialShaderArtifact | undefined => {
    return smMaterialShaderId === undefined
      ? undefined
      : runtime.getMaterialShaderArtifact?.(smMaterialShaderId, {
          deformation: isSkinEntry ? 'skin' : 'rigid',
          address: 'direct',
          ...(authoredVariantSet === undefined ? {} : { variantSet: authoredVariantSet }),
          surfaceDiscards: standardSurfaceDiscardMask(false, (c.clipping?.planes.length ?? 0) > 0),
          clustered: clusteredLighting,
          alphaMask: materialAlphaMask(submeshMaterial.paramSnapshot),
          vertexColorAvailable: entry.mesh.layoutProjection.attributes.some(
            (attribute) => attribute.key === 'color',
          ),
        });
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
    shaderArtifact: MaterialShaderArtifact | undefined,
    smMaterialShaderId: string | undefined,
  ): string | undefined | false => {
    if (fragmentEntry === PREDEPTH_FRAGMENT_ENTRY) {
      pipelineSelection.skipped = !coveredByPredepth;
      if (!coveredByPredepth || shaderArtifact === undefined) return false;
      fragmentEntry =
        colorFormats.length === 0 ? predepthFragmentEntry(shaderArtifact) : 'fs_ao_input';
    }
    // A program without the surface-data entry is shaded by the main pass only.
    pipelineSelection.skipped = outsideSurfaceDataPass(
      fragmentEntry,
      smMaterialShaderId,
      shaderArtifact,
    );
    if (pipelineSelection.skipped) return false;
    return fragmentEntry;
  };

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
    sceneDirect = false,
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
    const shaderArtifact = resolveDrawArtifact(
      entry,
      smMaterialShaderId,
      submeshMaterial,
      authoredVariantSet,
      isSkinEntry,
    );
    const coveredByPredepth =
      (seededDepth || fragmentEntry === PREDEPTH_FRAGMENT_ENTRY) &&
      predepthCoversMaterial(shaderArtifact, selectedRenderState);
    const coverageEntry = resolveDrawCoverage(
      fragmentEntry,
      coveredByPredepth,
      shaderArtifact,
      smMaterialShaderId,
    );
    if (coverageEntry === false) return false;
    fragmentEntry = coverageEntry;
    const resolveDrawProbeBlend = () => {
      if (
        coverageOnly &&
        surfacePass !== 'velocity' &&
        isCanonicalStandardPbrMaterialShader(smMaterialShaderId)
      )
        return false;
      const cookedProbeBlend =
        shaderArtifact !== undefined && requiresProbeBlendRecord(shaderArtifact);
      const probeBlendAvailable =
        runtime.device.caps.storageBuffer &&
        (cookedProbeBlend ||
          (probeBlendRecordAvailable &&
            (isStandardPbrMaterialShader(smMaterialShaderId) ||
              submeshMaterial.surfaceModel === 'single-layer-medium' ||
              submeshMaterial.surfaceModel === 'single-layer-water')));
      return probeBlendAvailable;
    };
    const probeBlendAvailable = resolveDrawProbeBlend();
    const isSpriteShader =
      smMaterialShaderId === 'forgeax::sprite' || smMaterialShaderId === 'forgeax::sprite-lit';
    const slices = submeshMaterial.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
    // Sprite draws observe their per-entity nine-slice scale on every draw.
    const recordSpriteDrawScaleDiagnostic = () => {
      if (isSpriteShader) drawPipelineReported = true;
      if (isSpriteShader && slices !== undefined)
        detectNineSliceScaleTooSmall(
          entry.source.transform.world,
          [slices[0] ?? 0, slices[1] ?? 0, slices[2] ?? 0, slices[3] ?? 0],
          entry.renderableIndex,
          c.warnedNineSliceScaleEntities,
          runtime.metrics,
        );
    };
    recordSpriteDrawScaleDiagnostic();
    // Preserve the dedicated sprite-pass state when the linear-LDR graph
    // routes a sprite through this generic geometry path. Negative scale
    // flips winding, so back-face culling would erase the quad.
    const basePipelineRenderState = isSpriteShader
      ? derivedRenderState(selectedRenderState, 'sprite', spriteState)
      : geometryRenderStateForTopology(smTopology, selectedRenderState);
    let pipelineRenderState = geometryRenderStateForPass(
      reflectedRenderState(
        basePipelineRenderState,
        CapturedSceneTransform.reflected(entry.source.transform),
      ),
      passKind,
      coverageOnly,
      surfacePass,
      fragmentEntry,
      opaqueDepthPrimed,
    );
    const projectDepthAndWaterRenderState = () => {
      if (depthPrepass && passKind !== 'temporal')
        pipelineRenderState = derivedRenderState(pipelineRenderState, 'opaque-depth', (state) => ({
          ...state,
          colorWriteMask: 0,
        }));
      if (
        submeshMaterial.surfaceModel === 'single-layer-water' &&
        surfacePass !== undefined &&
        surfacePass !== 'nearest-layer'
      ) {
        const outputs = SINGLE_LAYER_WATER_PASS_OUTPUTS[surfacePass];
        pipelineRenderState = derivedRenderState(
          pipelineRenderState,
          `water-${surfacePass}`,
          (state) => ({
            ...state,
            outputs,
            ...(surfacePass !== 'forward-color'
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
          }),
        );
      }
    };
    projectDepthAndWaterRenderState();
    const unseededRenderState = pipelineRenderState;
    pipelineRenderState = seededGeometryRenderState(
      seededDepth && coveredByPredepth,
      pipelineRenderState,
      smMaterialShaderId,
      submeshMaterial.paramSnapshot,
    );
    const projectTransparentDepthState = () => {
      if (
        transparentDepthWrite &&
        passKind === 'forward' &&
        (submeshMaterial.transparent === true || selectedRenderState?.blend !== undefined)
      ) {
        pipelineRenderState = authoredTransparentDepthWrite(
          submeshMaterial.transparent,
          selectedRenderState,
        )
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
    };
    projectTransparentDepthState();
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
      const unlit = resolveUnlitPipeline(
        entry,
        smMaterialShaderId,
        smTopology,
        submeshMaterial,
        pipelineRenderState,
        vertexEntry,
        fragmentEntry,
        pipelinePreparation,
        sceneDirect,
      );
      if (unlit === null) return false;
      materialPipelineEntry = unlit.entry;
      sceneDirectSelected = unlit.sceneDirect;
      smPipelineHandle =
        unlit.entry?.pipeline ??
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
        standardLighting,
        runtime.device.caps.storageBuffer,
        hasVertexColor,
        probeBlendAvailable,
      );
      const admitDrawTransmissionVariants = () => {
        const transmissionAdmission = standardTransmissionAdmission(
          submeshMaterial,
          runtime.device.limits.maxSampledTexturesPerShaderStage,
        );
        if (transmissionAdmission?.kind === 'exceeded') drawPipelineReported = true;
        if (transmissionAdmission?.kind === 'exceeded')
          reportSampledTextureBudgetExceeded(
            runtime,
            submeshMaterial,
            transmissionAdmission.conflicts,
          );
        const transmissionAvailable =
          transmissionAdmission !== undefined && transmissionAdmission.kind !== 'exceeded';
        const transmissionVariantSet =
          transmissionAvailable && !capabilityVariantSet.includes('TRANSMISSION_AVAILABLE=')
            ? `${capabilityVariantSet}+TRANSMISSION_AVAILABLE=true`
            : capabilityVariantSet;
        return transmissionVariantSet;
      };
      const transmissionVariantSet = admitDrawTransmissionVariants();
      const materialCapabilityVariantSet = withStandardAlphaMaskAxis(
        transmissionVariantSet,
        smMaterialShaderId,
        submeshMaterial.paramSnapshot,
      );
      const resolveDrawWaterVariants = () => {
        const standardPbrMaterial =
          isStandardPbrMaterialShader(smMaterialShaderId) ||
          submeshMaterial.surfaceModel === 'standard' ||
          submeshMaterial.waterDeformation !== undefined;
        const waterSystemInputs = shaderArtifact?.receipt?.systemInputs?.water === 'water-frame/3';
        const waterInfoFormat = waterOwner?.targetFormat ?? c.waterInfoFormat;
        const waterCapabilityVariantSet =
          waterOwner !== undefined && (standardPbrMaterial || waterSystemInputs)
            ? `${materialCapabilityVariantSet}+WATER_WAVES_AVAILABLE=true+WATER_INFO_RGBA16=${waterInfoFormat === 'rgba16float'}`
            : materialCapabilityVariantSet;
        return {
          waterCapabilityVariantSet,
          waterSystemInputs,
          waterInfoFormat,
          standardPbrMaterial,
        };
      };
      const { waterCapabilityVariantSet, waterSystemInputs, waterInfoFormat, standardPbrMaterial } =
        resolveDrawWaterVariants();
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
        {
          seededDepth: seededDepth && coveredByPredepth,
          transparent: submeshMaterial.transparent,
          oitAccumulateDraw,
        },
        variantSet,
        unseededRenderState,
        pipelineRenderState,
        forwardFragmentEntry,
      );
      resolvedPipelineVariantSet = drawVariantSet;
      const cachedPipeline = resolveMaterialPipelineOrGeneral(
        smMaterialShaderId,
        pipelineRenderState,
        smTopology,
        entry.mesh.indexFormat,
        drawVariantSet,
        colorFormatOverride,
        drawVertexLayout(entry),
        vertexEntry,
        forwardFragmentEntry,
        submeshMaterial.standardTextureMask,
        directMediumLayoutKind(submeshMaterial.surfaceModel, passKind, capabilityVariantSet),
        pipelinePreparation,
        waterSystemInputs || (waterOwner !== undefined && standardPbrMaterial)
          ? waterInfoFormat
          : undefined,
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
    resolveMaterialPipeline: resolveMaterialPipelineOrGeneral,
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
  const preparePass = (
    entry: import('./frame-snapshot').ValidatedRenderable,
    topology: PrimitiveTopology,
    material: MaterialSnapshot,
    selectedPass: Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>,
    authoredVariantSet: string | undefined,
  ): void => {
    let fragmentEntry =
      passKind === 'temporal'
        ? fragmentEntryPoint === 'fs_scene_velocity'
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
