import type { RenderPipelineBuildContext, RenderPipelineFrame } from '../render-pipeline';
import type { TargetCoverageAttachment } from '../temporal/target-coverage-attachment';

/** Standard-only graph input; custom pipeline consumers never see coverage. */
export type StandardPipelineBuildContext = RenderPipelineBuildContext<RenderPipelineFrame> & {
  readonly targetCoverage?: TargetCoverageAttachment;
};
