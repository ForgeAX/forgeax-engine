import type { GraphTextureView } from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
} from '../render-pipeline';
import type { TargetCoverageAttachment } from '../temporal/target-coverage-attachment';

/** Standard-only graph input; custom pipeline consumers never see coverage. */
export type StandardPipelineBuildContext = RenderPipelineBuildContext<RenderPipelineFrame> & {
  readonly targetCoverage?: TargetCoverageAttachment;
  /** Presence selects the stock shadow kernels; true admits the current camera's receiver depth. */
  readonly currentShadowReceiverDepth?: boolean;
  readonly currentMaterialDepth?: true;
  readonly currentTransparency?: true;
  readonly currentTransmission?: true;
  /** The surface itself may be the only encoded output when no debug target is declared. */
  readonly directFinalColor?: true;
  readonly currentShadowViews?: import('../typed-shadow-passes').CurrentShadowViews | undefined;
  readonly forwardOutput?: import('./standard-forward-output').StandardForwardOutput;
  /** Internal conformance override; never populated from game-authored pipeline assets. */
  readonly gtaoExecutionOverride?: 'fragment' | 'compute';
};

export type WaterInfoGraphTargets = ReadonlyMap<
  string,
  Readonly<{ view: GraphTextureView; format: TextureFormat }>
>;

export function standardWaterInfoGraphTargets(
  context: StandardPipelineBuildContext,
  viewIdentity: string,
): WaterInfoGraphTargets {
  const dynamic = context.getFeatureGraphTextureBindings?.('water-info-array-', viewIdentity);
  const materialSources = context.getFeatureGraphTextureBindings?.('', viewIdentity, true);
  if (dynamic !== undefined) return new Map([...dynamic, ...(materialSources ?? [])]);
  const targets = new Map<string, Readonly<{ view: GraphTextureView; format: TextureFormat }>>();
  for (const targetName of ['water-info-array-rgba16float', 'water-info-array-rgba32float']) {
    const target = context.getFeatureGraphTextureBinding?.(targetName, viewIdentity);
    if (target !== undefined) targets.set(targetName, target);
  }
  return targets;
}

/** The actual main opaque surface, before any Water depth/color consumer. */
export function contributeStandardAfterDepthFeatures(
  context: StandardPipelineBuildContext,
  color: RenderPipelineTarget,
  depth: RenderPipelineTarget,
) {
  return context.contributeFeatures({
    placement: 'after-depth',
    targets: [
      { ...color, kind: 'scene-color' },
      { ...depth, name: 'opaque-depth', kind: 'scene-depth' },
    ],
  });
}

/** Internal acceptance selection; only GTAO on a compute-capable lane may select this entry. */
export function resolveStandardGtaoExecution(
  algorithm: 'ssao' | 'gtao',
  computeAvailable: boolean,
  override: StandardPipelineBuildContext['gtaoExecutionOverride'],
): Result<'fragment' | 'compute', RenderGraphError> {
  if (override === 'fragment') return ok('fragment');
  if (override === undefined)
    return ok(algorithm === 'gtao' && computeAvailable ? 'compute' : 'fragment');
  if (algorithm !== 'gtao') {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'the compute acceptance override selects only GTAO raw evaluation',
        hint: 'retain the SSAO raster path',
        detail: {
          resourceLabel: 'standard-gtao',
          field: 'algorithm',
          expected: 'gtao',
          actual: algorithm,
        },
      }),
    );
  }
  if (!computeAvailable) {
    return err(
      new RenderGraphError({
        code: 'capability-missing',
        expected: 'the selected lane supports the GTAO compute entry and output usage',
        hint: 'use the admitted fragment path or select a device with compute support',
        detail: { capability: 'compute', passName: 'gtao-calc-compute' },
      }),
    );
  }
  return ok('compute');
}
