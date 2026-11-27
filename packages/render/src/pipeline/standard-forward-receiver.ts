import type { GraphAccess, GraphTextureView } from '@forgeax/engine-render-graph';
import type { RenderPipelineTarget } from '../render-pipeline';
import type { TypedShadowTargets } from '../typed-shadow-passes';

/**
 * The lighting inputs every forward-lit Standard receiver of one lane samples:
 * the opaque/forward pass, transmission, the transparent set and the
 * single-layer medium passes all spread this one value.
 */
export interface StandardForwardReceiverInputs {
  readonly materialSceneDepth?: boolean | undefined;
  readonly sampled: readonly RenderPipelineTarget[];
  readonly directionalShadow?: RenderPipelineTarget;
  readonly spotShadow?: RenderPipelineTarget;
  readonly cloudShadow?: RenderPipelineTarget;
  readonly ssao?: RenderPipelineTarget;
  readonly extraAccesses: readonly GraphAccess[];
}

export function standardForwardReceiverInputs(input: {
  readonly materialSceneDepth?: boolean | undefined;
  readonly shadows: TypedShadowTargets;
  readonly projectedDirectional?: RenderPipelineTarget | undefined;
  readonly cloudShadow: RenderPipelineTarget | undefined;
  /** The native lane shares AO and Forward surface data through this sampled binding. */
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly clusterReads: readonly GraphAccess[];
  /** The display's PlanarReflection capture, sampled by mirroring receivers. */
  readonly planarReflection?: GraphTextureView | undefined;
}): StandardForwardReceiverInputs {
  const { directional, spot, point } =
    input.projectedDirectional === undefined ? input.shadows : {};

  const { cloudShadow } = input;
  const ssao = input.projectedDirectional ?? input.ssao;
  return {
    materialSceneDepth: input.materialSceneDepth,
    sampled: [directional, spot, point, cloudShadow, ssao].filter(
      (target): target is RenderPipelineTarget => target !== undefined,
    ),
    ...(directional === undefined ? {} : { directionalShadow: directional }),
    ...(spot === undefined ? {} : { spotShadow: spot }),
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
