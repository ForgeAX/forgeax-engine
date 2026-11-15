import type {
  GraphAccess,
  GraphTextureDescriptor,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { ANALYTIC_CLOUD_DEPTH, ANALYTIC_CLOUD_LT } from '../cloud/analytic-feature';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { CLOUD_ATMOSPHERE_TARGETS } from '../cloud/lighting/environment';
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
import type { StandardPipelineBuildContext } from './standard-build-context';

/**
 * Single-sample scene target the CloudLayer composite resolves into, declared
 * only when the lane can project the composite this frame.
 */
export function createStandardCloudSceneTarget(
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

/**
 * CloudLayer's spatial receiver shadow, declared only when the feature has
 * a projected filter writer and the renderer resolved a shadow resolution.
 */
export function createStandardCloudShadowTarget(
  context: StandardPipelineBuildContext,
  featureRasterWork: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const resolution = context.cloudShadowResolution;
  if (
    !featureRasterWork ||
    resolution === undefined ||
    context.hasFeatureRasterWork?.(
      CLOUD_LAYER_FEATURE_IDENTITY,
      'scene',
      SkyPass.cloudShadowFilter,
    ) !== true
  )
    return ok(undefined);
  return createRenderPipelineTarget(context.graph, 'cloud-layer-shadow', {
    format: 'rgba32float',
    size: {
      width: Math.ceil(resolution / 2),
      height: Math.ceil(resolution / 2),
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
export function contributeStandardCloudPreOpaque(
  context: StandardPipelineBuildContext,
  targets: {
    readonly color: RenderPipelineTarget;
    readonly depth: RenderPipelineTarget;
    readonly cloudShadow: RenderPipelineTarget | undefined;
  },
): Result<readonly RenderPipelineFeatureTarget[], RenderPipelineBuildError> {
  const { color, depth, cloudShadow } = targets;
  let cloudShadowRaw: RenderPipelineTarget | undefined;
  if (cloudShadow !== undefined) {
    const resolution = context.cloudShadowResolution ?? 1;
    const raw = createRenderPipelineTarget(context.graph, 'cloud-layer-shadow-raw', {
      format: 'rgba32float',
      size: { width: resolution, height: resolution, depthOrArrayLayers: 1 },
      sampleCount: 1,
      domain: 'linear-hdr',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    });
    if (!raw.ok) return raw;
    cloudShadowRaw = raw.value;
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
    ...(cloudShadow === undefined
      ? []
      : [
          {
            name: 'cloud-shadow',
            kind: 'scene-color' as const,
            texture: cloudShadow.texture,
            view: cloudShadow.view,
            format: cloudShadow.format,
            sampleCount: 1 as const,
          },
        ]),
    ...(context.cloudHistory === undefined
      ? []
      : renderPipelineCloudHistoryTargets(context.cloudHistory)),
    ...(cloudShadowRaw === undefined
      ? []
      : [
          {
            name: 'cloud-shadow-raw',
            kind: 'scene-color' as const,
            texture: cloudShadowRaw.texture,
            view: cloudShadowRaw.view,
            format: cloudShadowRaw.format,
            sampleCount: 1 as const,
          },
        ]),
  ];
  const contributed = context.contributeFeatures({
    targets: featureTargets,
    semanticTargets: [],
    namedTargets:
      cloudShadow === undefined
        ? {}
        : {
            'cloud-shadow': cloudShadow,
            ...(cloudShadowRaw === undefined ? {} : { 'cloud-shadow-raw': cloudShadowRaw }),
          },
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
        format: name.endsWith('depth') ? 'rgba32float' : history.currentRadiance.format,
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
              format: 'rgba16float' as const,
              sampleCount: 1 as const,
            },
            [CLOUD_ATMOSPHERE_TARGETS.distantSkyLight]: {
              ...atmosphere.cloudSources.distantSkyLight,
              format: 'rgba16float' as const,
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
