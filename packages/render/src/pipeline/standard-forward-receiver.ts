import type { GraphAccess, GraphTextureView } from '@forgeax/engine-render-graph';
import type { RenderPipelineTarget } from '../render-pipeline';
import type { TypedShadowTargets } from '../typed-shadow-passes';

/**
 * The lighting inputs every forward-lit Standard receiver of one lane samples:
 * the opaque/forward pass, transmission, the transparent set and the
 * single-layer medium passes all spread this one value.
 */
export interface StandardForwardReceiverInputs {
  readonly sampled: readonly RenderPipelineTarget[];
  readonly directionalShadow?: RenderPipelineTarget;
  readonly shadowMoments?: RenderPipelineTarget;
  readonly spotShadow: RenderPipelineTarget;
  readonly cloudShadow?: RenderPipelineTarget;
  readonly ssao?: RenderPipelineTarget;
  readonly extraAccesses: readonly GraphAccess[];
}

export function standardForwardReceiverInputs(input: {
  readonly shadows: TypedShadowTargets;
  readonly cloudShadow: RenderPipelineTarget | undefined;
  /** Only the deferred lane produces screen-space AO for forward receivers. */
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly clusterReads: readonly GraphAccess[];
  /** The display's PlanarReflection capture, sampled by mirroring receivers. */
  readonly planarReflection?: GraphTextureView | undefined;
}): StandardForwardReceiverInputs {
  const { directional, spot, point, moments } = input.shadows;
  const { cloudShadow, ssao } = input;
  return {
    sampled: [directional, spot, point, moments, cloudShadow, ssao].filter(
      (target): target is RenderPipelineTarget => target !== undefined,
    ),
    ...(directional === undefined ? {} : { directionalShadow: directional }),
    spotShadow: spot,
    ...(moments === undefined ? {} : { shadowMoments: moments }),
    ...(cloudShadow === undefined ? {} : { cloudShadow }),
    ...(ssao === undefined ? {} : { ssao }),
    extraAccesses:
      input.planarReflection === undefined
        ? input.clusterReads
        : [...input.clusterReads, { resource: input.planarReflection, usage: 'sampled-read' }],
  };
}

/** The same receiver reads, declared for feature-owned lighting passes. */
export function standardForwardReceiverFeatureAccesses(
  receiver: StandardForwardReceiverInputs,
): readonly GraphAccess[] {
  return [
    ...receiver.extraAccesses,
    ...receiver.sampled.map((target) => ({
      resource: target.view,
      usage: 'sampled-read' as const,
    })),
  ];
}
