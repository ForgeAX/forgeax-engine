import type {
  GraphAccess,
  GraphTextureDescriptor,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { GraphAtmosphere } from '../environment/luts';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
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
    sampleCount: 1,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
}

/**
 * CloudLayer's spatial receiver shadow, declared only when the feature has
 * scene raster work and the renderer resolved a shadow resolution.
 */
export function createStandardCloudShadowTarget(
  context: StandardPipelineBuildContext,
  featureRasterWork: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const resolution = context.cloudShadowResolution;
  if (!featureRasterWork || resolution === undefined) return ok(undefined);
  return createRenderPipelineTarget(context.graph, 'cloud-layer-shadow', {
    format: 'rgba16float',
    size: { width: resolution, height: resolution, depthOrArrayLayers: 1 },
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
 * density cache and spatial shadow before opaque receivers. The composite is a
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
  ];
  const contributed = context.contributeFeatures(
    featureTargets,
    [],
    cloudShadow === undefined ? {} : { 'cloud-shadow': cloudShadow },
    [],
    'scene',
    ['cloud-layer-density-cache', 'cloud-layer-shadow'],
  );
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
  atmosphere?: GraphAtmosphere,
): Result<void, RenderPipelineBuildError> {
  const history = context.cloudHistory;
  return context.contributeFeatures(
    featureTargets,
    [],
    {
      'motion-input': targets.input,
      'motion-output': targets.output,
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
    receiverAccesses,
    'scene',
    ['cloud-layer-transport', 'cloud-layer-resolve'],
    atmosphere,
  );
}
