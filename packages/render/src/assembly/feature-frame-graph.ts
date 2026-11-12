import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
} from '../features/host';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
} from '../features/render-graph-contribution';
import type { RenderSystemInternals } from '../record/render-context';

/** Compile frame-scoped Feature work; execution and retirement belong to Render World. */
export function compileSharedFeatureGraph(
  internals: RenderSystemInternals,
  result: RenderFeatureFrameResult,
):
  | import('@forgeax/engine-render-graph').CompiledRenderGraph<{ encoder: RhiCommandEncoder }>
  | undefined {
  const executions = result.plans
    .map(getRenderFeaturePlanExecutionProjection)
    .filter((plan): plan is RenderFeaturePlanExecution => plan !== undefined);
  if (
    executions.every((plan) => plan.passes.length === 0) &&
    !internals.featureSceneInputs?.hasSharedWork
  )
    return;
  const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const sceneInputs = internals.featureSceneInputs?.import(builder);
  const state = createRenderFeatureProjectionState();
  internals.featureSceneInputs?.contribute(builder, state.buffers);
  const projected = projectRenderFeaturePlans(builder, executions, {
    state,
    resolveTarget: (target) =>
      typeof target === 'object'
        ? sceneInputs?.get(target as import('../features/targets').RenderFeatureTargetHandle)
        : undefined,
    reportError: (error) => internals.errorRegistry.fire(error),
  });
  if (!projected.ok) throw projected.error;
  const compiled = builder.compile({
    device: internals.device,
    surfaceSize: {
      width: internals.canvas.width,
      height: internals.canvas.height,
    },
  });
  if (!compiled.ok) throw compiled.error;
  return compiled.value;
}
