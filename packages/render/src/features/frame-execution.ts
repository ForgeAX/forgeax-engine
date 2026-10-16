import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from './host';

/** The accepted plan for this submission, independent of cached graph topology. */
export interface RenderFeatureExecutionFrame extends RenderGraphFrame {
  readonly featureExecutions?: readonly RenderFeaturePlanExecution[];
}

export function currentRenderFeaturePass(
  frame: RenderGraphFrame,
  featureIdentity: string,
  passName: string,
  scope?: string,
): RenderFeaturePlanExecutionPass | undefined {
  const executions = (frame as RenderFeatureExecutionFrame).featureExecutions;
  if (executions === undefined) return undefined;
  for (const execution of executions) {
    if (
      execution.featureIdentity !== featureIdentity ||
      (scope !== undefined && execution.scope !== scope)
    )
      continue;
    const pass = execution.passes.find((pass) => pass.name === passName);
    if (pass !== undefined) return pass;
  }
  return undefined;
}
