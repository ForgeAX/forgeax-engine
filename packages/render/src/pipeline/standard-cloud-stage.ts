import type {
  GraphAccess,
  GraphTextureDescriptor,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { ANALYTIC_CLOUD_DEPTH, ANALYTIC_CLOUD_LT } from '../cloud/analytic-feature';
import { CLOUD_DEPTH_RANGE_QUARTER, CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { CLOUD_ATMOSPHERE_TARGETS } from '../cloud/lighting/environment';
import {
  CLOUD_SHADOW_FINAL_TARGET,
  cloudShadowSpatialLayout,
} from '../cloud/lighting/shadow-spatial-layout';
import {
  CLOUD_MODE0_PROBE_PASS,
  CLOUD_MODE0_PROBE_TARGETS,
  CLOUD_MODE0_TRACE_TARGETS,
} from '../cloud/reconstruction/feature';
import type { GraphAtmosphere } from '../environment/luts';
import {
  STANDARD_FEATURE_PRE_OPAQUE_PASSES,
  STANDARD_FEATURE_SCENE_COMPOSITE_PASSES,
} from '../features/vocabulary';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildError,
  type RenderPipelineFeatureTarget,
  type RenderPipelineTarget,
  renderPipelineCloudHistoryTargets,
} from '../render-pipeline';
import { addCloudSceneDepthMinMax } from './cloud-scene-depth-minmax';
import type { StandardPipelineBuildContext } from './standard-build-context';

/** A transport-only resolve loads the existing color attachment and never samples it. */
export function standardCloudCompositesInPlace(context: StandardPipelineBuildContext): boolean {
  const hasResolve = (sampledTarget?: string) =>
    context.hasFeatureRasterWork?.(
      CLOUD_LAYER_FEATURE_IDENTITY,
      'scene',
      SkyPass.cloudResolve,
      sampledTarget,
    ) === true;
  return (
    context.cloudHistory?.currentDepth.format === 'rgba16float' &&
    hasResolve() &&
    !hasResolve('motion-input')
  );
}

export interface StandardCloudPhase {
  readonly scene: RenderPipelineTarget | undefined;
  readonly shadow: RenderPipelineTarget | undefined;
  readonly featureTargets: readonly RenderPipelineFeatureTarget[];
}

/** Both recording procedures bind the same Beer-shadow producers and scene ports. */
export function declareStandardCloudPhase(
  context: StandardPipelineBuildContext,
  color: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  descriptor: Pick<GraphTextureDescriptor, 'size' | 'domain'>,
  singleSample: boolean,
): Result<StandardCloudPhase, RenderPipelineBuildError> {
  const active = context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const inPlace = singleSample && standardCloudCompositesInPlace(context);
  const scene = createStandardCloudSceneTarget(context, active && singleSample && !inPlace, {
    format: color.format,
    ...descriptor,
  });
  if (!scene.ok) return scene;
  const shadow = createStandardCloudShadowTarget(context, active);
  if (!shadow.ok) return shadow;
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color,
    depth,
    cloudShadow: shadow.value,
  });
  if (!featureTargets.ok) return featureTargets;
  return ok({
    scene: inPlace ? color : scene.value,
    shadow: shadow.value,
    featureTargets: featureTargets.value,
  });
}

/** Ordered display only invokes the cloud declaration for an admitted producer. */
export function declareOrderedCloudPhase(
  context: StandardPipelineBuildContext,
  color: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  size: GraphTextureDescriptor['size'],
): Result<StandardCloudPhase | undefined, RenderPipelineBuildError> {
  return context.cloudHistory === undefined
    ? ok(undefined)
    : declareStandardCloudPhase(context, color, depth, { size, domain: 'linear-hdr' }, true);
}

/**
 * Single-sample scene target the CloudLayer composite resolves into, declared
 * only when the lane can project the composite this frame.
 */
function createStandardCloudSceneTarget(
  context: StandardPipelineBuildContext,
  enabled: boolean,
  descriptor: Pick<GraphTextureDescriptor, 'format' | 'size' | 'domain'>,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (!enabled) return ok(undefined);
  return createRenderPipelineTarget(context.graph, 'cloud-layer-scene-color', {
    ...descriptor,
    format: context.cloudHistory?.currentRadiance.format ?? descriptor.format,
    sampleCount: 1,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
}

function standardCloudShadowLayout(context: StandardPipelineBuildContext) {
  return (
    context.cloudShadowLayout ??
    (context.cloudShadowResolution === undefined
      ? undefined
      : cloudShadowSpatialLayout(context.cloudShadowResolution))
  );
}

/**
 * CloudLayer's spatial receiver shadow, declared only when the feature has
 * a projected filter writer and the renderer resolved a shadow resolution.
 */
/** Allocate the receiver map when the view has a Beer shadow producer. */
export function createStandardCloudShadowTarget(
  context: StandardPipelineBuildContext,
  featureRasterWork: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const layout = standardCloudShadowLayout(context);
  if (
    !featureRasterWork ||
    layout === undefined ||
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene', SkyPass.cloudShadow) !==
      true
  )
    return ok(undefined);
  return createRenderPipelineTarget(context.graph, 'cloud-layer-shadow', {
    format: context.cloudShadowFormat ?? 'rgba32float',
    size: {
      width: layout.filteredResolution,
      height: layout.filteredResolution,
      depthOrArrayLayers: 1,
    },
    sampleCount: 1,
    domain: 'linear-hdr',
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
}

/**
 * Project the Standard scene feature-target roster and run the CloudLayer
 * spatial Beer shadow before opaque receivers. The composite is a
 * later scene pass that each lane projects after its receiver pass; the
 * returned roster is reused there.
 */
function contributeStandardCloudPreOpaque(
  context: StandardPipelineBuildContext,
  targets: {
    readonly color: RenderPipelineTarget;
    readonly depth: RenderPipelineTarget;
    readonly cloudShadow: RenderPipelineTarget | undefined;
  },
): Result<readonly RenderPipelineFeatureTarget[], RenderPipelineBuildError> {
  const { color, depth, cloudShadow } = targets;
  const shadowTargets: Record<string, RenderPipelineTarget> = {};
  const layout = standardCloudShadowLayout(context);
  if (cloudShadow !== undefined && layout !== undefined) {
    shadowTargets[CLOUD_SHADOW_FINAL_TARGET] = cloudShadow;
    const stages = [
      { output: layout.traceTarget, resolution: layout.rawResolution },
      ...layout.passes,
    ];
    for (const { output, resolution } of stages) {
      if (output === CLOUD_SHADOW_FINAL_TARGET) continue;
      const target = createRenderPipelineTarget(
        context.graph,
        output === layout.traceTarget ? 'cloud-layer-shadow-raw' : output,
        {
          format: cloudShadow.format,
          size: { width: resolution, height: resolution, depthOrArrayLayers: 1 },
          sampleCount: 1,
          domain: 'linear-hdr',
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        },
      );
      if (!target.ok) return target;
      shadowTargets[output] = target.value;
    }
  }
  const featureTargets: readonly RenderPipelineFeatureTarget[] = [
    {
      name: 'linear-hdr',
      kind: 'scene-color',
      texture: color.texture,
      view: color.view,
      format: color.format,
      sampleCount: 1,
    },
    {
      kind: 'scene-depth',
      texture: depth.texture,
      view: depth.view,
      format: depth.format,
      sampleCount: depth.sampleCount,
    },
    ...Object.entries(shadowTargets).map(([name, target]) => ({
      name,
      kind: 'scene-color' as const,
      texture: target.texture,
      view: target.view,
      format: target.format,
      sampleCount: 1 as const,
    })),
    ...(context.cloudHistory === undefined
      ? []
      : renderPipelineCloudHistoryTargets(context.cloudHistory)),
  ];
  const contributed = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: [],
    namedTargets: shadowTargets,
    standardSurfaceAccesses: [],
    placement: 'scene',
    passNames: STANDARD_FEATURE_PRE_OPAQUE_PASSES,
  });
  if (!contributed.ok) return contributed;
  return ok(featureTargets);
}

/**
 * Project the CloudLayer composite after the lane's opaque receiver has
 * populated `input`. One half-resolution transport MRT produces radiance,
 * transmittance and representative depth; the full-resolution resolve consumes
 * that same frame and advances the ping-pong history on submit.
 */
export function contributeStandardCloudComposite(
  context: StandardPipelineBuildContext,
  featureTargets: readonly RenderPipelineFeatureTarget[],
  targets: {
    readonly input: RenderPipelineTarget;
    readonly depth: RenderPipelineTarget;
    readonly depthSize: { readonly width: number; readonly height: number };
    readonly output: RenderPipelineTarget;
    readonly cloudShadow: RenderPipelineTarget | undefined;
  },
  receiverAccesses: readonly GraphAccess[],
  size: GraphTextureDescriptor['size'],
  atmosphere?: GraphAtmosphere,
): Result<void, RenderPipelineBuildError> {
  const history = context.cloudHistory;
  const namedOutputs: Record<string, RenderPipelineTarget> = {};
  if (history !== undefined) {
    const readsDepthRange = [SkyPass.cloudSampledTrace, SkyPass.cloudAnalyticTrace].some(
      (name) =>
        context.hasFeatureRasterWork?.(
          CLOUD_LAYER_FEATURE_IDENTITY,
          'scene',
          name,
          CLOUD_DEPTH_RANGE_QUARTER,
        ) === true,
    );
    if (readsDepthRange) {
      const depthRange = addCloudSceneDepthMinMax(context.graph, targets.depth, targets.depthSize);
      if (!depthRange.ok) return depthRange;
      namedOutputs[CLOUD_DEPTH_RANGE_QUARTER] = depthRange.value.quarter;
    }
    if (
      context.hasFeatureRasterWork?.('forgeax.cloud-layer', 'scene', CLOUD_MODE0_PROBE_PASS) ===
      true
    ) {
      for (const name of CLOUD_MODE0_PROBE_TARGETS) {
        const created = createRenderPipelineTarget(context.graph, name, {
          size: { width: 1, height: 1 },
          format: name.endsWith('depth') ? 'rgba32float' : 'rgba16float',
          domain: 'linear-hdr',
          sampleCount: 1,
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        });
        if (!created.ok) return created;
        namedOutputs[name] = created.value;
      }
    }
    for (const name of CLOUD_MODE0_TRACE_TARGETS) {
      const created = createRenderPipelineTarget(context.graph, name, {
        size: 'quarter-surface',
        format: name.endsWith('depth')
          ? history.currentDepth.format
          : history.currentRadiance.format,
        domain: 'linear-hdr',
        sampleCount: 1,
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      });
      if (!created.ok) return created;
      namedOutputs[name] = created.value;
    }
  }
  if (history === undefined) {
    for (const [name, format] of [
      [ANALYTIC_CLOUD_LT, 'rgba16float'],
      [ANALYTIC_CLOUD_DEPTH, 'rgba32float'],
    ] as const) {
      const created = createRenderPipelineTarget(context.graph, name, {
        size,
        format,
        domain: 'linear-hdr',
        sampleCount: 1,
        usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
      });
      if (!created.ok) return created;
      namedOutputs[name] = created.value;
    }
  }
  return context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: [],
    namedTargets: {
      'motion-input': targets.input,
      'motion-output': targets.output,
      ...(atmosphere?.cloudSources === undefined
        ? {}
        : {
            [CLOUD_ATMOSPHERE_TARGETS.transmittance]: {
              ...atmosphere.cloudSources.transmittance,
              format:
                atmosphere.ue5 === true ? ('rg11b10ufloat' as const) : ('rgba16float' as const),
              sampleCount: 1 as const,
            },
            [CLOUD_ATMOSPHERE_TARGETS.distantSkyLight]: {
              ...atmosphere.cloudSources.distantSkyLight,
              format:
                atmosphere.ue5 === true ? ('rg11b10ufloat' as const) : ('rgba16float' as const),
              sampleCount: 1 as const,
            },
          }),
      ...namedOutputs,
      ...(targets.cloudShadow === undefined ? {} : { 'cloud-shadow': targets.cloudShadow }),
      ...(history === undefined
        ? {}
        : {
            'cloud-history-radiance-current': history.currentRadiance,
            'cloud-history-radiance-previous': history.previousRadiance,
            'cloud-history-transmittance-current': history.currentTransmittance,
            'cloud-history-transmittance-previous': history.previousTransmittance,
            'cloud-history-depth-current': history.currentDepth,
            'cloud-history-depth-previous': history.previousDepth,
          }),
    },
    standardSurfaceAccesses: receiverAccesses,
    placement: 'scene',
    passNames: STANDARD_FEATURE_SCENE_COMPOSITE_PASSES,
    atmosphere: atmosphere,
  });
}
