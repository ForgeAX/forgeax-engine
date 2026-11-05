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
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';

import { detectNineSliceScaleTooSmall } from './main-pass-material';

// Shared exact geometry PSO request producer.

import { type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import { ok, type PassKind, type PrimitiveTopology, type Result } from '@forgeax/engine-types';
import { materialPipelineArtifactRequest } from '../assembly/material/pipeline-helpers';
import {
  MaterialSampledTextureBudgetExceededError,
  type VertexColorVariantConflictError,
} from '../errors/render';

import {
  clippingCapRenderState,
  derivedRenderState,
  transformRenderState,
} from '../material-render-state';
import {
  effectiveStandardSurfaceDiscards,
  materialAbiRasterConstants,
  standardSurfaceDiscardMask,
} from '../material-stage-constants';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import { oitAccumulateRenderState } from '../oit/eligibility';
import {
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

import { geometryRenderStateForTopology, selectGeometryPipeline } from './main-pass-material';

import type {
  _InternalRenderPipelineContext,
  MaterialShaderPipelineEntry,
  RenderSystemInternals,
} from './render-context';

import { selectForwardFragmentEntry } from './standard-opaque-entry';
import { translucentFogComposition, translucentViewOffset } from './view-ubo';

type DirectSurfaceLayoutKind = 'surface-direct-pbr' | 'surface-direct-cluster-pbr';

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
): GeometryRenderState {
  if (passKind !== 'temporal') return base;
  return derivedRenderState(
    base,
    coverageOnly ? 'temporal-coverage' : 'temporal',
    coverageOnly ? temporalCoverageState : temporalState,
  );
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
  | 'errorRegistry'
  | 'metrics'
  | 'getMaterialArtifact'
  | 'getMaterialShaderArtifact'
  | 'getMaterialShaderPipeline'
  | 'getMaterialShaderPipelineEntry'
  | 'prepareMaterialShaderPipeline'
  | 'prepareMaterialShaderPipelineEntry'
>;

export interface GeometryPipelineRequestContext {
  readonly runtime: PipelineRequestRuntime;
  readonly pipelineState: _InternalRenderPipelineContext['pipelineState'];
  readonly lightingKind: 'no-local-lights' | 'clustered' | undefined;
  readonly clipping: _InternalRenderPipelineContext['camera']['clipping'];
  readonly visibleSurface: boolean;
  readonly capturedAtmosphere: boolean;
  readonly reflectionFallbackColorFormat: GPUTextureFormat | undefined;
  readonly translucentFog: boolean;
  readonly splitLdrSprite: boolean;
  readonly transparentColorFormat: GPUTextureFormat | undefined;
  readonly warnedNineSliceScaleEntities: Set<number>;
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
    | 'splitLdrSprite'
    | 'transparentColorFormat'
    | 'frameState'
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
    splitLdrSprite: c.splitLdrSprite,
    transparentColorFormat: c.transparentColorFormat,
    warnedNineSliceScaleEntities: c.frameState.warnedNineSliceScaleEntities,
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
  readonly oit: 'accumulate' | 'residual' | undefined;
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
    oit,
  } = options;
  const colorFormatOverride = c.transparentColorFormat as GPUTextureFormat | undefined;
  const clusteredLighting = c.lightingKind === 'clustered';
  const standardLighting = c.lightingKind === undefined ? undefined : { kind: c.lightingKind };
  const isHdrTarget = isHdrGeometryTarget(tonemapActive, colorFormatOverride);
  const withCoverageVariant = (variantSet: string | undefined) =>
    variantSetForCoveragePass(variantSet, coverageOnly);
  const viewOffsetForBlend = (blend: GPUBlendState | undefined, fog?: boolean): number => {
    const composition =
      c.translucentFog === true && fog !== false ? translucentFogComposition(blend) : undefined;
    return composition === undefined
      ? viewBindGroupDynamicOffset
      : translucentViewOffset(composition);
  };
  const materialPipelineLookupCache = new Map<string, Map<string, MaterialPipelineLookup[]>>();
  // Attachment formats are pass-owned. Reuse their immutable projection and
  // comparison keys across every material lookup in this geometry pass.
  let additionalColorFormats: readonly GPUTextureFormat[] | undefined;
  let additionalColorFormatsKey: string | undefined;
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
      c.visibleSurface &&
      passKind === 'deferred' &&
      isStandardPbrSkinMaterialShader(materialShaderId) &&
      (fragmentEntry === undefined || fragmentEntry === 'fs_gbuffer');
    if (skinnedVisibleSurface) fragmentEntry = SKIN_UNCOVERED_GBUFFER_ENTRY;
    const pipelineVariantSet =
      !c.visibleSurface || skinnedVisibleSurface
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
    if (
      outputs !== undefined ||
      oit === 'accumulate' ||
      passKind === 'deferred' ||
      (materialShaderId === 'forgeax::default-standard-pbr' &&
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
      drawPipelineReported = true;
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
    const shaderArtifact = runtime.getMaterialShaderArtifact?.(
      materialShaderId,
      materialPipelineArtifactRequest(fallbackVariantSet, passKind, layoutProjection, layoutKind),
    );
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
        materialAbiRasterConstants(
          textureMask,
          effectiveStandardSurfaceDiscards(
            shaderArtifact,
            standardSurfaceDiscardMask(false, (c.clipping?.planes.length ?? 0) > 0),
          ),
        ),
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

  // True when the current resolution reported or observed per-draw facts; such
  // a selection is resolved again for each draw instead of being reused.
  let drawPipelineReported = false;
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
    const isSkinEntry = entry.source.skinBinding !== undefined;
    const probeBlendRecordAvailable =
      runtime.device.caps.storageBuffer && entry.source.probeBlendRecord !== undefined;
    const smMaterialShaderId =
      selectedPass !== undefined
        ? selectedShaderId
        : entry.source.skinBinding !== undefined
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
    const slices = submeshMaterial.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
    // Sprite draws observe their per-entity nine-slice scale on every draw.
    if (isSpriteShader) drawPipelineReported = true;
    if (isSpriteShader && slices !== undefined)
      detectNineSliceScaleTooSmall(
        entry.source.transform.world,
        [slices[0] ?? 0, slices[1] ?? 0, slices[2] ?? 0, slices[3] ?? 0],
        entry.renderableIndex,
        c.warnedNineSliceScaleEntities,
        runtime.metrics,
      );
    // Preserve the dedicated sprite-pass state when the linear-LDR graph
    // routes a sprite through this generic geometry path. Negative scale
    // flips winding, so back-face culling would erase the quad.
    const basePipelineRenderState = isSpriteShader
      ? derivedRenderState(selectedRenderState, 'sprite', spriteState)
      : geometryRenderStateForTopology(smTopology, selectedRenderState);
    let pipelineRenderState = geometryRenderStateForPass(
      transformRenderState(basePipelineRenderState, entry.source.transform.world),
      passKind,
      coverageOnly,
    );
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
    if (isStandardPbrMaterialShader(smMaterialShaderId) && !isSkinEntry)
      pipelineRenderState = clippingCapRenderState(pipelineRenderState, c.clipping);
    // Fog composition follows the authored blend, before OIT replaces it.
    const viewOffset = viewOffsetForBlend(pipelineRenderState?.blend, pipelineRenderState?.fog);
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
        drawPipelineReported = true;
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
        standardLighting,
        runtime.device.caps.storageBuffer,
        hasVertexColor,
        probeBlendAvailable,
      );
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
        atmosphereCapture: c.capturedAtmosphere,
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

  // Explicit preparation shares the exact draw resolver for one prepared pass.
  // Draws of one invocation that share every pipeline input share one
  // selection. Only a resolved pipeline without per-draw reports is reused, so
  // a pending build still retries on the next draw.

  return {
    resolveMaterialPipeline,
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
  readonly pipelinePreparationEntries?: readonly ValidatedRenderable[];
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
  const { resolveDrawPipeline, pipelineSelection } = requests;
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
      passKind === 'temporal' ? undefined : (fragmentEntryPoint ?? selectedPass.fragmentEntry);
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
