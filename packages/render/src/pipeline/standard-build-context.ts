import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineBuildContext, RenderPipelineFrame } from '../render-pipeline';
import type { TargetCoverageAttachment } from '../temporal/target-coverage-attachment';

/** Standard-only graph input; custom pipeline consumers never see coverage. */
export type StandardPipelineBuildContext = RenderPipelineBuildContext<RenderPipelineFrame> & {
  readonly targetCoverage?: TargetCoverageAttachment;
  readonly forwardOutput?: import('./standard-forward-output').StandardForwardOutput;
  /** Internal conformance override; never populated from game-authored pipeline assets. */
  readonly gtaoExecutionOverride?: 'fragment' | 'compute';
};

/** Internal acceptance selection; only GTAO on a compute-capable lane may select this entry. */
export function resolveStandardGtaoExecution(
  algorithm: 'ssao' | 'gtao',
  computeAvailable: boolean,
  override: StandardPipelineBuildContext['gtaoExecutionOverride'],
): Result<'fragment' | 'compute', RenderGraphError> {
  if (override !== 'compute') return ok('fragment');
  if (algorithm !== 'gtao') {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'the compute acceptance override selects only GTAO raw evaluation',
        hint: 'retain the SSAO fragment path for the hemisphere algorithm',
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
